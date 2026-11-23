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
  extractLanczosFrames,
  probeVideo,
  scanGrayscaleProbeStream,
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
  fetchBilibiliVideoshot,
  fetchBilibiliView,
} from './platforms/bilibili.js';
import {
  dumpYtDlpInfo,
  ensureCachedVideoStream,
  extractSubtitlesFromYtDlpInfo,
  extractYoutubeStoryboards,
} from './platforms/ytdlp.js';
import { writeTempNetscapeCookieFile } from './utils/http.js';
import { roundSec } from './utils/time.js';

function getBundlePaths(baseOutputDir, bundleId) {
  const bundleDir = path.join(baseOutputDir, bundleId);
  return {
    bundleDir,
    manifestPath: path.join(bundleDir, 'manifest.json'),
    transcriptPath: path.join(bundleDir, 'transcript.md'),
    framesIndexPath: path.join(bundleDir, 'frames_index.json'),
    subtitlesDir: path.join(bundleDir, 'subtitles'),
    subtitlesJsonPath: path.join(bundleDir, 'subtitles', 'subtitles.json'),
    spritesDir: path.join(bundleDir, 'sprites'),
    spritesIndexPath: path.join(bundleDir, 'sprites', 'sprites_index.json'),
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
export async function extractVideo({
  url_or_id,
  part,
  output_dir,
  probe_fps,
  diff_threshold,
  settle_threshold,
  min_interval_sec,
  max_interval_sec,
  max_frames,
  allow_guest_degraded,
  force = false,
}) {
  const { config } = loadEffectiveConfig();
  const effectiveProbeFps = probe_fps ?? config.sampling.probe_fps;
  const effectiveDiffThreshold = diff_threshold ?? config.sampling.diff_threshold;
  const effectiveSettleThreshold = settle_threshold ?? config.sampling.settle_threshold;
  const effectiveMinInterval = min_interval_sec ?? config.sampling.min_interval_sec;
  const effectiveMaxInterval = max_interval_sec ?? config.sampling.max_interval_sec;
  const effectiveMaxFrames = max_frames ?? config.sampling.max_frames;

  const resolved = await resolveVideoInput(url_or_id, part);
  const baseOutputDir = resolveOutputDir(output_dir);
  await fs.promises.mkdir(baseOutputDir, { recursive: true });

  let bundleId;
  let paths;
  let metaInfo;
  let bvid = null;
  let cid = null;
  let biliAuth = null;

  if (resolved.platform === 'bilibili') {
    biliAuth = await ensureBilibiliAuth(allow_guest_degraded);
    const cookieHeader = biliAuth.cookie_header || '';
    const view = await fetchBilibiliView(resolved, cookieHeader, biliAuth.wbi_keys);
    bvid = view.bvid;
    cid = view.cid;
    bundleId = `bilibili_${view.bvid}_p${view.part}`;
    paths = getBundlePaths(baseOutputDir, bundleId);

    if (!force && isBundleComplete(paths)) {
      return buildPathsOnlyReturnPayload(paths);
    }

    await fs.promises.mkdir(paths.subtitlesDir, { recursive: true });
    await fs.promises.mkdir(paths.cacheDir, { recursive: true });

    console.error(`[video-context] Fetching metadata, subtitles & sprites for ${bundleId}...`);
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

    const spritesRes = await fetchBilibiliVideoshot(
      view.bvid,
      view.cid,
      paths.spritesDir,
      cookieHeader
    );

    const transcriptMd = formatTranscriptMarkdown(segments, {
      title: view.title,
      author: view.author,
      platform: 'bilibili',
      sourceUrl: view.canonicalUrl,
    });
    await fs.promises.writeFile(paths.transcriptPath, transcriptMd, 'utf8');
    await fs.promises.writeFile(paths.subtitlesJsonPath, JSON.stringify(segments, null, 2), 'utf8');

    metaInfo = {
      bundle_id: bundleId,
      output_root: baseOutputDir,
      platform: 'bilibili',
      video_id: view.bvid,
      aid: view.aid,
      cid: view.cid,
      part: view.part,
      part_explicit: resolved.partExplicit,
      multi_part_notice:
        view.pages.length > 1 && !resolved.partExplicit
          ? `This video has ${view.pages.length} parts. Defaulted to P1 ("${view.partTitle}"). Pass part=N for other parts.`
          : null,
      source_url: view.canonicalUrl,
      title: view.title,
      author: view.author,
      duration_sec: view.duration_sec,
      description: view.description,
      chapters,
      parts: view.pages,
      auth_degraded: !biliAuth.authenticated,
      subtitle_meta: {
        has_subtitle: segments.length > 0,
        source_type: subtitleTrack?.source_type || null,
        language: subtitleTrack?.language || null,
        segment_count: segments.length,
        transcript_file: 'transcript.md',
        subtitles_json_file: 'subtitles/subtitles.json',
      },
      sprites_meta: {
        available: spritesRes.available,
        sheet_count: spritesRes.files.length,
        index_file: spritesRes.available ? 'sprites/sprites_index.json' : null,
      },
      segments,
    };
  } else {
    bundleId = `youtube_${resolved.videoId}_p1`;
    paths = getBundlePaths(baseOutputDir, bundleId);

    if (!force && isBundleComplete(paths)) {
      return buildPathsOnlyReturnPayload(paths);
    }

    await fs.promises.mkdir(paths.subtitlesDir, { recursive: true });
    await fs.promises.mkdir(paths.cacheDir, { recursive: true });

    console.error(`[video-context] Fetching metadata, subtitles & storyboards for ${bundleId}...`);
    const info = await dumpYtDlpInfo('youtube', resolved.canonicalUrl, null);

    const tempSubDir = path.join(paths.cacheDir, 'tmp_subs');
    let subtitleTrack = null;
    let segments = [];
    try {
      const subRes = await extractSubtitlesFromYtDlpInfo(
        info,
        'youtube',
        resolved.canonicalUrl,
        null,
        tempSubDir
      );
      subtitleTrack = subRes.subtitleTrack;
      segments = subRes.segments;
    } finally {
      await fs.promises.rm(tempSubDir, { recursive: true, force: true });
    }

    const spritesRes = await extractYoutubeStoryboards(info, paths.spritesDir);

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
      sourceUrl: resolved.canonicalUrl,
    });
    await fs.promises.writeFile(paths.transcriptPath, transcriptMd, 'utf8');
    await fs.promises.writeFile(paths.subtitlesJsonPath, JSON.stringify(segments, null, 2), 'utf8');

    metaInfo = {
      bundle_id: bundleId,
      output_root: baseOutputDir,
      platform: 'youtube',
      video_id: resolved.videoId,
      part: 1,
      source_url: resolved.canonicalUrl,
      title,
      author,
      duration_sec: durationSec,
      description: info.description || '',
      chapters,
      parts: [{ part: 1, title, duration_sec: durationSec }],
      subtitle_meta: {
        has_subtitle: segments.length > 0,
        source_type: subtitleTrack?.source_type || null,
        language: subtitleTrack?.language || null,
        segment_count: segments.length,
        transcript_file: 'transcript.md',
        subtitles_json_file: 'subtitles/subtitles.json',
      },
      sprites_meta: {
        available: spritesRes.available,
        sheet_count: spritesRes.files.length,
        index_file: spritesRes.available ? 'sprites/sprites_index.json' : null,
      },
      segments,
    };
  }

  // Step 2: Cache pure video stream (480p -> 720p upward fallback)
  console.error(`[video-context] Caching video stream for ${bundleId}...`);
  let videoPath;
  if (resolved.platform === 'bilibili' && bvid && cid) {
    const cookieHeader = biliAuth?.cookie_header || '';
    try {
      videoPath = await downloadBilibiliDashStream({
        bvid,
        cid,
        destDir: paths.cacheDir,
        cookieHeader,
        wbiKeys: biliAuth?.wbi_keys,
      });
    } catch (err) {
      console.error(
        `[video-context] Direct DASH mirror failed (${err.message}); falling back to yt-dlp...`
      );
      videoPath = await withTempBilibiliCookieFile(paths.cacheDir, (tmpCookiePath) =>
        ensureCachedVideoStream({
          platform: 'bilibili',
          canonicalUrl: metaInfo.source_url,
          cacheDir: paths.cacheDir,
          cookieFilePath: tmpCookiePath,
        })
      );
    }
  } else {
    videoPath = await ensureCachedVideoStream({
      platform: resolved.platform,
      canonicalUrl: metaInfo.source_url,
      cacheDir: paths.cacheDir,
      cookieFilePath: null,
    });
  }

  // Step 3: Two-Gate + Cap grayscale probe stream analysis
  const probe = await probeVideo(videoPath);
  const durationSec = probe.durationSec || metaInfo.duration_sec || 10;
  console.error(
    `[video-context] Stream ready (${probe.width}x${probe.height}, ${Math.round(durationSec)}s). Scanning Two-Gate grayscale probe (${effectiveProbeFps} fps)...`
  );

  const tracker = createTwoGateTracker({
    width: 160,
    height: 90,
    tileCols: 8,
    tileRows: 6,
    diffThreshold: effectiveDiffThreshold,
    settleThreshold: effectiveSettleThreshold,
    minIntervalSec: effectiveMinInterval,
  });

  await scanGrayscaleProbeStream(
    videoPath,
    (frameSlice, frameIdx, ts) => tracker.pushFrame(frameSlice, frameIdx, ts),
    { probeFps: effectiveProbeFps, width: 160, height: 90 }
  );

  const rawCandidates = tracker.flush();
  const samplePoints = finalizeSamplePlan({
    rawCandidates,
    subtitleSegments: metaInfo.segments,
    durationSec,
    minIntervalSec: effectiveMinInterval,
    maxIntervalSec: effectiveMaxInterval,
    maxFrames: effectiveMaxFrames,
  });

  const perGrid = config.grid.cols * config.grid.rows;
  console.error(
    `[video-context] Selected ${samplePoints.length} settled frames (from ${rawCandidates.length} raw visual changes) -> composing ${Math.ceil(samplePoints.length / perGrid)} ${config.grid.rows}x${config.grid.cols} grids...`
  );

  // Step 4: Extract Lanczos high-res frames & compose zero-occlusion timestamped grids
  const tempFramesDir = path.join(paths.cacheDir, 'tmp_frames');
  await fs.promises.rm(tempFramesDir, { recursive: true, force: true });
  await fs.promises.rm(paths.gridsDir, { recursive: true, force: true });

  let indexPayload;
  try {
    const extractedFrames = await extractLanczosFrames({
      videoPath,
      samplePoints,
      tempFramesDir,
    });

    const composed = await composeGrids({
      extractedFrames,
      gridsDir: paths.gridsDir,
      relativeDirPrefix: 'grids',
      sourceStreamHeight: Math.min(probe.width || 0, probe.height || 0) || probe.height,
    });
    indexPayload = composed.indexPayload;
  } finally {
    await fs.promises.rm(tempFramesDir, { recursive: true, force: true });
  }

  await fs.promises.writeFile(paths.framesIndexPath, JSON.stringify(indexPayload, null, 2), 'utf8');

  const { segments: _omitSegments, ...manifestBody } = metaInfo;
  const manifest = {
    ...manifestBody,
    duration_sec: roundSec(durationSec, 2),
    sampling_meta: {
      probe_fps: effectiveProbeFps,
      diff_threshold: effectiveDiffThreshold,
      settle_threshold: effectiveSettleThreshold,
      max_frames: effectiveMaxFrames,
      raw_visual_events: rawCandidates.length,
      selected_frames: indexPayload.total_frames,
      total_grids: indexPayload.total_grids,
    },
    completed: true,
  };

  await fs.promises.writeFile(paths.manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return buildPathsOnlyReturnPayload(paths);
}

function isBundleComplete(paths) {
  if (!fs.existsSync(paths.manifestPath) || !fs.existsSync(paths.framesIndexPath)) {
    return false;
  }
  try {
    const m = JSON.parse(fs.readFileSync(paths.manifestPath, 'utf8'));
    return Boolean(m?.completed);
  } catch {
    return false;
  }
}

/**
 * Return ONLY concise statistics and absolute file paths so MCP responses stay ultra-compact (~180 tokens).
 */
async function buildPathsOnlyReturnPayload(paths) {
  const manifest = JSON.parse(await fs.promises.readFile(paths.manifestPath, 'utf8'));
  const framesIndex = JSON.parse(await fs.promises.readFile(paths.framesIndexPath, 'utf8'));

  const spriteFiles = fs.existsSync(paths.spritesDir)
    ? (await fs.promises.readdir(paths.spritesDir))
        .filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(f))
        .sort()
        .map((f) => path.join(paths.spritesDir, f))
    : [];

  const gridFiles = (framesIndex.grids || []).map((g) => path.join(paths.bundleDir, g.file));

  return {
    bundle_id: manifest.bundle_id,
    platform: manifest.platform,
    video_id: manifest.video_id,
    part: manifest.part,
    multi_part_notice: manifest.multi_part_notice || undefined,
    title: manifest.title,
    author: manifest.author,
    duration_sec: manifest.duration_sec,
    has_subtitle: Boolean(manifest.subtitle_meta?.has_subtitle),
    subtitle_segments: manifest.subtitle_meta?.segment_count || 0,
    chapters_count: manifest.chapters?.length || 0,
    sprite_sheets: spriteFiles.length,
    total_frames: framesIndex.total_frames,
    total_grids: framesIndex.total_grids,
    paths: {
      bundle_dir: paths.bundleDir,
      manifest: paths.manifestPath,
      transcript: paths.transcriptPath,
      subtitles_json: paths.subtitlesJsonPath,
      frames_index: paths.framesIndexPath,
      sprites_dir: spriteFiles.length > 0 ? paths.spritesDir : null,
      sprites_index: fs.existsSync(paths.spritesIndexPath) ? paths.spritesIndexPath : null,
      sprite_files: spriteFiles,
      grids_dir: paths.gridsDir,
      grid_files: gridFiles,
    },
  };
}
