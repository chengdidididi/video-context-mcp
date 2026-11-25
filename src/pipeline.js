import fs from 'node:fs';
import path from 'node:path';
import { probeAudioStream } from './asr/audio-chunker.js';
import {
  AsrConfigRequiredError,
  getAsrStatusSummary,
  requireValidAsrProvider,
  transcribeAudioMedia,
} from './asr/index.js';
import {
  ENV_VAR_MAP,
  getBilibiliCookieConfig,
  getRpcWaitMs,
  getTimeoutMs,
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
import {
  composeGrids,
  resolveOrientationAwareGridSpec,
} from './media/grid-composer.js';
import { createTwoGateTracker, finalizeSamplePlan } from './media/sampler.js';
import { formatTranscriptMarkdown } from './parsers/subtitles.js';
import { resolveVideoInput } from './parsers/url-parser.js';
import {
  AuthRequiredError,
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

export class PipelineExecutionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PipelineExecutionError';
    this.code = code; // 'PIPELINE_TIMEOUT' | 'EXECUTION_ERROR'
    this.details = details;
  }
}

const inFlightExtractions = new Map();
const recentCheckpointedResults = new Map();
const RECENT_SETTLED_TTL_MS = 120_000;

function pruneRecentCheckpointedResults() {
  const now = Date.now();
  for (const [k, entry] of recentCheckpointedResults.entries()) {
    if (now - entry.settledAt > RECENT_SETTLED_TTL_MS) {
      recentCheckpointedResults.delete(k);
    }
  }
}

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
    rpc_wait_sec: 'runtime.rpc_wait_sec',
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

async function waitWithRpcCheckpoint(job, rpcWaitMs) {
  if (!rpcWaitMs || rpcWaitMs <= 0) {
    try {
      return await job.promise;
    } finally {
      job.pendingCheckpointHandoff = false;
      recentCheckpointedResults.delete(job.lockId);
    }
  }

  let timer = null;
  const checkpointSymbol = Symbol('checkpoint');
  let settledWhileWaiting = false;
  const winner = await Promise.race([
    job.promise.then(
      (val) => {
        settledWhileWaiting = true;
        return val;
      },
      (err) => {
        settledWhileWaiting = true;
        throw err;
      }
    ),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(checkpointSymbol), rpcWaitMs);
      if (timer.unref) timer.unref();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
    if (settledWhileWaiting) {
      job.pendingCheckpointHandoff = false;
      recentCheckpointedResults.delete(job.lockId);
    }
  });

  if (winner !== checkpointSymbol) {
    return winner;
  }

  job.pendingCheckpointHandoff = true;
  const elapsedSec = roundSec((Date.now() - job.startedAt) / 1000, 1);
  const totalBudgetSec = Math.round(job.totalBudgetMs / 1000);
  const remainingSec = roundSec(job.remainingMs() / 1000, 1);

  return {
    completed: false,
    status: 'RUNNING_IN_BACKGROUND',
    bundle_id: job.bundleId,
    current_stage: job.stage,
    stage_detail: job.stageDetail || undefined,
    elapsed_sec: elapsedSec,
    total_timeout_budget_sec: totalBudgetSec,
    remaining_budget_sec: remainingSec,
    instruction:
      'Extraction is actively running in the background and has NOT failed. Call video_extract again immediately with the exact same arguments to continue waiting for completion. Do NOT run shell, sleep, ls, find, or glob commands.',
  };
}

/**
 * Unified One-Shot Video Context Pipeline with:
 *  - Unconditional in-flight singleton locking (even when `force: true` is passed on follow-up calls)
 *  - Unified 300s global AbortSignal budget across all download, FFmpeg, and ASR stages
 *  - Proactive 45s RPC checkpoint response (`RUNNING_IN_BACKGROUND`) before upstream 50s gateway cutoff
 *  - Parallel execution of `[Audio ASR]` and `[Single-Pass Two-Gate Video Scan]`
 *  - Orientation-aware grids (`5x2` `360x640` for portrait, `3x3` `640x360` for landscape) + tail row cropping
 */
export async function extractVideo(options = {}) {
  const {
    url_or_id,
    part,
    output_dir,
    force = false,
    use_rpc_checkpoint = false,
    rpc_wait_ms_override,
  } = options;

  pruneRecentCheckpointedResults();
  const resolved = await resolveVideoInput(url_or_id, part);
  const baseOutputDir = resolveOutputDir(output_dir);
  await fs.promises.mkdir(baseOutputDir, { recursive: true });

  const lockId = `${baseOutputDir}::${resolved.platform}:${resolved.bvid || resolved.aid || resolved.videoId}:p${resolved.part || 1}`;
  const rpcWaitMs =
    rpc_wait_ms_override !== undefined
      ? Number(rpc_wait_ms_override)
      : use_rpc_checkpoint
        ? getRpcWaitMs()
        : 0;

  // 1. Always join an active in-flight job for the same target (prevents duplicate concurrent extractions even with force=true)
  if (inFlightExtractions.has(lockId)) {
    const activeJob = inFlightExtractions.get(lockId);
    console.error(
      `[video-context] Joining active in-flight extraction for ${lockId} (stage: ${activeJob.stage})...`
    );
    return waitWithRpcCheckpoint(activeJob, rpcWaitMs);
  }

  // 2. If a previously checkpointed job finished in the brief gap between two RPC calls, consume its result once
  if (recentCheckpointedResults.has(lockId)) {
    const settled = recentCheckpointedResults.get(lockId);
    recentCheckpointedResults.delete(lockId);
    return settled.promise;
  }

  // 3. Create new singleton job governed by unified global 300s timeout budget
  const totalBudgetMs = getTimeoutMs();
  const abortController = new AbortController();
  const defaultBundleId =
    resolved.platform === 'local'
      ? `local_${resolved.videoId}`
      : `${resolved.platform}_${resolved.videoId}_p${resolved.part || 1}`;

  const job = {
    lockId,
    bundleId: defaultBundleId,
    startedAt: Date.now(),
    totalBudgetMs,
    stage: 'initializing',
    stageDetail: '',
    timedOut: false,
    pendingCheckpointHandoff: false,
    abortController,
    signal: abortController.signal,
    setStage(stage, detail = '') {
      this.stage = stage;
      this.stageDetail = detail;
    },
    remainingMs() {
      return Math.max(1000, this.totalBudgetMs - (Date.now() - this.startedAt));
    },
    promise: null,
  };

  const masterTimer = setTimeout(() => {
    job.timedOut = true;
    const elapsedSec = roundSec((Date.now() - job.startedAt) / 1000, 1);
    const timeoutErr = new PipelineExecutionError(
      'PIPELINE_TIMEOUT',
      `Extraction exceeded global ${Math.round(totalBudgetMs / 1000)}s timeout budget at stage "${job.stage}"${job.stageDetail ? ` (${job.stageDetail})` : ''}.`,
      {
        failed_stage: job.stage,
        stage_detail: job.stageDetail || undefined,
        elapsed_sec: elapsedSec,
        timeout_budget_sec: Math.round(totalBudgetMs / 1000),
      }
    );
    abortController.abort(timeoutErr);
  }, totalBudgetMs);
  if (masterTimer.unref) masterTimer.unref();

  job.promise = runExtractVideoInternal(options, resolved, baseOutputDir, job)
    .then(
      (res) => {
        if (job.pendingCheckpointHandoff) {
          recentCheckpointedResults.set(lockId, {
            settledAt: Date.now(),
            promise: Promise.resolve(res),
          });
        }
        return res;
      },
      (err) => {
        if (job.pendingCheckpointHandoff) {
          const rejected = Promise.reject(err);
          rejected.catch(() => {}); // Prevent unhandled rejection while awaiting follow-up poll
          recentCheckpointedResults.set(lockId, {
            settledAt: Date.now(),
            promise: rejected,
          });
        }
        throw err;
      }
    )
    .finally(() => {
      clearTimeout(masterTimer);
      if (inFlightExtractions.get(lockId) === job) {
        inFlightExtractions.delete(lockId);
      }
    });

  // Prevent unhandled rejection if caller returns early at 45s checkpoint before job rejects
  job.promise.catch(() => {});
  inFlightExtractions.set(lockId, job);

  return waitWithRpcCheckpoint(job, rpcWaitMs);
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
  baseOutputDir,
  job
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
  let hadCompletedBundleBeforeRun = false;

  if (resolved.platform === 'local') {
    bundleId = `local_${resolved.videoId}`;
    job.bundleId = bundleId;
    paths = getBundlePaths(baseOutputDir, bundleId);
    hadCompletedBundleBeforeRun = isBundleComplete(paths);
    if (!force && hadCompletedBundleBeforeRun) {
      return buildPathsOnlyReturnPayload(paths);
    }
  } else if (resolved.platform === 'youtube') {
    bundleId = `youtube_${resolved.videoId}_p1`;
    job.bundleId = bundleId;
    paths = getBundlePaths(baseOutputDir, bundleId);
    hadCompletedBundleBeforeRun = isBundleComplete(paths);
    if (!force && hadCompletedBundleBeforeRun) {
      return buildPathsOnlyReturnPayload(paths);
    }
  }

  if (force && hadCompletedBundleBeforeRun && paths?.cacheDir) {
    await fs.promises.rm(paths.cacheDir, { recursive: true, force: true }).catch(() => {});
  }

  let succeeded = false;

  try {
    let videoPath;
    let chapters = [];
    let initialSegments = [];
    let subtitleSource = 'none';
    let title = '';
    let author = '';
    let description = '';
    let sourceUrl = '';
    let initialDurationSec = 0;
    let videoIdOut = resolved.videoId;
    let partOut = 1;
    let multiPartNotice = null;
    let asrTaskRunner = null;

    if (resolved.platform === 'local') {
      job.setStage('probing_local_video');
      const localProbe = await probeVideo(resolved.localPath, job.signal);
      if (!localProbe.hasVideo) {
        throw new Error(`Local file does not contain a valid video stream: "${resolved.localPath}"`);
      }

      const resolvedProvider = localProbe.hasAudio ? requireValidAsrProvider(config.asr) : null;

      await fs.promises.mkdir(paths.bundleDir, { recursive: true });
      await fs.promises.mkdir(paths.cacheDir, { recursive: true });

      job.setStage('transcoding_local_video_360p');
      console.error(
        `[video-context] Compressing local video (${localProbe.width}x${localProbe.height}${localProbe.fps ? `@${Math.round(localProbe.fps)}fps` : ''}) to 360p@<=30fps cache stream for ${bundleId}...`
      );
      videoPath = await transcodeLocalVideoToCompactCache(resolved.localPath, paths.cacheDir, {
        targetShortSide: 360,
        maxFps: 30,
        timeoutMs: job.remainingMs(),
        signal: job.signal,
      });

      title = resolved.fileName;
      author = 'Local Video';
      sourceUrl = resolved.canonicalUrl;
      initialDurationSec = localProbe.durationSec;

      if (localProbe.hasAudio && resolvedProvider) {
        asrTaskRunner = async () => {
          const asrOut = await transcribeAudioMedia({
            audioMediaPath: resolved.localPath,
            cacheDir: paths.cacheDir,
            asrConfig: config.asr,
            resolvedProvider,
            timeoutMs: job.remainingMs(),
            signal: job.signal,
            onProgress: (detail) => job.setStage('cloud_asr', detail),
          });
          return {
            segments: asrOut.segments,
            subtitleSource: `asr:${asrOut.providerName}`,
          };
        };
      } else {
        console.error(`[video-context] Local video has no audio stream; skipping ASR.`);
      }
    } else if (resolved.platform === 'bilibili') {
      job.setStage('authenticating_bilibili');
      const biliAuth = await ensureBilibiliAuth(allow_guest_degraded);
      const cookieHeader = biliAuth.cookie_header || '';
      const view = await fetchBilibiliView(resolved, cookieHeader, biliAuth.wbi_keys);

      bundleId = `bilibili_${view.bvid}_p${view.part}`;
      job.bundleId = bundleId;
      paths = getBundlePaths(baseOutputDir, bundleId);
      hadCompletedBundleBeforeRun = isBundleComplete(paths);
      if (!force && hadCompletedBundleBeforeRun) {
        return buildPathsOnlyReturnPayload(paths);
      }

      if (force && hadCompletedBundleBeforeRun) {
        await fs.promises.rm(paths.cacheDir, { recursive: true, force: true }).catch(() => {});
      }
      await fs.promises.mkdir(paths.bundleDir, { recursive: true });
      await fs.promises.mkdir(paths.cacheDir, { recursive: true });

      job.setStage('downloading_bilibili_video_and_subtitles');
      console.error(`[video-context] Fetching subtitles & compact stream concurrently for ${bundleId}...`);

      const fetchSubsTask = (async () => {
        let subRes = await fetchBilibiliSubtitlesAndChapters(
          view.bvid,
          view.cid,
          cookieHeader,
          biliAuth.wbi_keys
        );

        if (subRes.segments.length === 0) {
          const tempSubDir = path.join(paths.cacheDir, 'tmp_subs');
          try {
            await withTempBilibiliCookieFile(paths.cacheDir, async (tmpCookiePath) => {
              const info = await dumpYtDlpInfo('bilibili', view.canonicalUrl, tmpCookiePath, job.signal);
              const ytSub = await extractSubtitlesFromYtDlpInfo(
                info,
                'bilibili',
                view.canonicalUrl,
                tmpCookiePath,
                tempSubDir
              );
              if (ytSub.segments.length > 0) {
                subRes = {
                  chapters: subRes.chapters,
                  subtitleTrack: ytSub.subtitleTrack,
                  segments: ytSub.segments,
                };
              }
            });
          } catch (err) {
            if (job.signal.aborted) throw err;
          } finally {
            await fs.promises.rm(tempSubDir, { recursive: true, force: true });
          }
        }
        return subRes;
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
            signal: job.signal,
          });
        } catch (err) {
          if (job.signal.aborted) throw err;
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
              signal: job.signal,
            })
          );
        }
      })();

      const [subResult, downloadedVideoPath] = await Promise.all([
        fetchSubsTask,
        fetchVideoTask,
      ]);

      videoPath = downloadedVideoPath;
      chapters = subResult.chapters;
      initialSegments = subResult.segments;
      subtitleSource =
        subResult.subtitleTrack?.source_type || (initialSegments.length > 0 ? 'native' : 'none');
      title = view.title;
      author = view.author;
      description = view.description;
      sourceUrl = view.canonicalUrl;
      initialDurationSec = view.duration_sec;
      videoIdOut = view.bvid;
      partOut = view.part;
      multiPartNotice =
        view.pages.length > 1 && !resolved.partExplicit
          ? `This video has ${view.pages.length} parts. Defaulted to P1 ("${view.partTitle}"). Pass part=N for other parts.`
          : null;

      if (initialSegments.length === 0) {
        asrTaskRunner = async () => {
          job.setStage('downloading_bilibili_audio');
          let audioPath = null;
          try {
            audioPath = await downloadBilibiliDashAudio({
              bvid: view.bvid,
              cid: view.cid,
              destDir: paths.cacheDir,
              cookieHeader,
              wbiKeys: biliAuth.wbi_keys,
              preferredAudioKbps: 96,
              signal: job.signal,
            });
          } catch (err) {
            if (job.signal.aborted) throw err;
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
                signal: job.signal,
              })
            );
          }

          if (!audioPath || !(await probeAudioStream(audioPath, job.signal))) {
            return { segments: [], subtitleSource: 'none' };
          }

          const resolvedProvider = requireValidAsrProvider(config.asr);
          const asrOut = await transcribeAudioMedia({
            audioMediaPath: audioPath,
            cacheDir: paths.cacheDir,
            asrConfig: config.asr,
            resolvedProvider,
            timeoutMs: job.remainingMs(),
            signal: job.signal,
            onProgress: (detail) => job.setStage('cloud_asr', detail),
          });
          return {
            segments: asrOut.segments,
            subtitleSource: `asr:${asrOut.providerName}`,
          };
        };
      }
    } else {
      await fs.promises.mkdir(paths.bundleDir, { recursive: true });
      await fs.promises.mkdir(paths.cacheDir, { recursive: true });

      job.setStage('resolving_youtube_metadata');
      console.error(`[video-context] Resolving YouTube metadata for ${bundleId}...`);
      const info = await dumpYtDlpInfo('youtube', resolved.canonicalUrl, null, job.signal);

      job.setStage('downloading_youtube_video_and_subtitles');
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
        signal: job.signal,
      });

      const [subResult, downloadedVideoPath] = await Promise.all([
        fetchSubsTask,
        fetchVideoTask,
      ]);

      videoPath = downloadedVideoPath;
      initialSegments = subResult.segments;
      subtitleSource =
        subResult.subtitleTrack?.source_type || (initialSegments.length > 0 ? 'native' : 'none');
      chapters = Array.isArray(info.chapters)
        ? info.chapters.map((ch) => ({
            title: ch.title || '',
            start_sec: roundSec(Number(ch.start_time || 0), 2),
            end_sec: roundSec(Number(ch.end_time || 0), 2),
          }))
        : [];
      title = info.title || resolved.videoId;
      author = info.uploader || info.channel || 'Unknown';
      initialDurationSec = Number(info.duration || 0);
      description = info.description || '';
      sourceUrl = resolved.canonicalUrl;

      if (initialSegments.length === 0) {
        const hasAudioInFormats =
          !Array.isArray(info.formats) ||
          info.formats.some((f) => f && f.acodec && f.acodec !== 'none');

        if (hasAudioInFormats) {
          const resolvedProvider = requireValidAsrProvider(config.asr);
          asrTaskRunner = async () => {
            job.setStage('downloading_youtube_audio');
            const audioPath = await ensureCachedAudioStream({
              platform: 'youtube',
              canonicalUrl: resolved.canonicalUrl,
              cacheDir: paths.cacheDir,
              cookieFilePath: null,
              info,
              preferredAudioKbps: 96,
              signal: job.signal,
            });
            if (!audioPath || !(await probeAudioStream(audioPath, job.signal))) {
              return { segments: [], subtitleSource: 'none' };
            }
            const asrOut = await transcribeAudioMedia({
              audioMediaPath: audioPath,
              cacheDir: paths.cacheDir,
              asrConfig: config.asr,
              resolvedProvider,
              timeoutMs: job.remainingMs(),
              signal: job.signal,
              onProgress: (detail) => job.setStage('cloud_asr', detail),
            });
            return {
              segments: asrOut.segments,
              subtitleSource: `asr:${asrOut.providerName}`,
            };
          };
        }
      }
    }

    // Step 2: Run [Orientation-aware Single-Pass Video Scan] and [Audio ASR (if needed)] IN PARALLEL!
    const probe = await probeVideo(videoPath, job.signal);
    const durationSec = probe.durationSec || initialDurationSec || 10;
    const gridSpec = resolveOrientationAwareGridSpec(probe.width, probe.height);
    const cellW = gridSpec.cellWidth;
    const cellH = gridSpec.cellHeight;

    console.error(
      `[video-context] Stream ready (${probe.width}x${probe.height} [${gridSpec.orientation}], ${Math.round(durationSec)}s). Running Two-Gate scan (${gridSpec.cols}x${gridSpec.rows} @ ${cellW}x${cellH})${asrTaskRunner ? ' + parallel cloud ASR' : ''}...`
    );

    if (!asrTaskRunner) {
      job.setStage('scanning_video_frames');
    }

    const tracker = createTwoGateTracker({
      width: gridSpec.probeWidth,
      height: gridSpec.probeHeight,
      tileCols: gridSpec.tileCols,
      tileRows: gridSpec.tileRows,
      diffThreshold: effectiveDiffThreshold,
      settleThreshold: effectiveSettleThreshold,
      minIntervalSec: effectiveMinInterval,
      maxIntervalSec: effectiveMaxInterval,
      onEmit: (rgbBuf) => encodeRgbCandidateToJpeg(rgbBuf, cellW, cellH, 88),
    });

    const visualScanPromise = scanSinglePassVideoStream(videoPath, tracker, {
      probeFps: effectiveProbeFps,
      cellWidth: cellW,
      cellHeight: cellH,
      probeWidth: gridSpec.probeWidth,
      probeHeight: gridSpec.probeHeight,
      timeoutMs: job.remainingMs(),
      signal: job.signal,
    }).catch((err) => {
      if (!job.signal.aborted) job.abortController.abort(err);
      throw err;
    });

    const asrPromise = asrTaskRunner
      ? asrTaskRunner().catch((err) => {
          if (!job.signal.aborted) job.abortController.abort(err);
          throw err;
        })
      : Promise.resolve({ segments: initialSegments, subtitleSource });

    const [, asrResolved] = await Promise.all([visualScanPromise, asrPromise]);
    const finalSegments = asrResolved.segments;
    const finalSubtitleSource = asrResolved.subtitleSource;

    const transcriptMd = formatTranscriptMarkdown(finalSegments, {
      title,
      author,
      platform: resolved.platform,
      durationSec,
      description,
      chapters,
      sourceUrl,
    });
    await fs.promises.writeFile(paths.transcriptPath, transcriptMd, 'utf8');

    job.setStage('composing_grids');
    const rawCandidates = tracker.flush();
    const rawCandidatesCount = rawCandidates.length;
    const samplePoints = finalizeSamplePlan({
      rawCandidates,
      subtitleSegments: finalSegments,
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

    const perGrid = gridSpec.cols * gridSpec.rows;
    console.error(
      `[video-context] Selected ${samplePoints.length} settled frames (from ${rawCandidatesCount} raw visual changes) -> composing ${Math.ceil(samplePoints.length / perGrid)} ${gridSpec.cols}x${gridSpec.rows} (${gridSpec.orientation}) grids...`
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
    let indexPayload;
    try {
      if (missing.length > 0) {
        const recovered = await extractLanczosFrames({
          videoPath,
          samplePoints: missing,
          tempFramesDir,
          cellWidth: cellW,
          cellHeight: cellH,
          signal: job.signal,
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
        spec: gridSpec,
        signal: job.signal,
      });
      indexPayload = composed.indexPayload;
    } finally {
      if (missing.length > 0) {
        await fs.promises.rm(tempFramesDir, { recursive: true, force: true });
      }
    }

    await Promise.all([
      fs.promises.rm(path.join(paths.bundleDir, 'sprites'), { recursive: true, force: true }),
      fs.promises.rm(path.join(paths.bundleDir, 'subtitles'), { recursive: true, force: true }),
      fs.promises.rm(path.join(paths.bundleDir, 'frames_index.json'), { force: true }),
    ]);

    const manifest = {
      bundle_id: bundleId,
      platform: resolved.platform,
      video_id: videoIdOut,
      part: partOut,
      multi_part_notice: multiPartNotice,
      source_url: sourceUrl,
      title,
      author,
      duration_sec: roundSec(durationSec, 2),
      orientation: gridSpec.orientation,
      grid_layout: [gridSpec.rows, gridSpec.cols],
      cell_content_size: [cellW, cellH],
      has_subtitle: finalSegments.length > 0,
      subtitle_source: finalSubtitleSource,
      subtitle_segments: finalSegments.length,
      total_frames: indexPayload.total_frames,
      total_grids: indexPayload.total_grids,
      grid_files: (indexPayload.grids || []).map((g) => g.file),
      completed: true,
    };

    await fs.promises.writeFile(paths.manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    succeeded = true;
    return buildPathsOnlyReturnPayload(paths);
  } catch (err) {
    if (!job.signal.aborted) {
      job.abortController.abort(err);
    }

    // Remove incomplete outer deliverables (transcript.md / manifest.json / grids/) while keeping cache/
    // so a retry after transient 429/network failure resumes straight from cached media & completed ASR chunks!
    if (paths?.bundleDir && !hadCompletedBundleBeforeRun) {
      await Promise.all([
        fs.promises.rm(paths.manifestPath, { force: true }).catch(() => {}),
        fs.promises.rm(paths.transcriptPath, { force: true }).catch(() => {}),
        fs.promises.rm(paths.gridsDir, { recursive: true, force: true }).catch(() => {}),
      ]);
    }

    if (
      err instanceof AuthRequiredError ||
      err instanceof AsrConfigRequiredError ||
      err instanceof PipelineExecutionError
    ) {
      throw err;
    }

    if (job.timedOut && job.signal.reason instanceof PipelineExecutionError) {
      job.signal.reason.details = {
        ...job.signal.reason.details,
        resumable_cache_preserved: Boolean(paths?.cacheDir && fs.existsSync(paths.cacheDir)),
      };
      throw job.signal.reason;
    }

    const elapsedSec = roundSec((Date.now() - job.startedAt) / 1000, 1);
    throw new PipelineExecutionError(
      'EXECUTION_ERROR',
      err?.message || String(err),
      {
        failed_stage: job.stage,
        stage_detail: job.stageDetail || undefined,
        elapsed_sec: elapsedSec,
        resumable_cache_preserved: Boolean(paths?.cacheDir && fs.existsSync(paths.cacheDir)),
      }
    );
  } finally {
    // Clean temporary cache/ ONLY after the full bundle succeeds (when keep_video_cache is false)
    if (succeeded && !keepVideoCache && paths?.cacheDir) {
      await fs.promises.rm(paths.cacheDir, { recursive: true, force: true }).catch(() => {});
    }
  }
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
    completed: true,
    bundle_id: manifest.bundle_id,
    platform: manifest.platform,
    video_id: manifest.video_id,
    part: manifest.part,
    multi_part_notice: manifest.multi_part_notice || undefined,
    title: manifest.title,
    author: manifest.author,
    duration_sec: manifest.duration_sec,
    orientation: manifest.orientation || 'landscape',
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
