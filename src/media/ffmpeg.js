import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getEnhancedEnv, getGridSpec, resolveBinary } from '../config.js';
import { mapWithConcurrency, runCommand } from '../utils/exec.js';

/**
 * Probe video stream dimensions, codec, and duration via ffprobe.
 */
export async function probeVideo(videoPath) {
  const ffprobe = resolveBinary('ffprobe');
  const args = [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height,codec_name:format=duration',
    '-of',
    'json',
    videoPath,
  ];

  const { stdout } = await runCommand(ffprobe, args, { timeoutMs: 20_000 });
  const parsed = JSON.parse(stdout);
  const stream = parsed.streams?.[0] || {};
  const format = parsed.format || {};

  return {
    width: Number(stream.width || 0),
    height: Number(stream.height || 0),
    codec: stream.codec_name || 'unknown',
    durationSec: Number(format.duration || 0),
  };
}

/**
 * Stream ultra-lightweight 160x90 single-channel grayscale rawvideo frames over memory pipe (O(1) RAM),
 * invoking `onFrame(frameBuffer, frameIndex, timestampSec)` for every probed instant.
 */
export function scanGrayscaleProbeStream(
  videoPath,
  onFrame,
  { probeFps = 2.5, width = 160, height = 90, timeoutMs = 300_000 } = {}
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
  concurrency = 4,
}) {
  const gridSpec = getGridSpec();
  const targetW = cellWidth || gridSpec.cellWidth;
  const targetH = cellHeight || gridSpec.cellHeight;
  await fs.promises.mkdir(tempFramesDir, { recursive: true });
  const ffmpeg = resolveBinary('ffmpeg');

  const vf = `scale=${targetW}:${targetH}:flags=lanczos:force_original_aspect_ratio=decrease,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2:black`;

  return mapWithConcurrency(samplePoints, concurrency, async (pt) => {
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
      await runCommand(ffmpeg, args, { timeoutMs: 30_000, allowNonZero: true });
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
