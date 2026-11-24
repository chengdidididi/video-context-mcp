import fs from 'node:fs';
import path from 'node:path';
import { getTimeoutMs, resolveBinary } from '../config.js';
import { mapWithConcurrency, runCommand } from '../utils/exec.js';
import { formatSlugTimestamp, roundSec } from '../utils/time.js';

/**
 * Probe audio stream metadata and total duration via ffprobe.
 * Returns null if the media container physically has no audio stream (e.g. silent screen recording).
 */
export async function probeAudioStream(mediaPath) {
  const ffprobe = resolveBinary('ffprobe');
  const args = [
    '-v',
    'error',
    '-select_streams',
    'a:0',
    '-show_entries',
    'stream=codec_name,sample_rate,channels:format=duration',
    '-of',
    'json',
    mediaPath,
  ];

  const { stdout } = await runCommand(ffprobe, args, { timeoutMs: 20_000 });
  const parsed = JSON.parse(stdout);
  const stream = parsed.streams?.[0];
  const format = parsed.format || {};

  if (!stream) {
    return null;
  }

  return {
    codec: stream.codec_name || 'unknown',
    sampleRate: Number(stream.sample_rate || 0),
    channels: Number(stream.channels || 0),
    durationSec: Number(format.duration || 0),
  };
}

/**
 * Automatically select optimal chunking granularity based on whether the chosen ASR provider
 * natively returns sub-chunk sentence timestamps (`cloudflare`, or `verbose_json`/`srt`/`vtt` transcriptions)
 * vs plain text (`mimo`, or standard `json` transcriptions like SenseVoiceSmall).
 */
export function resolveAdaptiveChunkSpec(providerCfg = {}, userChunkOverrides = {}) {
  const protocol = String(providerCfg.protocol || '').trim().toLowerCase();
  const respFmt = String(providerCfg.response_format || '').trim().toLowerCase();

  const hasNativeSubSegments =
    protocol === 'cloudflare' ||
    (protocol === 'openai-transcriptions' && ['verbose_json', 'srt', 'vtt'].includes(respFmt));

  const defaults = hasNativeSubSegments
    ? {
        tier: 'long_native_segments',
        target_chunk_sec: 75,
        max_chunk_sec: 90,
        min_chunk_sec: 8,
        silence_noise_db: -28,
        silence_min_duration_sec: 0.25,
        skip_silence_sec: 3.5,
      }
    : {
        tier: 'short_chunk_anchored',
        target_chunk_sec: 20,
        max_chunk_sec: 26,
        min_chunk_sec: 4,
        silence_noise_db: -28,
        silence_min_duration_sec: 0.25,
        skip_silence_sec: 3.5,
      };

  return {
    ...defaults,
    ...(userChunkOverrides || {}),
  };
}

/**
 * Normalize raw audio/video container into compact speech-ready mono 16kHz MP3 (or WAV).
 */
export async function normalizeAudioForAsr(sourceMediaPath, cacheDir, audioCfg = {}) {
  await fs.promises.mkdir(cacheDir, { recursive: true });
  const sampleRate = Number(audioCfg.sample_rate || 16000);
  const channels = Number(audioCfg.channels || 1);
  const codec = String(audioCfg.codec || 'mp3').toLowerCase() === 'wav' ? 'wav' : 'mp3';
  const bitrate = String(audioCfg.bitrate || '32k');

  const fileName = `normalized_${sampleRate}hz_${channels}ch_${codec === 'wav' ? 'pcm' : bitrate}.${codec}`;
  const outPath = path.join(cacheDir, fileName);

  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 512) {
    const probe = await probeAudioStream(outPath);
    if (probe) {
      return {
        normalizedPath: outPath,
        durationSec: probe.durationSec,
        codec,
        mimeType: codec === 'wav' ? 'audio/wav' : 'audio/mpeg',
        sizeBytes: fs.statSync(outPath).size,
      };
    }
  }

  const ffmpeg = resolveBinary('ffmpeg');
  const codecArgs =
    codec === 'wav'
      ? ['-c:a', 'pcm_s16le']
      : ['-c:a', 'libmp3lame', '-b:a', bitrate];

  const args = [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    sourceMediaPath,
    '-vn',
    '-ac',
    String(channels),
    '-ar',
    String(sampleRate),
    ...codecArgs,
    outPath,
  ];

  await runCommand(ffmpeg, args, { timeoutMs: getTimeoutMs() });
  const probe = await probeAudioStream(outPath);
  if (!probe) {
    throw new Error(`Normalized audio file produced no readable audio stream: ${outPath}`);
  }

  return {
    normalizedPath: outPath,
    durationSec: probe.durationSec,
    codec,
    mimeType: codec === 'wav' ? 'audio/wav' : 'audio/mpeg',
    sizeBytes: fs.statSync(outPath).size,
  };
}

/**
 * Detect speech pause intervals using vocal-bandpass (200Hz–3000Hz) + silencedetect
 * so heavy bass BGM or high-frequency hiss does not mask natural speaker breaths.
 */
export async function detectSilenceIntervals(audioPath, durationSec, chunkSpec = {}) {
  const ffmpeg = resolveBinary('ffmpeg');
  const noiseDb = Number(chunkSpec.silence_noise_db ?? -28);
  const minSilenceDur = Math.max(0.15, Number(chunkSpec.silence_min_duration_sec ?? 0.25));

  const args = [
    '-nostdin',
    '-hide_banner',
    '-i',
    audioPath,
    '-af',
    `highpass=f=200,lowpass=f=3000,silencedetect=noise=${noiseDb}dB:d=${minSilenceDur}`,
    '-f',
    'null',
    '-',
  ];

  const { stderr } = await runCommand(ffmpeg, args, {
    timeoutMs: getTimeoutMs(),
    allowNonZero: true,
  });

  const silences = [];
  let pendingStart = null;
  const startRegex = /silence_start:\s*(-?\d+(?:\.\d+)?)/;
  const endRegex = /silence_end:\s*(-?\d+(?:\.\d+)?)/;

  for (const line of stderr.split(/\r?\n/)) {
    const mStart = line.match(startRegex);
    if (mStart) {
      pendingStart = Math.max(0, parseFloat(mStart[1]));
      continue;
    }
    const mEnd = line.match(endRegex);
    if (mEnd && pendingStart !== null) {
      const end = Math.max(pendingStart, parseFloat(mEnd[1]));
      silences.push({
        start: roundSec(pendingStart, 3),
        end: roundSec(end, 3),
        duration: roundSec(end - pendingStart, 3),
      });
      pendingStart = null;
    }
  }

  if (pendingStart !== null && durationSec > pendingStart) {
    silences.push({
      start: roundSec(pendingStart, 3),
      end: roundSec(durationSec, 3),
      duration: roundSec(durationSec - pendingStart, 3),
    });
  }

  return silences;
}

/**
 * Plan speech-aware audio chunks using natural pause midpoints.
 */
export function planSpeechChunks(durationSec, silences = [], chunkSpec = {}) {
  const totalSec = Math.max(0, Number(durationSec || 0));
  if (totalSec <= 0.1) return [];

  const targetSec = Math.max(5, Number(chunkSpec.target_chunk_sec || 20));
  const maxSec = Math.max(targetSec, Number(chunkSpec.max_chunk_sec || 26));
  const minSec = Math.min(targetSec * 0.6, Math.max(1.5, Number(chunkSpec.min_chunk_sec || 4)));
  const skipSilenceSec = Math.max(2.0, Number(chunkSpec.skip_silence_sec || 3.5));
  const padSec = 0.15;

  const longSilences = silences.filter((s) => s.duration >= skipSilenceSec);
  const islands = [];
  let cursor = 0;

  for (const ls of longSilences) {
    if (ls.start - cursor >= 0.4) {
      islands.push({
        start: Math.max(0, cursor - padSec),
        end: Math.min(totalSec, ls.start + padSec),
      });
    }
    cursor = ls.end;
  }
  if (totalSec - cursor >= 0.4) {
    islands.push({
      start: Math.max(0, cursor > 0 ? cursor - padSec : 0),
      end: totalSec,
    });
  }

  if (islands.length === 0) {
    islands.push({ start: 0, end: totalSec });
  }

  const rawChunks = [];
  for (const island of islands) {
    let pos = island.start;
    while (island.end - pos > maxSec) {
      const windowMin = pos + minSec;
      const windowMax = pos + maxSec;
      const idealCut = pos + targetSec;

      const candidates = [];
      for (const s of silences) {
        const mid = (s.start + s.end) / 2;
        if (mid >= windowMin && mid <= windowMax) {
          const distScore = Math.abs(mid - idealCut) - Math.min(1.5, s.duration) * 1.5;
          candidates.push({ mid, distScore });
        } else if (s.start <= idealCut && s.end >= windowMin) {
          const clamped = Math.min(windowMax, Math.max(windowMin, idealCut));
          candidates.push({ mid: clamped, distScore: 0 });
        }
      }

      let cutAt;
      let splitReason;
      if (candidates.length > 0) {
        candidates.sort((a, b) => a.distScore - b.distScore);
        cutAt = candidates[0].mid;
        splitReason = 'silence';
      } else {
        cutAt = Math.min(island.end, pos + targetSec);
        splitReason = 'hard_cap';
      }

      rawChunks.push({
        startSec: roundSec(pos, 3),
        endSec: roundSec(cutAt, 3),
        durationSec: roundSec(cutAt - pos, 3),
        splitReason,
      });
      pos = cutAt;
    }

    const rem = island.end - pos;
    if (rem >= 0.35) {
      const prev = rawChunks[rawChunks.length - 1];
      if (
        prev &&
        rem < minSec &&
        Math.abs(pos - prev.endSec) < 0.05 &&
        prev.durationSec + rem <= maxSec + 3.0
      ) {
        prev.endSec = roundSec(island.end, 3);
        prev.durationSec = roundSec(prev.endSec - prev.startSec, 3);
      } else {
        rawChunks.push({
          startSec: roundSec(pos, 3),
          endSec: roundSec(island.end, 3),
          durationSec: roundSec(rem, 3),
          splitReason: 'island_end',
        });
      }
    }
  }

  return rawChunks.map((c, idx) => ({
    index: idx + 1,
    ...c,
  }));
}

/**
 * Normalize and slice audio into self-contained speech chunks inside cache/asr_chunks/.
 */
export async function prepareAudioChunks(sourceMediaPath, cacheDir, asrConfig, providerCfg) {
  const audioCfg = asrConfig.audio || {};
  const chunkSpec = resolveAdaptiveChunkSpec(providerCfg, asrConfig.chunking);

  const norm = await normalizeAudioForAsr(sourceMediaPath, cacheDir, audioCfg);
  const maxDur = Number(asrConfig.max_duration_sec || 7200);
  if (norm.durationSec > maxDur) {
    throw new Error(
      `Audio duration (${Math.round(norm.durationSec)}s) exceeds asr.max_duration_sec (${maxDur}s). Increase asr.max_duration_sec in config.yaml if intended.`
    );
  }

  const chunksDir = path.join(cacheDir, 'asr_chunks');
  await fs.promises.rm(chunksDir, { recursive: true, force: true });
  await fs.promises.mkdir(chunksDir, { recursive: true });

  const silences = await detectSilenceIntervals(norm.normalizedPath, norm.durationSec, chunkSpec);
  const planned = planSpeechChunks(norm.durationSec, silences, chunkSpec);

  const ffmpeg = resolveBinary('ffmpeg');
  const sampleRate = Number(audioCfg.sample_rate || 16000);
  const channels = Number(audioCfg.channels || 1);
  const bitrate = String(audioCfg.bitrate || '32k');
  const codecArgs =
    norm.codec === 'wav'
      ? ['-c:a', 'pcm_s16le']
      : ['-c:a', 'libmp3lame', '-b:a', bitrate];

  const materialized = await mapWithConcurrency(planned, 6, async (chunk) => {
    const slug = `${formatSlugTimestamp(chunk.startSec)}-${formatSlugTimestamp(chunk.endSec)}`;
    const fileName = `chunk_${String(chunk.index).padStart(4, '0')}_${slug}.${norm.codec}`;
    const filePath = path.join(chunksDir, fileName);

    const args = [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      String(chunk.startSec),
      '-t',
      String(chunk.durationSec),
      '-i',
      norm.normalizedPath,
      '-vn',
      '-ac',
      String(channels),
      '-ar',
      String(sampleRate),
      ...codecArgs,
      filePath,
    ];

    await runCommand(ffmpeg, args, { timeoutMs: 30_000 });
    const sizeBytes = fs.statSync(filePath).size;

    return {
      ...chunk,
      fileName,
      filePath,
      sizeBytes,
      codec: norm.codec,
      mimeType: norm.mimeType,
    };
  });

  return {
    normalizedAudioPath: norm.normalizedPath,
    normalizedSizeBytes: norm.sizeBytes,
    durationSec: norm.durationSec,
    chunkTier: chunkSpec.tier,
    chunks: materialized,
  };
}
