import fs from 'node:fs';
import path from 'node:path';
import { getTimeoutMs, resolveBinary } from '../config.js';
import { parseVttOrSrt, parseYoutubeJson3 } from '../parsers/subtitles.js';
import { runCommand } from '../utils/exec.js';
import { fetchWithContext } from '../utils/http.js';

function buildBaseYtDlpArgs(platform, cookieFilePath) {
  const args = [
    '--no-playlist',
    '--no-warnings',
  ];

  // Never override yt-dlp's native per-client User-Agent (e.g. YouTube VisionOS/TV clients or Bilibili curl-impersonate),
  // otherwise signed CDN stream URLs can 403 due to UA mismatch.
  if (cookieFilePath && fs.existsSync(cookieFilePath)) {
    const stat = fs.statSync(cookieFilePath);
    if (stat.size > 0) {
      args.push('--cookies', cookieFilePath);
    }
  }

  return args;
}

/**
 * Dump metadata JSON via yt-dlp --dump-single-json
 */
export async function dumpYtDlpInfo(platform, canonicalUrl, cookieFilePath) {
  const ytdlp = resolveBinary('yt-dlp');
  const args = [
    ...buildBaseYtDlpArgs(platform, cookieFilePath),
    '--dump-single-json',
    canonicalUrl,
  ];
  const { stdout } = await runCommand(ytdlp, args, { timeoutMs: getTimeoutMs() });
  return JSON.parse(stdout);
}

/**
 * Extract best subtitle track & segments from yt-dlp info JSON (with CLI --write-subs fallback if direct fetch 429s).
 */
export async function extractSubtitlesFromYtDlpInfo(info, platform, canonicalUrl, cookieFilePath, tempDir) {
  const manualSubs = info.subtitles || {};
  const autoSubs = info.automatic_captions || {};
  const origLang = info.language || '';

  const rankTracks = (subDict, isAuto) => {
    const langs = Object.keys(subDict).filter(
      (k) => k !== 'danmaku' && k !== 'live_chat' && Array.isArray(subDict[k]) && subDict[k].length > 0
    );
    if (langs.length === 0) return [];

    // For auto-captions, ALWAYS prioritize original ASR track (*-orig / origLang) over YouTube machine translations (&tlang=),
    // which frequently HTTP 429 without cookies and degrade proper nouns!
    const priorities = isAuto
      ? [
          /-orig$/i,
          origLang ? new RegExp(`^${escapeRegExp(origLang)}$`, 'i') : null,
          origLang ? new RegExp(`^${escapeRegExp(origLang.split('-')[0])}$`, 'i') : null,
          /^zh-(Hans|CN)$/i,
          /^zh$/i,
          /^en(-US|-GB)?$/i,
          /^en/i,
        ].filter(Boolean)
      : [
          /^zh-(Hans|CN)$/i,
          /^zh$/i,
          /^zh-(Hant|TW|HK)$/i,
          origLang ? new RegExp(`^${escapeRegExp(origLang)}$`, 'i') : null,
          origLang ? new RegExp(`^${escapeRegExp(origLang.split('-')[0])}`, 'i') : null,
          /^en(-US|-GB)?$/i,
          /^en/i,
        ].filter(Boolean);

    const ordered = [];
    const seen = new Set();
    for (const regex of priorities) {
      for (const l of langs) {
        if (!seen.has(l) && regex.test(l)) {
          seen.add(l);
          ordered.push({ lang: l, formats: subDict[l], isAuto });
        }
      }
    }
    if (!isAuto && ordered.length === 0 && langs[0]) {
      ordered.push({ lang: langs[0], formats: subDict[langs[0]], isAuto });
    }
    return ordered;
  };

  const candidates = [...rankTracks(manualSubs, false), ...rankTracks(autoSubs, true)];
  if (candidates.length === 0) {
    return { subtitleTrack: null, segments: [] };
  }

  // Try candidate tracks in priority order via direct fetch first
  for (const selected of candidates.slice(0, 3)) {
    const json3Fmt = selected.formats.find((f) => f.ext === 'json3' && f.url && !f.url.includes('tlang='));
    const vttFmt = selected.formats.find((f) => f.ext === 'vtt' && f.url && !f.url.includes('tlang='));
    const anyJson3 = selected.formats.find((f) => f.ext === 'json3' && f.url);
    const anyVtt = selected.formats.find((f) => f.ext === 'vtt' && f.url);
    const srtFmt = selected.formats.find((f) => f.ext === 'srt' && f.url);
    const targetFmt = json3Fmt || vttFmt || anyJson3 || anyVtt || srtFmt || selected.formats.find((f) => f.url);

    if (targetFmt?.url) {
      try {
        const res = await fetchWithContext(targetFmt.url, { platform });
        if (res.ok) {
          const rawText = await res.text();
          const segments =
            targetFmt.ext === 'json3' || rawText.trim().startsWith('{')
              ? parseYoutubeJson3(rawText)
              : parseVttOrSrt(rawText);

          if (segments.length > 0) {
            return {
              subtitleTrack: {
                language: selected.lang,
                label: targetFmt.name || selected.lang,
                source_type: selected.isAuto ? 'auto' : 'manual',
              },
              segments,
            };
          }
        }
      } catch {
        // try next candidate or CLI fallback
      }
    }
  }

  const selected = candidates[0];

  // Fallback: invoke yt-dlp to write the single selected subtitle track
  await fs.promises.mkdir(tempDir, { recursive: true });
  const outTpl = path.join(tempDir, 'sub_dl');
  const ytdlp = resolveBinary('yt-dlp');
  const args = [
    ...buildBaseYtDlpArgs(platform, cookieFilePath),
    '--skip-download',
    selected.isAuto ? '--write-auto-subs' : '--write-subs',
    '--sub-langs',
    selected.lang,
    '--sub-format',
    'json3/vtt/srt/best',
    '-o',
    outTpl,
    canonicalUrl,
  ];

  try {
    await runCommand(ytdlp, args, { timeoutMs: getTimeoutMs() });
    const files = await fs.promises.readdir(tempDir);
    const subFile = files.find((f) => f.startsWith('sub_dl.') && /\.(json3|vtt|srt)$/i.test(f));
    if (subFile) {
      const fullPath = path.join(tempDir, subFile);
      const rawText = await fs.promises.readFile(fullPath, 'utf8');
      const segments = subFile.endsWith('.json3')
        ? parseYoutubeJson3(rawText)
        : parseVttOrSrt(rawText);
      return {
        subtitleTrack: {
          language: selected.lang,
          label: selected.lang,
          source_type: selected.isAuto ? 'auto' : 'manual',
        },
        segments,
      };
    }
  } catch {
    // No subtitle could be retrieved
  }

  return { subtitleTrack: null, segments: [] };
}

/**
 * Fallback CLI selector when info.formats is unavailable:
 * Strictly prefer 360p-480p <=35fps direct HTTP/HTTPS video-only streams before falling back to 720p or HLS.
 */
export const VIDEO_FORMAT_SELECTOR = [
  'bv*[height>=360][height<=480][fps<=35][protocol^=http]',
  'bv*[width>=360][width<=480][fps<=35][protocol^=http]',
  'bv*[height>=360][height<=480][fps<=35]',
  'b[height>=360][height<=480][fps<=35][protocol^=http]',
  'bv*[height<=720][fps<=35][protocol^=http]',
  'bv*[width<=720][fps<=35][protocol^=http]',
  'bv*[height<=720][protocol^=http]',
  'bv*[height<=720]',
  'b[height<=720]',
  'bv*',
  'b',
].join('/');

/**
 * Pick the optimal compact video format_id directly from yt-dlp info.formats:
 *  1. Resolution sweet-spot: short side in [targetShortSide, 480] (360p/480p matches 640x360 cells with zero wasted pixels)
 *  2. Direct HTTP/HTTPS DASH over bloated HLS m3u8 segments (e.g. avoids 359MB 360p m3u8 vs 77MB HTTPS DASH)
 *  3. <=35fps over 60fps (halves download bytes & FFmpeg decode CPU)
 *  4. Video-only over audio-muxed, sorted by smallest byte size (with slight preference for fast-decoding H.264/VP9).
 */
export function selectOptimalYtDlpFormat(info, targetShortSide = 360) {
  const formats = Array.isArray(info?.formats) ? info.formats : [];
  const durationSec = Math.max(10, Number(info?.duration || 300));
  const idealMin = Math.max(240, Number(targetShortSide) || 360);
  const idealMax = Math.max(480, idealMin);

  const videoFormats = formats.filter(
    (f) =>
      f &&
      f.format_id &&
      f.vcodec &&
      f.vcodec !== 'none' &&
      !String(f.format_id).startsWith('sb') &&
      f.ext !== 'mhtml'
  );

  if (videoFormats.length === 0) return null;

  const scored = videoFormats.map((f) => {
    const w = Number(f.width || 0);
    const h = Number(f.height || 0);
    const shortSide = w > 0 && h > 0 ? Math.min(w, h) : h || w || 0;

    let resRank = 4;
    if (shortSide >= idealMin && shortSide <= idealMax) resRank = 0;
    else if (shortSide > idealMax && shortSide <= 720) resRank = 1;
    else if (shortSide >= 240 && shortSide < idealMin) resRank = 2;
    else if (shortSide > 720 && shortSide <= 1080) resRank = 3;

    const proto = String(f.protocol || '');
    const protoRank = /^https?$/i.test(proto) ? 0 : 1;

    const fps = Number(f.fps || 0);
    const fpsRank = !fps || fps <= 35 ? 0 : 1;

    const isVideoOnly = !f.acodec || f.acodec === 'none';
    const muxRank = isVideoOnly ? 0 : 1;

    const rawBytes =
      Number(f.filesize || f.filesize_approx || 0) ||
      Number(f.vbr || f.tbr || 800) * 125 * durationSec;
    const vcodec = String(f.vcodec || '').toLowerCase();
    // Prefer H.264 (avc1) when within ~15% size of VP9/HEVC and ~35% of AV1 for 3x faster FFmpeg decode
    const codecPenalty = vcodec.startsWith('av01')
      ? 1.35
      : vcodec.startsWith('avc') || vcodec.startsWith('h264')
        ? 1.0
        : 1.15;
    const weightedBytes = rawBytes * codecPenalty;

    return {
      formatId: String(f.format_id),
      shortSide,
      fps,
      proto,
      rawBytes,
      resRank,
      protoRank,
      fpsRank,
      muxRank,
      weightedBytes,
    };
  });

  scored.sort(
    (a, b) =>
      a.resRank - b.resRank ||
      a.protoRank - b.protoRank ||
      a.fpsRank - b.fpsRank ||
      a.muxRank - b.muxRank ||
      a.weightedBytes - b.weightedBytes
  );

  return scored[0];
}

/**
 * Download compact pure video stream into cache/ (reuses existing cached file or pre-fetched info JSON).
 */
export async function ensureCachedVideoStream({
  platform,
  canonicalUrl,
  cacheDir,
  cookieFilePath,
  info = null,
  targetShortSide = 360,
}) {
  await fs.promises.mkdir(cacheDir, { recursive: true });
  const prefix = 'source_video';

  const findCompletedFile = async () => {
    const files = await fs.promises.readdir(cacheDir);
    const match = files.find(
      (f) => f.startsWith(`${prefix}.`) && !f.endsWith('.part') && !f.endsWith('.ytdl')
    );
    if (!match) return null;
    const full = path.join(cacheDir, match);
    const stat = await fs.promises.stat(full);
    return stat.size > 1024 ? full : null;
  };

  const existing = await findCompletedFile();
  if (existing) return existing;

  const ytdlp = resolveBinary('yt-dlp');
  const outTemplate = path.join(cacheDir, `${prefix}.%(ext)s`);
  const picked = info ? selectOptimalYtDlpFormat(info, targetShortSide) : null;
  const formatArg = picked ? `${picked.formatId}/${VIDEO_FORMAT_SELECTOR}` : VIDEO_FORMAT_SELECTOR;

  if (picked) {
    const mb = picked.rawBytes ? `${(picked.rawBytes / 1048576).toFixed(1)}MB` : 'est';
    console.error(
      `[video-context] Selected format ${picked.formatId} (${picked.shortSide}p${picked.fps ? `@${picked.fps}fps` : ''}, ${picked.proto}, ~${mb})`
    );
  }

  const speedArgs = ['--concurrent-fragments', '4', '--http-chunk-size', '10M'];

  // Fast path: reuse already-dumped info JSON to skip duplicate webpage + Deno JS challenge solve (~7s saved)
  if (info && info.id) {
    const infoJsonPath = path.join(cacheDir, 'ytdlp_info.json');
    try {
      await fs.promises.writeFile(infoJsonPath, JSON.stringify(info), 'utf8');
      const fastArgs = [
        ...buildBaseYtDlpArgs(platform, cookieFilePath),
        ...speedArgs,
        '--load-info-json',
        infoJsonPath,
        '-f',
        picked ? picked.formatId : VIDEO_FORMAT_SELECTOR,
        '-o',
        outTemplate,
      ];
      await runCommand(ytdlp, fastArgs, { timeoutMs: getTimeoutMs() });
      const downloadedFast = await findCompletedFile();
      if (downloadedFast) return downloadedFast;
    } catch (err) {
      console.error(
        `[video-context] Fast info-json download fallback (${err.message.split('\n')[0]}); retrying direct URL...`
      );
    } finally {
      await fs.promises.rm(infoJsonPath, { force: true });
    }
  }

  const args = [
    ...buildBaseYtDlpArgs(platform, cookieFilePath),
    ...speedArgs,
    '-f',
    formatArg,
    '-o',
    outTemplate,
    canonicalUrl,
  ];

  await runCommand(ytdlp, args, { timeoutMs: getTimeoutMs() });

  const downloaded = await findCompletedFile();
  if (!downloaded) {
    throw new Error(`yt-dlp completed without producing video file in ${cacheDir}`);
  }
  return downloaded;
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
