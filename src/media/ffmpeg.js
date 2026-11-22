import fs from 'node:fs';
import path from 'node:path';
import { getGridSpec, resolveBinary } from '../config.js';
import { mapWithConcurrency, runCommand } from '../utils/exec.js';
import { formatSlugTimestamp, roundSec } from '../utils/time.js';

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
 * Run fast scene-change detection via FFmpeg select='gt(scene,threshold)',showinfo
 */
export async function detectSceneChanges(videoPath, threshold = 0.25) {
  const ffmpeg = resolveBinary('ffmpeg');
  const safeThreshold = Math.min(0.95, Math.max(0.05, Number(threshold) || 0.25));

  const args = [
    '-nostdin',
    '-hide_banner',
    '-i',
    videoPath,
    '-vf',
    `select='gt(scene,${safeThreshold})',showinfo`,
    '-fps_mode',
    'vfr',
    '-an',
    '-f',
    'null',
    '-',
  ];

  const { stderr } = await runCommand(ffmpeg, args, {
    timeoutMs: 240_000,
    allowNonZero: true,
  });

  const timestamps = [];
  const regex = /pts_time:\s*([\d.]+)/g;
  let match;
  while ((match = regex.exec(stderr)) !== null) {
    const ts = parseFloat(match[1]);
    if (Number.isFinite(ts) && ts >= 0) {
      timestamps.push(roundSec(ts, 2));
    }
  }

  return timestamps;
}

/**
 * Extract exact frames scaled with Lanczos to 640x360 (aspect-ratio preserved with black letterbox/pillarbox).
 * `useLocalSec = true` seeks using `pt.localSec` (for sliced clips whose local PTS starts at 0).
 */
export async function extractLanczosFrames({
  videoPath,
  samplePoints,
  tempFramesDir,
  cellWidth,
  cellHeight,
  useLocalSec = false,
  concurrency = 4,
}) {
  const gridSpec = getGridSpec();
  const targetW = cellWidth || gridSpec.cellWidth;
  const targetH = cellHeight || gridSpec.cellHeight;
  await fs.promises.mkdir(tempFramesDir, { recursive: true });
  const ffmpeg = resolveBinary('ffmpeg');

  const vf = `scale=${targetW}:${targetH}:flags=lanczos:force_original_aspect_ratio=decrease,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2:black`;

  return mapWithConcurrency(samplePoints, concurrency, async (pt) => {
    const seekSec = useLocalSec ? pt.localSec ?? 0 : pt.timestampSec;
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
      // Step back slightly if timestamp landed past last video frame near EOF
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

/**
 * Extract original-resolution unscaled clean frames (no header bar, no watermark) for Tier 3 raw_frames mode.
 */
export async function extractRawCleanFrames({
  videoPath,
  samplePoints,
  outDir,
  useLocalSec = false,
  concurrency = 4,
}) {
  await fs.promises.mkdir(outDir, { recursive: true });
  const ffmpeg = resolveBinary('ffmpeg');

  return mapWithConcurrency(samplePoints, concurrency, async (pt) => {
    const seekSec = useLocalSec ? pt.localSec ?? 0 : pt.timestampSec;
    const slug = formatSlugTimestamp(pt.timestampSec);
    const tenths = Math.round((pt.timestampSec % 1) * 10);
    const filename = `raw_${String(pt.frameNo).padStart(3, '0')}_${slug}_${tenths}.jpg`;
    const outPath = path.join(outDir, filename);

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
      throw new Error(`Failed to extract raw frame #${pt.frameNo} at ${seekSec}s`);
    }

    return {
      frame_no: pt.frameNo,
      timestamp_sec: pt.timestampSec,
      file: outPath,
    };
  });
}
