import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { getEnhancedEnv, getGridSpec, getTimeoutMs, resolveBinary } from '../config.js';
import { mapWithConcurrency, runCommand } from '../utils/exec.js';

/**
 * Probe video & audio stream presence, dimensions, fps, codec, and duration via ffprobe.
 */
export async function probeVideo(videoPath, signal = null) {
  const ffprobe = resolveBinary('ffprobe');
  const args = [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_type,width,height,codec_name,avg_frame_rate,r_frame_rate:format=duration',
    '-of',
    'json',
    videoPath,
  ];

  const { stdout } = await runCommand(ffprobe, args, { timeoutMs: getTimeoutMs(), signal });
  const parsed = JSON.parse(stdout);
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const vStream = streams.find((s) => s.codec_type === 'video') || {};
  const aStream = streams.find((s) => s.codec_type === 'audio') || null;
  const format = parsed.format || {};

  const parseRate = (rateStr) => {
    if (!rateStr || typeof rateStr !== 'string') return 0;
    if (rateStr.includes('/')) {
      const [num, den] = rateStr.split('/').map(Number);
      return den > 0 ? num / den : 0;
    }
    return Number(rateStr) || 0;
  };

  const fps = parseRate(vStream.avg_frame_rate) || parseRate(vStream.r_frame_rate) || 0;

  return {
    hasVideo: Boolean(vStream.codec_type === 'video'),
    hasAudio: Boolean(aStream),
    width: Number(vStream.width || 0),
    height: Number(vStream.height || 0),
    fps,
    codec: vStream.codec_name || 'unknown',
    audioCodec: aStream?.codec_name || null,
    durationSec: Number(format.duration || 0),
  };
}

/**
 * Compress an uploaded/local video file into a standardized 360p@<=30fps pure video stream inside cache/
 * (never mutating or deleting the user's original local video file), matching the online cached stream pipeline.
 */
export async function transcodeLocalVideoToCompactCache(
  localVideoPath,
  cacheDir,
  { targetShortSide = 360, maxFps = 30, timeoutMs = getTimeoutMs(), signal = null } = {}
) {
  await fs.promises.mkdir(cacheDir, { recursive: true });
  const outPath = path.join(cacheDir, 'source_video.mp4');

  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1024) {
    return outPath;
  }

  const probe = await probeVideo(localVideoPath, signal);
  if (!probe.hasVideo) {
    throw new Error(`Local file does not contain a valid video stream: "${localVideoPath}"`);
  }

  const ffmpeg = resolveBinary('ffmpeg');
  const capSide = Math.max(240, Number(targetShortSide) || 360);
  const filters = [];
  if (probe.fps > maxFps + 0.5) {
    filters.push(`fps=${maxFps}`);
  }
  // Scale short side down to 360p (preserving aspect ratio, even dimensions, no upscaling)
  filters.push(
    `scale='if(gt(iw,ih),-2,min(iw,${capSide}))':'if(gt(iw,ih),min(ih,${capSide}),-2)':flags=bicubic`
  );

  const partPath = `${outPath}.part.mp4`;
  const args = [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-threads',
    '0',
    '-y',
    '-i',
    localVideoPath,
    '-vf',
    filters.join(','),
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    partPath,
  ];

  await runCommand(ffmpeg, args, { timeoutMs, signal });
  await fs.promises.rename(partPath, outPath);
  return outPath;
}

/**
 * Single-pass multi-threaded FFmpeg streaming pipeline:
 * Decodes the video ONCE at `probeFps` into Lanczos-scaled `cellWidth x cellHeight` RGB24 frames over stdout pipe,
 * computes an anti-aliased `160x90` luma buffer in-memory (~0.04ms/frame) for Two-Gate tracking,
 * and compresses ONLY emitted candidate frames into compact in-memory JPEG buffers (~35KB each) via Sharp.
 * Eliminates 180 separate `ffmpeg -ss` process spawns and all temporary frame disk I/O.
 */
export function scanSinglePassVideoStream(
  videoPath,
  tracker,
  {
    probeFps = 2.5,
    cellWidth,
    cellHeight,
    probeWidth = 160,
    probeHeight = 90,
    timeoutMs = getTimeoutMs(),
    signal = null,
  } = {}
) {
  const ffmpeg = resolveBinary('ffmpeg');
  const gridSpec = getGridSpec();
  const targetW = cellWidth || gridSpec.cellWidth;
  const targetH = cellHeight || gridSpec.cellHeight;
  const frameBytes = targetW * targetH * 3;
  const safeFps = Math.min(10, Math.max(0.5, Number(probeFps) || 2.5));

  // Precompute 2-sample diagonal RGB byte offsets per probeWidth x probeHeight luma pixel for ~0.04ms/frame downsampling
  const probePixels = probeWidth * probeHeight;
  const offsetsA = new Uint32Array(probePixels);
  const offsetsB = new Uint32Array(probePixels);
  let pIdx = 0;
  for (let py = 0; py < probeHeight; py++) {
    const syA = Math.min(targetH - 1, Math.floor(((py + 0.25) * targetH) / probeHeight));
    const syB = Math.min(targetH - 1, Math.floor(((py + 0.75) * targetH) / probeHeight));
    for (let px = 0; px < probeWidth; px++) {
      const sxA = Math.min(targetW - 1, Math.floor(((px + 0.25) * targetW) / probeWidth));
      const sxB = Math.min(targetW - 1, Math.floor(((px + 0.75) * targetW) / probeWidth));
      offsetsA[pIdx] = (syA * targetW + sxA) * 3;
      offsetsB[pIdx] = (syB * targetW + sxB) * 3;
      pIdx++;
    }
  }
  const grayScratch = Buffer.allocUnsafe(probePixels);

  const vf = `fps=${safeFps},scale=${targetW}:${targetH}:flags=bicubic:force_original_aspect_ratio=decrease,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2:black`;
  const args = [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-threads',
    '0',
    '-i',
    videoPath,
    '-vf',
    vf,
    '-pix_fmt',
    'rgb24',
    '-an',
    '-f',
    'rawvideo',
    'pipe:1',
  ];

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error('Single-pass video stream aborted before start'));
      return;
    }

    const child = spawn(ffmpeg, args, {
      env: getEnhancedEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let leftover = Buffer.alloc(0);
    let frameIndex = 0;
    const stderrChunks = [];
    let timedOut = false;
    let abortedExternally = false;

    const onExternalAbort = () => {
      abortedExternally = true;
      child.kill('SIGKILL');
    };
    if (signal) {
      signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, timeoutMs)
        : null;

    child.stdout.on('data', (chunk) => {
      const combined = leftover.length > 0 ? Buffer.concat([leftover, chunk]) : chunk;
      let offset = 0;
      while (offset + frameBytes <= combined.length) {
        const rgbSlice = combined.subarray(offset, offset + frameBytes);
        for (let i = 0; i < probePixels; i++) {
          const o1 = offsetsA[i];
          const o2 = offsetsB[i];
          const y1 = (77 * rgbSlice[o1] + 150 * rgbSlice[o1 + 1] + 29 * rgbSlice[o1 + 2]) >> 8;
          const y2 = (77 * rgbSlice[o2] + 150 * rgbSlice[o2 + 1] + 29 * rgbSlice[o2 + 2]) >> 8;
          grayScratch[i] = (y1 + y2) >> 1;
        }
        tracker.pushFrame(grayScratch, frameIndex, frameIndex / safeFps, rgbSlice);
        frameIndex++;
        offset += frameBytes;
      }
      leftover = offset < combined.length ? Buffer.from(combined.subarray(offset)) : Buffer.alloc(0);
    });

    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onExternalAbort);
      reject(err);
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onExternalAbort);

      if (abortedExternally) {
        reject(signal?.reason || new Error('Single-pass video stream interrupted by pipeline abort'));
        return;
      }
      if (timedOut) {
        reject(new Error(`Single-pass video stream timed out after ${Math.round(timeoutMs / 1000)}s`));
        return;
      }
      if (code !== 0 && frameIndex === 0) {
        const errText = Buffer.concat(stderrChunks).toString('utf8').trim();
        reject(new Error(`FFmpeg single-pass stream failed (exit ${code}): ${errText}`));
        return;
      }
      resolve({ scannedFrames: frameIndex, cellWidth: targetW, cellHeight: targetH });
    });
  });
}

export function encodeRgbCandidateToJpeg(rgbBuffer, width, height, quality = 88) {
  if (!rgbBuffer) return Promise.resolve(null);
  return sharp(rgbBuffer, {
    raw: { width, height, channels: 3 },
  })
    .jpeg({ quality })
    .toBuffer();
}

/**
 * Stream ultra-lightweight 160x90 single-channel grayscale rawvideo frames over memory pipe (O(1) RAM),
 * invoking `onFrame(frameBuffer, frameIndex, timestampSec)` for every probed instant.
 */
export function scanGrayscaleProbeStream(
  videoPath,
  onFrame,
  { probeFps = 2.5, width = 160, height = 90, timeoutMs = getTimeoutMs() } = {}
) {
  const ffmpeg = resolveBinary('ffmpeg');
  const frameBytes = width * height;
  const safeFps = Math.min(10, Math.max(0.5, Number(probeFps) || 2.5));

  const args = [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    videoPath,
    '-vf',
    `fps=${safeFps},scale=${width}:${height}:flags=area`,
    '-pix_fmt',
    'gray',
    '-an',
    '-f',
    'rawvideo',
    'pipe:1',
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, {
      env: getEnhancedEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let leftover = Buffer.alloc(0);
    let frameIndex = 0;
    const stderrChunks = [];
    let timedOut = false;

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, timeoutMs)
        : null;

    child.stdout.on('data', (chunk) => {
      const combined = leftover.length > 0 ? Buffer.concat([leftover, chunk]) : chunk;
      let offset = 0;
      while (offset + frameBytes <= combined.length) {
        const frameSlice = combined.subarray(offset, offset + frameBytes);
        onFrame(frameSlice, frameIndex, frameIndex / safeFps);
        frameIndex++;
        offset += frameBytes;
      }
      leftover = offset < combined.length ? Buffer.from(combined.subarray(offset)) : Buffer.alloc(0);
    });

    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Grayscale probe stream timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0 && frameIndex === 0) {
        const errText = Buffer.concat(stderrChunks).toString('utf8').trim();
        reject(new Error(`FFmpeg probe stream failed (exit ${code}): ${errText}`));
        return;
      }
      resolve({ scannedFrames: frameIndex });
    });
  });
}

/**
 * Extract exact selected timestamps scaled with Lanczos to cellWidth x cellHeight
 * (aspect-ratio preserved with black letterbox/pillarbox).
 */
export async function extractLanczosFrames({
  videoPath,
  samplePoints,
  tempFramesDir,
  cellWidth,
  cellHeight,
  concurrency = Math.min(8, Math.max(4, os.cpus().length)),
  signal = null,
}) {
  const gridSpec = getGridSpec();
  const targetW = cellWidth || gridSpec.cellWidth;
  const targetH = cellHeight || gridSpec.cellHeight;
  await fs.promises.mkdir(tempFramesDir, { recursive: true });
  const ffmpeg = resolveBinary('ffmpeg');

  const vf = `scale=${targetW}:${targetH}:flags=lanczos:force_original_aspect_ratio=decrease,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2:black`;

  return mapWithConcurrency(
    samplePoints,
    concurrency,
    async (pt) => {
      const seekSec = pt.timestampSec;
      const outPath = path.join(
        tempFramesDir,
        `frame_${String(pt.frameNo).padStart(4, '0')}.jpg`
      );

      const attemptExtract = async (ss) => {
        const args = [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-threads',
          '1',
          '-y',
          '-ss',
          String(Math.max(0, ss)),
          '-i',
          videoPath,
          '-frames:v',
          '1',
          '-vf',
          vf,
          '-q:v',
          '2',
          outPath,
        ];
        await runCommand(ffmpeg, args, { timeoutMs: getTimeoutMs(), allowNonZero: true, signal });
        return fs.existsSync(outPath) && fs.statSync(outPath).size > 0;
      };

    let ok = await attemptExtract(seekSec);
    if (!ok && seekSec > 0.25) {
      ok = await attemptExtract(seekSec - 0.3);
    }
    if (!ok) {
      ok = await attemptExtract(0);
    }
    if (!ok) {
      throw new Error(`Failed to extract frame #${pt.frameNo} at ${seekSec}s from ${videoPath}`);
    }

    return {
      ...pt,
      framePath: outPath,
    };
  });
}
