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
  detectSceneChanges,
  extractLanczosFrames,
  extractRawCleanFrames,
  probeVideo,
} from './media/ffmpeg.js';
import { composeGrids } from './media/grid-composer.js';
import { buildHybridSamplePlan, buildIntervalSamplePlan } from './media/sampler.js';
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
  downloadVideoClipSection,
  dumpYtDlpInfo,
  ensureCachedVideoStream,
  extractSubtitlesFromYtDlpInfo,
  extractYoutubeStoryboards,
} from './platforms/ytdlp.js';
import { writeTempNetscapeCookieFile } from './utils/http.js';
import { formatSlugTimestamp, parseTimestampSec, roundSec } from './utils/time.js';

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
    gridsDir: path.join(bundleDir, 'grids'),
    clipsDir: path.join(bundleDir, 'clips'),
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

/**
 * Create a transient Netscape cookie file inside output/<bundle>/cache/ only for the duration of a yt-dlp fallback call.
 */
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
 * Tool: Read or persist unified settings in config.yaml (with 1-to-1 Environment Variable mapping).
 */
export async function manageConfig(updates = {}) {
  const keyMap = {
    output_dir: 'output.dir',
    bilibili_cookie: 'auth.bilibili_cookie',
    allow_guest_degraded: 'auth.allow_guest_degraded',
    scene_threshold: 'sampling.scene_threshold',
    min_interval_sec: 'sampling.min_interval_sec',
    max_interval_sec: 'sampling.max_interval_sec',
    max_frames: 'sampling.max_frames',
    clip_interval_sec: 'sampling.clip_interval_sec',
    clip_max_span_sec: 'sampling.clip_max_span_sec',
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
 * Tool 1: Environment, Config & Bilibili Authentication Status Check
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
 * Tool 2 (Tier 1): Fast Video Inspection (Metadata + Cleaned Transcript + Native Progress-Bar Sprites)
 */
export async function inspectVideo({
  url_or_id,
  part,
  output_dir,
  allow_guest_degraded,
  force = false,
}) {
  const resolved = await resolveVideoInput(url_or_id, part);
  const baseOutputDir = resolveOutputDir(output_dir);
  await fs.promises.mkdir(baseOutputDir, { recursive: true });

  if (resolved.platform === 'bilibili') {
    const auth = await ensureBilibiliAuth(allow_guest_degraded);
    const cookieHeader = auth.cookie_header || '';

    const view = await fetchBilibiliView(resolved, cookieHeader, auth.wbi_keys);
    const bundleId = `bilibili_${view.bvid}_p${view.part}`;
    const paths = getBundlePaths(baseOutputDir, bundleId);

    if (!force && fs.existsSync(paths.manifestPath)) {
      const existingManifest = JSON.parse(await fs.promises.readFile(paths.manifestPath, 'utf8'));
      if (existingManifest?.tiers_completed?.tier1_inspect) {
        return buildInspectReturnPayload(paths, existingManifest);
      }
    }

    await fs.promises.mkdir(paths.subtitlesDir, { recursive: true });
    await fs.promises.mkdir(paths.cacheDir, { recursive: true });

    let { chapters, subtitleTrack, segments } = await fetchBilibiliSubtitlesAndChapters(
      view.bvid,
      view.cid,
      cookieHeader,
      auth.wbi_keys
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

    const existingManifest = fs.existsSync(paths.manifestPath)
      ? JSON.parse(await fs.promises.readFile(paths.manifestPath, 'utf8'))
      : null;

    const manifest = {
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
          ? `This video has ${view.pages.length} parts. Defaulted to P1 ("${view.partTitle}"). Pass part=N to inspect other parts.`
          : null,
      source_url: view.canonicalUrl,
      title: view.title,
      author: view.author,
      duration_sec: view.duration_sec,
      description: view.description,
      chapters,
      parts: view.pages,
      auth_degraded: !auth.authenticated,
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
      tiers_completed: {
        tier1_inspect: true,
        tier2_grids: existingManifest?.tiers_completed?.tier2_grids || false,
        tier3_clips: existingManifest?.tiers_completed?.tier3_clips || [],
      },
    };

    await fs.promises.writeFile(paths.manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    return buildInspectReturnPayload(paths, manifest);
  }

  // YouTube Tier 1 (public workflow requires zero cookies)
  const bundleId = `youtube_${resolved.videoId}_p1`;
  const paths = getBundlePaths(baseOutputDir, bundleId);

  if (!force && fs.existsSync(paths.manifestPath)) {
    const existingManifest = JSON.parse(await fs.promises.readFile(paths.manifestPath, 'utf8'));
    if (existingManifest?.tiers_completed?.tier1_inspect) {
      return buildInspectReturnPayload(paths, existingManifest);
    }
  }

  await fs.promises.mkdir(paths.subtitlesDir, { recursive: true });
  await fs.promises.mkdir(paths.cacheDir, { recursive: true });

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

  const existingManifest = fs.existsSync(paths.manifestPath)
    ? JSON.parse(await fs.promises.readFile(paths.manifestPath, 'utf8'))
    : null;

  const manifest = {
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
    tiers_completed: {
      tier1_inspect: true,
      tier2_grids: existingManifest?.tiers_completed?.tier2_grids || false,
      tier3_clips: existingManifest?.tiers_completed?.tier3_clips || [],
    },
  };

  await fs.promises.writeFile(paths.manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return buildInspectReturnPayload(paths, manifest);
}

async function buildInspectReturnPayload(paths, manifest) {
  const fullTranscript = fs.existsSync(paths.transcriptPath)
    ? await fs.promises.readFile(paths.transcriptPath, 'utf8')
    : '';

  const MAX_INLINE_CHARS = 12_000;
  const truncated = fullTranscript.length > MAX_INLINE_CHARS;
  const transcriptPreview = truncated
    ? `${fullTranscript.slice(0, MAX_INLINE_CHARS)}\n\n... [Truncated at ${MAX_INLINE_CHARS} chars; read full file at ${paths.transcriptPath}]`
    : fullTranscript;

  const spriteFiles = fs.existsSync(paths.spritesDir)
    ? (await fs.promises.readdir(paths.spritesDir))
        .filter((f) => f.endsWith('.jpg') || f.endsWith('.png') || f.endsWith('.webp'))
        .sort()
        .map((f) => path.join(paths.spritesDir, f))
    : [];

  return {
    bundle_id: manifest.bundle_id,
    output_root: manifest.output_root || path.dirname(paths.bundleDir),
    bundle_path: paths.bundleDir,
    manifest_path: paths.manifestPath,
    transcript_path: paths.transcriptPath,
    subtitles_json_path: paths.subtitlesJsonPath,
    sprites_index_path: manifest.sprites_meta?.index_file
      ? path.join(paths.bundleDir, manifest.sprites_meta.index_file)
      : null,
    sprite_image_paths: spriteFiles,
    manifest_summary: {
      platform: manifest.platform,
      video_id: manifest.video_id,
      part: manifest.part,
      multi_part_notice: manifest.multi_part_notice || undefined,
      title: manifest.title,
      author: manifest.author,
      duration_sec: manifest.duration_sec,
      chapters_count: manifest.chapters?.length || 0,
      chapters: manifest.chapters || [],
      subtitle_meta: manifest.subtitle_meta,
    },
    transcript_truncated: truncated,
    transcript: transcriptPreview,
  };
}

/**
 * Tool 3 (Tier 2): Global Standard Grid Extraction
 */
export async function extractVideoGrids({
  url_or_id,
  part,
  output_dir,
  scene_threshold,
  min_interval_sec,
  max_interval_sec,
  max_frames,
  allow_guest_degraded,
  force = false,
}) {
  const { config } = loadEffectiveConfig();
  const effectiveScene = scene_threshold ?? config.sampling.scene_threshold;
  const effectiveMinInterval = min_interval_sec ?? config.sampling.min_interval_sec;
  const effectiveMaxInterval = max_interval_sec ?? config.sampling.max_interval_sec;
  const effectiveMaxFrames = max_frames ?? config.sampling.max_frames;

  const tier1 = await inspectVideo({
    url_or_id,
    part,
    output_dir,
    allow_guest_degraded,
    force: false,
  });

  const baseOutputDir = resolveOutputDir(output_dir);
  const paths = getBundlePaths(baseOutputDir, tier1.bundle_id);
  const manifest = JSON.parse(await fs.promises.readFile(paths.manifestPath, 'utf8'));

  if (!force && manifest.tiers_completed?.tier2_grids && fs.existsSync(paths.framesIndexPath)) {
    const cachedIndex = JSON.parse(await fs.promises.readFile(paths.framesIndexPath, 'utf8'));
    return formatGridReturnPayload(paths.bundleDir, cachedIndex);
  }

  await fs.promises.mkdir(paths.cacheDir, { recursive: true });

  console.error(`[video-context] [Tier 2] Caching video stream for ${manifest.bundle_id}...`);
  let videoPath;
  if (manifest.platform === 'bilibili' && manifest.cid) {
    const auth = await checkBilibiliAuth();
    const cookieHeader = auth.cookie_header || '';
    try {
      videoPath = await downloadBilibiliDashStream({
        bvid: manifest.video_id,
        cid: manifest.cid,
        destDir: paths.cacheDir,
        tier: 'tier2',
        cookieHeader,
        wbiKeys: auth.wbi_keys,
      });
    } catch (err) {
      console.error(
        `[video-context] [Tier 2] Direct DASH mirror failed (${err.message}); falling back to yt-dlp...`
      );
      videoPath = await withTempBilibiliCookieFile(paths.cacheDir, (tmpCookiePath) =>
        ensureCachedVideoStream({
          platform: 'bilibili',
          canonicalUrl: manifest.source_url,
          cacheDir: paths.cacheDir,
          tier: 'tier2',
          cookieFilePath: tmpCookiePath,
        })
      );
    }
  } else {
    videoPath = await ensureCachedVideoStream({
      platform: manifest.platform,
      canonicalUrl: manifest.source_url,
      cacheDir: paths.cacheDir,
      tier: 'tier2',
      cookieFilePath: null,
    });
  }

  const probe = await probeVideo(videoPath);
  const durationSec = probe.durationSec || manifest.duration_sec || 10;
  console.error(
    `[video-context] [Tier 2] Stream ready (${probe.width}x${probe.height}, ${Math.round(durationSec)}s). Running scene detection...`
  );

  const sceneTimestamps = await detectSceneChanges(videoPath, effectiveScene);

  const subtitleSegments = fs.existsSync(paths.subtitlesJsonPath)
    ? JSON.parse(await fs.promises.readFile(paths.subtitlesJsonPath, 'utf8'))
    : [];

  const samplePoints = buildHybridSamplePlan({
    durationSec,
    sceneTimestamps,
    subtitleSegments,
    minIntervalSec: effectiveMinInterval,
    maxIntervalSec: effectiveMaxInterval,
    maxFrames: effectiveMaxFrames,
  });

  const gridCols = config.grid.cols;
  const gridRows = config.grid.rows;
  const perGrid = gridCols * gridRows;
  console.error(
    `[video-context] [Tier 2] Extracting ${samplePoints.length} frames & composing ${Math.ceil(samplePoints.length / perGrid)} ${gridRows}x${gridCols} grids...`
  );

  const tempFramesDir = path.join(paths.cacheDir, 'tmp_frames_tier2');
  await fs.promises.rm(tempFramesDir, { recursive: true, force: true });
  await fs.promises.rm(paths.gridsDir, { recursive: true, force: true });

  let indexPayload;
  try {
    const extractedFrames = await extractLanczosFrames({
      videoPath,
      samplePoints,
      tempFramesDir,
      useLocalSec: false,
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

  manifest.tiers_completed.tier2_grids = true;
  await fs.promises.writeFile(paths.manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  return formatGridReturnPayload(paths.bundleDir, indexPayload);
}

function formatGridReturnPayload(bundleDir, indexPayload) {
  return {
    output_root: path.dirname(bundleDir),
    bundle_path: bundleDir,
    frames_index_path: path.join(bundleDir, 'frames_index.json'),
    grid_layout: indexPayload.grid_layout,
    grid_image_size: indexPayload.grid_image_size,
    source_stream_short_side: indexPayload.source_stream_height,
    total_frames: indexPayload.total_frames,
    total_grids: indexPayload.total_grids,
    reading_guide:
      'Each grid cell has a top black bar showing "#FrameNo | Timestamp". Select only the grid files matching your target time span rather than loading all images at once.',
    grids: indexPayload.grids.map((g) => ({
      grid_index: g.grid_index,
      image_path: path.join(bundleDir, g.file),
      start_sec: g.start_sec,
      end_sec: g.end_sec,
      matrix_sec: g.matrix_sec,
    })),
  };
}

/**
 * Tool 4 (Tier 3): Local Microscope / Range-Sliced High-Density Clip Extraction
 */
export async function extractVideoClip({
  url_or_id,
  part,
  start_time,
  end_time,
  interval_sec,
  output_mode = 'grid',
  output_dir,
  allow_guest_degraded,
}) {
  const { config } = loadEffectiveConfig();
  const effectiveInterval = interval_sec ?? config.sampling.clip_interval_sec;
  const maxSpanSec = config.sampling.clip_max_span_sec;

  const startSec = parseTimestampSec(start_time);
  const endSec = parseTimestampSec(end_time);

  if (endSec <= startSec) {
    throw new Error(`end_time (${endSec}s) must be greater than start_time (${startSec}s).`);
  }
  if (endSec - startSec > maxSpanSec) {
    throw new Error(
      `Clip span (${roundSec(endSec - startSec, 1)}s) exceeds Tier 3 microscope limit (${maxSpanSec}s). Use video_extract_grids for broad spans, or narrow [start_time, end_time].`
    );
  }

  const tier1 = await inspectVideo({
    url_or_id,
    part,
    output_dir,
    allow_guest_degraded,
    force: false,
  });

  const baseOutputDir = resolveOutputDir(output_dir);
  const paths = getBundlePaths(baseOutputDir, tier1.bundle_id);
  const manifest = JSON.parse(await fs.promises.readFile(paths.manifestPath, 'utf8'));

  const clampedEnd =
    manifest.duration_sec > 0 ? Math.min(endSec, manifest.duration_sec - 0.1) : endSec;
  if (clampedEnd <= startSec) {
    throw new Error(
      `Requested start_time (${startSec}s) is beyond video duration (${manifest.duration_sec}s).`
    );
  }

  const slug = `${formatSlugTimestamp(startSec)}_${formatSlugTimestamp(clampedEnd)}`;
  const clipDir = path.join(paths.clipsDir, slug);
  await fs.promises.mkdir(clipDir, { recursive: true });
  await fs.promises.mkdir(paths.cacheDir, { recursive: true });

  const cacheEntries = await fs.promises.readdir(paths.cacheDir);
  const existingHd = cacheEntries.find(
    (f) => f.startsWith('source_hd.') && !f.endsWith('.part') && !f.endsWith('.ytdl')
  );
  const existingStd = cacheEntries.find(
    (f) => f.startsWith('source_std.') && !f.endsWith('.part') && !f.endsWith('.ytdl')
  );

  let videoSourcePath;
  let useLocalSec = false;

  if (existingHd) {
    videoSourcePath = path.join(paths.cacheDir, existingHd);
    useLocalSec = false;
  } else if (existingStd && output_mode === 'grid') {
    videoSourcePath = path.join(paths.cacheDir, existingStd);
    useLocalSec = false;
  } else if (manifest.platform === 'bilibili' && manifest.cid) {
    const auth = await checkBilibiliAuth();
    const cookieHeader = auth.cookie_header || '';
    try {
      videoSourcePath = await downloadBilibiliDashStream({
        bvid: manifest.video_id,
        cid: manifest.cid,
        destDir: paths.cacheDir,
        tier: 'tier3',
        cookieHeader,
        wbiKeys: auth.wbi_keys,
      });
      useLocalSec = false;
    } catch {
      videoSourcePath = await withTempBilibiliCookieFile(paths.cacheDir, (tmpCookiePath) =>
        downloadVideoClipSection({
          platform: 'bilibili',
          canonicalUrl: manifest.source_url,
          startSec,
          endSec: Math.ceil(clampedEnd + 0.5),
          clipCacheDir: path.join(paths.cacheDir, 'sections'),
          slug,
          cookieFilePath: tmpCookiePath,
        })
      );
      useLocalSec = true;
    }
  } else {
    videoSourcePath = await downloadVideoClipSection({
      platform: manifest.platform,
      canonicalUrl: manifest.source_url,
      startSec,
      endSec: Math.ceil(clampedEnd + 0.5),
      clipCacheDir: path.join(paths.cacheDir, 'sections'),
      slug,
      cookieFilePath: null,
    });
    useLocalSec = true;
  }

  const probe = await probeVideo(videoSourcePath);
  const effectiveEnd = useLocalSec
    ? Math.min(clampedEnd, startSec + Math.max(0.2, (probe.durationSec || clampedEnd - startSec) - 0.1))
    : clampedEnd;

  const samplePoints = buildIntervalSamplePlan({
    startSec,
    endSec: effectiveEnd,
    intervalSec: effectiveInterval,
  });

  let outputResult;
  if (output_mode === 'raw_frames') {
    const rawDir = path.join(clipDir, 'raw_frames');
    await fs.promises.rm(rawDir, { recursive: true, force: true });
    const rawFrames = await extractRawCleanFrames({
      videoPath: videoSourcePath,
      samplePoints,
      outDir: rawDir,
      useLocalSec,
    });
    const clipIndex = {
      mode: 'raw_frames',
      start_sec: startSec,
      end_sec: effectiveEnd,
      interval_sec: effectiveInterval,
      resolution: [probe.width, probe.height],
      total_frames: rawFrames.length,
      frames: rawFrames,
    };
    const clipIndexPath = path.join(clipDir, 'clip_index.json');
    await fs.promises.writeFile(clipIndexPath, JSON.stringify(clipIndex, null, 2), 'utf8');

    outputResult = {
      output_root: baseOutputDir,
      bundle_path: paths.bundleDir,
      clip_dir: clipDir,
      clip_index_path: clipIndexPath,
      output_mode: 'raw_frames',
      resolution: [probe.width, probe.height],
      total_frames: rawFrames.length,
      frames: rawFrames,
    };
  } else {
    const tempFramesDir = path.join(paths.cacheDir, `tmp_clip_${slug}`);
    await fs.promises.rm(tempFramesDir, { recursive: true, force: true });

    try {
      const extractedFrames = await extractLanczosFrames({
        videoPath: videoSourcePath,
        samplePoints,
        tempFramesDir,
        useLocalSec,
      });

      const { indexPayload } = await composeGrids({
        extractedFrames,
        gridsDir: clipDir,
        relativeDirPrefix: `clips/${slug}`,
        sourceStreamHeight: Math.min(probe.width || 0, probe.height || 0) || probe.height,
      });

      const clipIndexPath = path.join(clipDir, 'clip_index.json');
      await fs.promises.writeFile(clipIndexPath, JSON.stringify(indexPayload, null, 2), 'utf8');

      outputResult = {
        output_root: baseOutputDir,
        bundle_path: paths.bundleDir,
        clip_dir: clipDir,
        clip_index_path: clipIndexPath,
        output_mode: 'grid',
        total_frames: indexPayload.total_frames,
        total_grids: indexPayload.total_grids,
        grids: indexPayload.grids.map((g) => ({
          grid_index: g.grid_index,
          image_path: path.join(paths.bundleDir, g.file),
          start_sec: g.start_sec,
          end_sec: g.end_sec,
          matrix_sec: g.matrix_sec,
        })),
      };
    } finally {
      await fs.promises.rm(tempFramesDir, { recursive: true, force: true });
    }
  }

  if (!manifest.tiers_completed.tier3_clips.includes(slug)) {
    manifest.tiers_completed.tier3_clips.push(slug);
    await fs.promises.writeFile(paths.manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  }

  return outputResult;
}
