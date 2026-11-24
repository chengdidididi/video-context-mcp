import fs from 'node:fs';
import path from 'node:path';
import { probeAudioStream } from './asr/audio-chunker.js';
import {
  getAsrStatusSummary,
  requireValidAsrProvider,
  transcribeAudioMedia,
} from './asr/index.js';
import {
  ENV_VAR_MAP,
  getBilibiliCookieConfig,
  loadEffectiveConfig,
  maskConfigSecrets,
  resolveOutputDir,
  resolvePathFromProject,
  saveConfigUpdates,
} from './config.js';
import {
  encodeRgbCandidateToJpeg,
  extractLanczosFrames,
  probeVideo,
  scanSinglePassVideoStream,
  transcodeLocalVideoToCompactCache,
} from './media/ffmpeg.js';
import { composeGrids } from './media/grid-composer.js';
import { createTwoGateTracker, finalizeSamplePlan } from './media/sampler.js';
import { formatTranscriptMarkdown } from './parsers/subtitles.js';
import { resolveVideoInput } from './parsers/url-parser.js';
import {
  checkBilibiliAuth,
  checkSystemBinaries,
  ensureBilibiliAuth,
} from './platforms/auth.js';
import {
  downloadBilibiliDashAudio,
  downloadBilibiliDashStream,
  fetchBilibiliSubtitlesAndChapters,
  fetchBilibiliView,
} from './platforms/bilibili.js';
import {
  dumpYtDlpInfo,
  ensureCachedAudioStream,
  ensureCachedVideoStream,
  extractSubtitlesFromYtDlpInfo,
} from './platforms/ytdlp.js';
import { writeTempNetscapeCookieFile } from './utils/http.js';
import { roundSec } from './utils/time.js';

const inFlightExtractions = new Map();

function getBundlePaths(baseOutputDir, bundleId) {
  const bundleDir = path.join(baseOutputDir, bundleId);
  return {
    bundleDir,
    manifestPath: path.join(bundleDir, 'manifest.json'),
    transcriptPath: path.join(bundleDir, 'transcript.md'),
    gridsDir: path.join(bundleDir, 'grids'),
    cacheDir: path.join(bundleDir, 'cache'),
  };
}

async function withTempBilibiliCookieFile(cacheDir, fn) {
  const { raw } = getBilibiliCookieConfig();
  if (!raw) {
    return fn(null);
  }
  await fs.promises.mkdir(cacheDir, { recursive: true });
  const tempPath = path.join(cacheDir, `.tmp_bili_cookies_${process.pid}_${Date.now()}.txt`);
  try {
    const written = await writeTempNetscapeCookieFile(raw, tempPath, '.bilibili.com');
    return await fn(written);
  } finally {
    await fs.promises.rm(tempPath, { force: true });
  }
}

/**
 * Read or persist unified settings in config.yaml (with 1-to-1 Environment Variable mapping).
 */
export async function manageConfig(updates = {}, extraDotUpdates = {}) {
  const keyMap = {
    output_dir: 'output.dir',
    keep_video_cache: 'output.keep_video_cache',
    timeout_sec: 'runtime.timeout_sec',
    bilibili_cookie: 'auth.bilibili_cookie',
    allow_guest_degraded: 'auth.allow_guest_degraded',
    probe_fps: 'sampling.probe_fps',
    diff_threshold: 'sampling.diff_threshold',
    settle_threshold: 'sampling.settle_threshold',
    min_interval_sec: 'sampling.min_interval_sec',
    max_interval_sec: 'sampling.max_interval_sec',
    max_frames: 'sampling.max_frames',
    grid_cols: 'grid.cols',
    grid_rows: 'grid.rows',
    cell_width: 'grid.cell_width',
    cell_height: 'grid.cell_height',
    header_height: 'grid.header_height',
    gutter: 'grid.gutter',
    jpeg_quality: 'grid.jpeg_quality',
    yt_dlp_path: 'binaries.yt_dlp',
    ffmpeg_path: 'binaries.ffmpeg',
    ffprobe_path: 'binaries.ffprobe',
  };

  const dotUpdates = {};
  for (const [argKey, dotPath] of Object.entries(keyMap)) {
    if (updates[argKey] !== undefined) {
      dotUpdates[dotPath] = updates[argKey];
    }
  }
  for (const [dotPath, val] of Object.entries(extraDotUpdates)) {
    if (val !== undefined) {
      dotUpdates[dotPath] = val;
    }
  }

  if (dotUpdates['output.dir']) {
    const resolvedOut = resolvePathFromProject(String(dotUpdates['output.dir']).trim());
    await fs.promises.mkdir(resolvedOut, { recursive: true });
    await fs.promises.access(resolvedOut, fs.constants.W_OK);
  }

  const state =
    Object.keys(dotUpdates).length > 0
      ? await saveConfigUpdates(dotUpdates)
      : loadEffectiveConfig();

  const envMappingSummary = Object.fromEntries(
    Object.entries(ENV_VAR_MAP).map(([dotPath, spec]) => [dotPath, spec.env])
  );

  return {
    updated_keys: Object.keys(dotUpdates),
    config_file: state.configFilePath,
    config_file_exists: state.configFileExists,
    active_output_dir: resolveOutputDir(),
    active_env_overrides: state.activeEnvOverrides,
    effective_config: maskConfigSecrets(state.config),
    env_var_mapping: envMappingSummary,
  };
}

/**
 * Environment, Config, Redacted ASR Readiness & Bilibili Authentication Status Check
 */
export async function getAuthStatus() {
  const binaries = await checkSystemBinaries();
  const state = loadEffectiveConfig();
  const bilibiliAuth = await checkBilibiliAuth();
  const { cookie_header: _omit, ...publicBiliAuth } = bilibiliAuth;

  return {
    binaries,
    config_file: state.configFilePath,
    active_output_dir: resolveOutputDir(),
    active_env_overrides: state.activeEnvOverrides,
    asr: getAsrStatusSummary(state.config.asr),
    bilibili: publicBiliAuth,
  };
}

/**
 * Unified One-Shot Video Context Pipeline:
 *  1. Resolve deterministic input (Bilibili / YouTube / Local video file)
 *  2. Obtain compact video stream (online download or FFmpeg 360p@<=30fps transcode for local files) + native subtitles
 *  3. ONLY when native subtitles are absent (or input is a local video with an audio track):
 *     strictly validate `asr.provider` in config.yaml, extract/fetch compact audio stream, and run adaptive-chunked cloud ASR
 *  4. Run Two-Gate + Cap visual sampling (leveraging native or ASR subtitle segments for synergy scoring)
 *  5. Compose zero-occlusion timestamped 3x3 grids (grids/) & auto-clean temporary cache/
 *  6. Return ONLY compact summary stats and absolute file paths.
 */
export async function extractVideo(options = {}) {
  const { url_or_id, part, output_dir, force = false } = options;
  const resolved = await resolveVideoInput(url_or_id, part);
  const baseOutputDir = resolveOutputDir(output_dir);
  await fs.promises.mkdir(baseOutputDir, { recursive: true });

  const lockId = `${baseOutputDir}::${resolved.platform}:${resolved.bvid || resolved.aid || resolved.videoId}:p${resolved.part || 1}`;
  if (!force && inFlightExtractions.has(lockId)) {
    console.error(`[video-context] Joining in-flight extraction for ${lockId}...`);
    return inFlightExtractions.get(lockId);
  }

  const runPromise = runExtractVideoInternal(options, resolved, baseOutputDir).finally(() => {
    if (inFlightExtractions.get(lockId) === runPromise) {
      inFlightExtractions.delete(lockId);
    }
  });

  inFlightExtractions.set(lockId, runPromise);
  return runPromise;
}

async function runExtractVideoInternal(
  {
    probe_fps,
    diff_threshold,
    settle_threshold,
    min_interval_sec,
    max_interval_sec,
    max_frames,
    allow_guest_degraded,
    force = false,
  },
  resolved,
  baseOutputDir
) {
  const { config } = loadEffectiveConfig();
  const effectiveProbeFps = probe_fps ?? config.sampling.probe_fps;
  const effectiveDiffThreshold = diff_threshold ?? config.sampling.diff_threshold;
  const effectiveSettleThreshold = settle_threshold ?? config.sampling.settle_threshold;
  const effectiveMinInterval = min_interval_sec ?? config.sampling.min_interval_sec;
  const effectiveMaxInterval = max_interval_sec ?? config.sampling.max_interval_sec;
  const effectiveMaxFrames = max_frames ?? config.sampling.max_frames;
  const keepVideoCache = Boolean(config.output?.keep_video_cache);
  const targetShortSide = Math.min(config.grid.cell_width || 640, config.grid.cell_height || 360);

  let bundleId;
  let paths;
  let metaInfo;
  let videoPath;
  let indexPayload;

  // Pre-flight fast path before creating cache directories
  if (resolved.platform === 'local') {
    bundleId = `local_${resolved.videoId}`;
    paths = getBundlePaths(baseOutputDir, bundleId);
    if (!force && isBundleComplete(paths)) {
      return buildPathsOnlyReturnPayload(paths);
    }
  } else if (resolved.platform === 'youtube') {
    bundleId = `youtube_${resolved.videoId}_p1`;
    paths = getBundlePaths(baseOutputDir, bundleId);
    if (!force && isBundleComplete(paths)) {
      return buildPathsOnlyReturnPayload(paths);
    }
  }

  try {
    if (resolved.platform === 'local') {
      const localProbe = await probeVideo(resolved.localPath);
      if (!localProbe.hasVideo) {
        throw new Error(`Local file does not contain a valid video stream: "${resolved.localPath}"`);
      }

      // Fast-fail config check before spending CPU transcoding if local video has an audio track
      const resolvedProvider = localProbe.hasAudio ? requireValidAsrProvider(config.asr) : null;

      await fs.promises.mkdir(paths.bundleDir, { recursive: true });
      await fs.promises.mkdir(paths.cacheDir, { recursive: true });

      console.error(
        `[video-context] Compressing local video (${localProbe.width}x${localProbe.height}${localProbe.fps ? `@${Math.round(localProbe.fps)}fps` : ''}) to 360p@<=30fps cache stream for ${bundleId}...`
      );
      videoPath = await transcodeLocalVideoToCompactCache(resolved.localPath, paths.cacheDir, {
        targetShortSide: 360,
        maxFps: 30,
      });

      // Step 1b: Audio ASR processing after video stream is prepared (skipped automatically if local file has no audio track)
      let segments = [];
      let subtitleSource = 'none';
      if (localProbe.hasAudio && resolvedProvider) {
        const asrOut = await transcribeAudioMedia({
          audioMediaPath: resolved.localPath,
          cacheDir: paths.cacheDir,
          asrConfig: config.asr,
          resolvedProvider,
        });
        segments = asrOut.segments;
        subtitleSource = `asr:${asrOut.providerName}`;
      } else {
        console.error(`[video-context] Local video has no audio stream; skipping ASR.`);
      }

      const transcriptMd = formatTranscriptMarkdown(segments, {
        title: resolved.fileName,
        author: 'Local Video',
        platform: 'local',
        durationSec: localProbe.durationSec,
        sourceUrl: resolved.canonicalUrl,
      });
      await fs.promises.writeFile(paths.transcriptPath, transcriptMd, 'utf8');

      metaInfo = {
        bundle_id: bundleId,
        platform: 'local',
        video_id: resolved.videoId,
        part: 1,
        multi_part_notice: null,
        source_url: resolved.canonicalUrl,
        title: resolved.fileName,
        author: 'Local Video',
        duration_sec: localProbe.durationSec,
        has_subtitle: segments.length > 0,
        subtitle_source: subtitleSource,
        subtitle_segments: segments.length,
        segments,
      };
    } else if (resolved.platform === 'bilibili') {
      const biliAuth = await ensureBilibiliAuth(allow_guest_degraded);
      const cookieHeader = biliAuth.cookie_header || '';
      const view = await fetchBilibiliView(resolved, cookieHeader, biliAuth.wbi_keys);
      bundleId = `bilibili_${view.bvid}_p${view.part}`;
      paths = getBundlePaths(baseOutputDir, bundleId);

      if (!force && isBundleComplete(paths)) {
        return buildPathsOnlyReturnPayload(paths);
      }

      await fs.promises.mkdir(paths.bundleDir, { recursive: true });
      await fs.promises.mkdir(paths.cacheDir, { recursive: true });

      console.error(`[video-context] Fetching subtitles & compact stream concurrently for ${bundleId}...`);

      const fetchSubsTask = (async () => {
        let { chapters, subtitleTrack, segments } = await fetchBilibiliSubtitlesAndChapters(
          view.bvid,
          view.cid,
          cookieHeader,
          biliAuth.wbi_keys
        );

        if (segments.length === 0) {
          const tempSubDir = path.join(paths.cacheDir, 'tmp_subs');
          try {
            await withTempBilibiliCookieFile(paths.cacheDir, async (tmpCookiePath) => {
              const info = await dumpYtDlpInfo('bilibili', view.canonicalUrl, tmpCookiePath);
              const ytSub = await extractSubtitlesFromYtDlpInfo(
                info,
                'bilibili',
                view.canonicalUrl,
                tmpCookiePath,
                tempSubDir
              );
              if (ytSub.segments.length > 0) {
                subtitleTrack = ytSub.subtitleTrack;
                segments = ytSub.segments;
              }
            });
          } catch {
            // ignore fallback error
          } finally {
            await fs.promises.rm(tempSubDir, { recursive: true, force: true });
          }
        }
        return { chapters, subtitleTrack, segments };
      })();

      const fetchVideoTask = (async () => {
        try {
          return await downloadBilibiliDashStream({
            bvid: view.bvid,
            cid: view.cid,
            destDir: paths.cacheDir,
            cookieHeader,
            wbiKeys: biliAuth.wbi_keys,
            targetShortSide,
          });
        } catch (err) {
          console.error(
            `[video-context] Direct DASH mirror failed (${err.message}); falling back to yt-dlp...`
          );
          return withTempBilibiliCookieFile(paths.cacheDir, (tmpCookiePath) =>
            ensureCachedVideoStream({
              platform: 'bilibili',
              canonicalUrl: view.canonicalUrl,
              cacheDir: paths.cacheDir,
              cookieFilePath: tmpCookiePath,
              targetShortSide,
            })
          );
        }
      })();

      let [{ chapters, subtitleTrack, segments }, downloadedVideoPath] = await Promise.all([
        fetchSubsTask,
        fetchVideoTask,
      ]);
      videoPath = downloadedVideoPath;
      let subtitleSource = subtitleTrack?.source_type || (segments.length > 0 ? 'native' : 'none');

      // Step 1b: ONLY when native/AI subtitles are absent after video stream is downloaded -> run audio ASR
      if (segments.length === 0) {
        let audioPath = null;
        try {
          audioPath = await downloadBilibiliDashAudio({
            bvid: view.bvid,
            cid: view.cid,
            destDir: paths.cacheDir,
            cookieHeader,
            wbiKeys: biliAuth.wbi_keys,
            preferredAudioKbps: 96,
          });
        } catch (err) {
          console.error(
            `[video-context] Direct DASH audio mirror failed (${err.message}); falling back to yt-dlp...`
          );
          audioPath = await withTempBilibiliCookieFile(paths.cacheDir, (tmpCookiePath) =>
            ensureCachedAudioStream({
              platform: 'bilibili',
              canonicalUrl: view.canonicalUrl,
              cacheDir: paths.cacheDir,
              cookieFilePath: tmpCookiePath,
              preferredAudioKbps: 96,
            })
          );
        }

        if (audioPath && (await probeAudioStream(audioPath))) {
          const resolvedProvider = requireValidAsrProvider(config.asr);
          const asrOut = await transcribeAudioMedia({
            audioMediaPath: audioPath,
            cacheDir: paths.cacheDir,
            asrConfig: config.asr,
            resolvedProvider,
          });
          segments = asrOut.segments;
          subtitleSource = `asr:${asrOut.providerName}`;
        }
      }

      const transcriptMd = formatTranscriptMarkdown(segments, {
        title: view.title,
        author: view.author,
        platform: 'bilibili',
        durationSec: view.duration_sec,
        description: view.description,
        chapters,
        sourceUrl: view.canonicalUrl,
      });
      await fs.promises.writeFile(paths.transcriptPath, transcriptMd, 'utf8');

      metaInfo = {
        bundle_id: bundleId,
        platform: 'bilibili',
        video_id: view.bvid,
        part: view.part,
        multi_part_notice:
          view.pages.length > 1 && !resolved.partExplicit
            ? `This video has ${view.pages.length} parts. Defaulted to P1 ("${view.partTitle}"). Pass part=N for other parts.`
            : null,
        source_url: view.canonicalUrl,
        title: view.title,
        author: view.author,
        duration_sec: view.duration_sec,
        has_subtitle: segments.length > 0,
        subtitle_source: subtitleSource,
        subtitle_segments: segments.length,
        segments,
      };
    } else {
      await fs.promises.mkdir(paths.bundleDir, { recursive: true });
      await fs.promises.mkdir(paths.cacheDir, { recursive: true });

      console.error(`[video-context] Resolving YouTube metadata for ${bundleId}...`);
      const info = await dumpYtDlpInfo('youtube', resolved.canonicalUrl, null);

      console.error(`[video-context] Fetching subtitles & compact stream concurrently for ${bundleId}...`);
      const tempSubDir = path.join(paths.cacheDir, 'tmp_subs');
      const fetchSubsTask = extractSubtitlesFromYtDlpInfo(
        info,
        'youtube',
        resolved.canonicalUrl,
        null,
        tempSubDir
      ).finally(() => fs.promises.rm(tempSubDir, { recursive: true, force: true }));

      const fetchVideoTask = ensureCachedVideoStream({
        platform: 'youtube',
        canonicalUrl: resolved.canonicalUrl,
        cacheDir: paths.cacheDir,
        cookieFilePath: null,
        info,
        targetShortSide,
      });

      let [{ subtitleTrack, segments }, downloadedVideoPath] = await Promise.all([
        fetchSubsTask,
        fetchVideoTask,
      ]);
      videoPath = downloadedVideoPath;
      let subtitleSource = subtitleTrack?.source_type || (segments.length > 0 ? 'native' : 'none');

      // Step 1b: ONLY when YouTube subtitles are absent after video stream is downloaded -> run audio ASR
      if (segments.length === 0) {
        const hasAudioInFormats =
          !Array.isArray(info.formats) ||
          info.formats.some((f) => f && f.acodec && f.acodec !== 'none');

        if (hasAudioInFormats) {
          const resolvedProvider = requireValidAsrProvider(config.asr);
          const audioPath = await ensureCachedAudioStream({
            platform: 'youtube',
            canonicalUrl: resolved.canonicalUrl,
            cacheDir: paths.cacheDir,
            cookieFilePath: null,
            info,
            preferredAudioKbps: 96,
          });
          if (audioPath && (await probeAudioStream(audioPath))) {
            const asrOut = await transcribeAudioMedia({
              audioMediaPath: audioPath,
              cacheDir: paths.cacheDir,
              asrConfig: config.asr,
              resolvedProvider,
            });
            segments = asrOut.segments;
            subtitleSource = `asr:${asrOut.providerName}`;
          }
        }
      }

      const chapters = Array.isArray(info.chapters)
        ? info.chapters.map((ch) => ({
            title: ch.title || '',
            start_sec: roundSec(Number(ch.start_time || 0), 2),
            end_sec: roundSec(Number(ch.end_time || 0), 2),
          }))
        : [];

      const title = info.title || resolved.videoId;
      const author = info.uploader || info.channel || 'Unknown';
      const durationSec = Number(info.duration || 0);

      const transcriptMd = formatTranscriptMarkdown(segments, {
        title,
        author,
        platform: 'youtube',
        durationSec,
        description: info.description || '',
        chapters,
        sourceUrl: resolved.canonicalUrl,
      });
      await fs.promises.writeFile(paths.transcriptPath, transcriptMd, 'utf8');

      metaInfo = {
        bundle_id: bundleId,
        platform: 'youtube',
        video_id: resolved.videoId,
        part: 1,
        multi_part_notice: null,
        source_url: resolved.canonicalUrl,
        title,
        author,
        duration_sec: durationSec,
        has_subtitle: segments.length > 0,
        subtitle_source: subtitleSource,
        subtitle_segments: segments.length,
        segments,
      };
    }

    // Step 2: Single-pass multi-threaded FFmpeg stream (Two-Gate + Cap + in-memory JPEG capture)
    const probe = await probeVideo(videoPath);
    const durationSec = probe.durationSec || metaInfo.duration_sec || 10;
    metaInfo.duration_sec = durationSec;
    const cellW = config.grid.cell_width || 640;
    const cellH = config.grid.cell_height || 360;

    console.error(
      `[video-context] Stream ready (${probe.width}x${probe.height}, ${Math.round(durationSec)}s). Running single-pass Two-Gate scan (${effectiveProbeFps} fps)...`
    );

    const tracker = createTwoGateTracker({
      width: 160,
      height: 90,
      tileCols: 8,
      tileRows: 6,
      diffThreshold: effectiveDiffThreshold,
      settleThreshold: effectiveSettleThreshold,
      minIntervalSec: effectiveMinInterval,
      maxIntervalSec: effectiveMaxInterval,
      onEmit: (rgbBuf) => encodeRgbCandidateToJpeg(rgbBuf, cellW, cellH, 88),
    });

    await scanSinglePassVideoStream(videoPath, tracker, {
      probeFps: effectiveProbeFps,
      cellWidth: cellW,
      cellHeight: cellH,
    });

    const rawCandidates = tracker.flush();
    const rawCandidatesCount = rawCandidates.length;
    const samplePoints = finalizeSamplePlan({
      rawCandidates,
      subtitleSegments: metaInfo.segments,
      durationSec,
      minIntervalSec: effectiveMinInterval,
      maxIntervalSec: effectiveMaxInterval,
      maxFrames: effectiveMaxFrames,
    });

    const chosenSet = new Set(samplePoints.map((p) => p.payload));
    for (const c of rawCandidates) {
      if (c.payload && !chosenSet.has(c.payload)) {
        Promise.resolve(c.payload).catch(() => {});
      }
    }

    const perGrid = config.grid.cols * config.grid.rows;
    console.error(
      `[video-context] Selected ${samplePoints.length} settled frames (from ${rawCandidatesCount} raw visual changes) -> composing ${Math.ceil(samplePoints.length / perGrid)} ${config.grid.rows}x${config.grid.cols} grids...`
    );

    await fs.promises.rm(paths.gridsDir, { recursive: true, force: true });

    let extractedFrames = await Promise.all(
      samplePoints.map(async (pt) => ({
        frameNo: pt.frameNo,
        timestampSec: pt.timestampSec,
        trigger: pt.trigger,
        frameBuffer: pt.payload ? await pt.payload : null,
      }))
    );

    const missing = extractedFrames.filter((f) => !f.frameBuffer);
    const tempFramesDir = path.join(paths.cacheDir, 'tmp_frames');
    try {
      if (missing.length > 0) {
        const recovered = await extractLanczosFrames({
          videoPath,
          samplePoints: missing,
          tempFramesDir,
          cellWidth: cellW,
          cellHeight: cellH,
        });
        const recMap = new Map(recovered.map((r) => [r.frameNo, r.framePath]));
        extractedFrames = extractedFrames.map((f) =>
          f.frameBuffer ? f : { ...f, framePath: recMap.get(f.frameNo) }
        );
      }

      const composed = await composeGrids({
        extractedFrames,
        gridsDir: paths.gridsDir,
        relativeDirPrefix: 'grids',
        sourceStreamHeight: Math.min(probe.width || 0, probe.height || 0) || probe.height,
      });
      indexPayload = composed.indexPayload;
    } finally {
      if (missing.length > 0) {
        await fs.promises.rm(tempFramesDir, { recursive: true, force: true });
      }
    }
  } finally {
    if (!keepVideoCache && paths?.cacheDir) {
      await fs.promises.rm(paths.cacheDir, { recursive: true, force: true });
    }
  }

  await Promise.all([
    fs.promises.rm(path.join(paths.bundleDir, 'sprites'), { recursive: true, force: true }),
    fs.promises.rm(path.join(paths.bundleDir, 'subtitles'), { recursive: true, force: true }),
    fs.promises.rm(path.join(paths.bundleDir, 'frames_index.json'), { force: true }),
  ]);

  const { segments: _omitSegments, ...manifestBody } = metaInfo;
  const manifest = {
    ...manifestBody,
    duration_sec: roundSec(metaInfo.duration_sec, 2),
    total_frames: indexPayload.total_frames,
    total_grids: indexPayload.total_grids,
    grid_files: (indexPayload.grids || []).map((g) => g.file),
    completed: true,
  };

  await fs.promises.writeFile(paths.manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return buildPathsOnlyReturnPayload(paths);
}

function isBundleComplete(paths) {
  if (!fs.existsSync(paths.manifestPath) || !fs.existsSync(paths.transcriptPath)) {
    return false;
  }
  try {
    const m = JSON.parse(fs.readFileSync(paths.manifestPath, 'utf8'));
    return Boolean(m?.completed && Array.isArray(m?.grid_files));
  } catch {
    return false;
  }
}

async function buildPathsOnlyReturnPayload(paths) {
  const manifest = JSON.parse(await fs.promises.readFile(paths.manifestPath, 'utf8'));
  const gridFiles = (manifest.grid_files || []).map((rel) => path.join(paths.bundleDir, rel));

  return {
    bundle_id: manifest.bundle_id,
    platform: manifest.platform,
    video_id: manifest.video_id,
    part: manifest.part,
    multi_part_notice: manifest.multi_part_notice || undefined,
    title: manifest.title,
    author: manifest.author,
    duration_sec: manifest.duration_sec,
    has_subtitle: Boolean(manifest.has_subtitle),
    subtitle_segments: manifest.subtitle_segments || 0,
    total_frames: manifest.total_frames,
    total_grids: manifest.total_grids,
    paths: {
      bundle_dir: paths.bundleDir,
      transcript: paths.transcriptPath,
      grid_files: gridFiles,
    },
  };
}
