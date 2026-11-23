import fs from 'node:fs';
import path from 'node:path';
import {
  ENV_VAR_MAP,
  getBilibiliCookieConfig,
  loadEffectiveConfig,
  resolveOutputDir,
  resolvePathFromProject,
  saveConfigUpdates,
} from './config.js';
import {
  encodeRgbCandidateToJpeg,
  extractLanczosFrames,
  probeVideo,
  scanSinglePassVideoStream,
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
  downloadBilibiliDashStream,
  fetchBilibiliSubtitlesAndChapters,
  fetchBilibiliView,
} from './platforms/bilibili.js';
import {
  dumpYtDlpInfo,
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

function maskConfigSecrets(config) {
  const copy = structuredClone(config);
  if (copy.auth?.bilibili_cookie) {
    const len = copy.auth.bilibili_cookie.length;
    copy.auth.bilibili_cookie = `<configured: ${len} chars>`;
  }
  return copy;
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
export async function manageConfig(updates = {}) {
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
 * Environment, Config & Bilibili Authentication Status Check
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
    bilibili: publicBiliAuth,
  };
}

/**
 * Unified One-Shot Video Context Pipeline:
 *  1. Resolve deterministic input & verify Bilibili auth (preventing silent 360p/no-subtitle degradation)
 *  2. Fetch metadata, chapters, deduplicated transcript.md, and native progress-bar sprite sheets (sprites/)
 *  3. Cache 480p/720p pure video stream in output/<bundle_id>/cache/
 *  4. Run Two-Gate + Cap visual sampling:
 *     - 0.4s 160x90 grayscale rawvideo memory probe
 *     - Gate 1: 8x6 localized patch cumulative diff against last emitted frame
 *     - Gate 2: Change-then-Settle motion detector
 *     - Cap: Importance * Temporal-Spacing pruning to max_frames
 *  5. Extract Lanczos 640x360 frames & compose zero-occlusion timestamped 3x3 grids (grids/ + frames_index.json)
 *  6. Return ONLY compact summary stats and absolute file paths (zero inline text bloat).
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
    part,
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

  if (resolved.platform === 'bilibili') {
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

    const [{ chapters, segments }, downloadedVideoPath] = await Promise.all([
      fetchSubsTask,
      fetchVideoTask,
    ]);
    videoPath = downloadedVideoPath;

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
      subtitle_segments: segments.length,
      segments,
    };
  } else {
    bundleId = `youtube_${resolved.videoId}_p1`;
    paths = getBundlePaths(baseOutputDir, bundleId);

    if (!force && isBundleComplete(paths)) {
      return buildPathsOnlyReturnPayload(paths);
    }

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

    const [{ segments }, downloadedVideoPath] = await Promise.all([
      fetchSubsTask,
      fetchVideoTask,
    ]);
    videoPath = downloadedVideoPath;

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
      subtitle_segments: segments.length,
      segments,
    };
  }

  // Step 2: Single-pass multi-threaded FFmpeg stream (Two-Gate + Cap + in-memory JPEG capture)
  let indexPayload;
  let rawCandidatesCount = 0;
  let durationSec = metaInfo.duration_sec || 10;

  try {
    const probe = await probeVideo(videoPath);
    durationSec = probe.durationSec || durationSec;
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
    rawCandidatesCount = rawCandidates.length;
    const samplePoints = finalizeSamplePlan({
      rawCandidates,
      subtitleSegments: metaInfo.segments,
      durationSec,
      minIntervalSec: effectiveMinInterval,
      maxIntervalSec: effectiveMaxInterval,
      maxFrames: effectiveMaxFrames,
    });

    // Release unpicked candidate promises immediately
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

    // Defensive fallback if any edge-case point lacked an in-memory buffer
    const missing = extractedFrames.filter((f) => !f.frameBuffer);
    if (missing.length > 0) {
      const tempFramesDir = path.join(paths.cacheDir, 'tmp_frames');
      try {
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
      } finally {
        await fs.promises.rm(tempFramesDir, { recursive: true, force: true });
      }
    }

    const composed = await composeGrids({
      extractedFrames,
      gridsDir: paths.gridsDir,
      relativeDirPrefix: 'grids',
      sourceStreamHeight: Math.min(probe.width || 0, probe.height || 0) || probe.height,
    });
    indexPayload = composed.indexPayload;
  } finally {
    if (!keepVideoCache && paths?.cacheDir) {
      await fs.promises.rm(paths.cacheDir, { recursive: true, force: true });
    }
  }

  // Clean any legacy artifact directories if re-extracting into an existing folder
  await Promise.all([
    fs.promises.rm(path.join(paths.bundleDir, 'sprites'), { recursive: true, force: true }),
    fs.promises.rm(path.join(paths.bundleDir, 'subtitles'), { recursive: true, force: true }),
    fs.promises.rm(path.join(paths.bundleDir, 'frames_index.json'), { force: true }),
  ]);

  const { segments: _omitSegments, ...manifestBody } = metaInfo;
  const manifest = {
    ...manifestBody,
    duration_sec: roundSec(durationSec, 2),
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

/**
 * Return compact video summary and ONLY core output paths (transcript.md + grid_files).
 */
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
