import fs from 'node:fs';
import path from 'node:path';
import { REFERERS, resolveBinary, USER_AGENT } from '../config.js';
import { parseVttOrSrt, parseYoutubeJson3 } from '../parsers/subtitles.js';
import { runCommand } from '../utils/exec.js';
import { downloadFile, fetchWithContext } from '../utils/http.js';
import { roundSec } from '../utils/time.js';

function buildBaseYtDlpArgs(platform, cookieFilePath) {
  const args = [
    '--no-playlist',
    '--no-warnings',
  ];

  // Keep yt-dlp's native curl-impersonate UA on Bilibili; only set custom UA for YouTube if needed
  if (platform !== 'bilibili') {
    args.push('--user-agent', USER_AGENT);
  }

  if (platform && REFERERS[platform]) {
    args.push('--add-header', `Referer:${REFERERS[platform]}`);
  }

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
  const { stdout } = await runCommand(ytdlp, args, { timeoutMs: 90_000 });
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
    await runCommand(ytdlp, args, { timeoutMs: 60_000 });
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
 * Extract YouTube Storyboard sprite sheets from yt-dlp info.formats and download to sprites/
 */
export async function extractYoutubeStoryboards(info, spritesDir) {
  await fs.promises.mkdir(spritesDir, { recursive: true });
  const formats = Array.isArray(info.formats) ? info.formats : [];

  // Storyboard formats have vcodec === 'none' and acodec === 'none' and fragments + rows/columns (e.g. sb0, sb1, sb2)
  const sbFormats = formats
    .filter(
      (f) =>
        (String(f.format_id || '').startsWith('sb') || f.ext === 'mhtml') &&
        Array.isArray(f.fragments) &&
        f.fragments.length > 0 &&
        f.rows &&
        f.columns
    )
    .sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0));

  const bestSb = sbFormats[0];
  if (!bestSb) {
    return { available: false, files: [], index_path: null };
  }

  const rows = bestSb.rows;
  const cols = bestSb.columns;
  const perSheet = rows * cols;
  const maxSheets = Math.min(bestSb.fragments.length, 10);

  const downloadedFiles = [];
  const sheetsMeta = [];
  let cursorSec = 0;

  for (let i = 0; i < maxSheets; i++) {
    const frag = bestSb.fragments[i];
    if (!frag?.url) continue;
    const fragDuration = Number(frag.duration || 0);
    const filename = `sprite_${String(i + 1).padStart(2, '0')}.jpg`;
    const destPath = path.join(spritesDir, filename);

    try {
      await downloadFile(frag.url, destPath, { platform: 'youtube' });
      const tileInterval = perSheet > 0 && fragDuration > 0 ? fragDuration / perSheet : 2.0;
      const sheetTimes = [];
      for (let k = 0; k < perSheet; k++) {
        const t = cursorSec + k * tileInterval;
        if (info.duration && t > info.duration) break;
        sheetTimes.push(roundSec(t, 2));
      }

      downloadedFiles.push(destPath);
      sheetsMeta.push({
        sheet_index: i + 1,
        file: `sprites/${filename}`,
        layout: [rows, cols],
        tile_size: [bestSb.width || 160, bestSb.height || 90],
        start_sec: sheetTimes[0] ?? roundSec(cursorSec, 2),
        end_sec: sheetTimes[sheetTimes.length - 1] ?? roundSec(cursorSec + fragDuration, 2),
        timestamps_sec: sheetTimes,
      });
    } catch {
      // continue on individual sprite error
    }
    cursorSec += fragDuration;
  }

  const indexData = {
    platform: 'youtube',
    format_id: bestSb.format_id,
    available: downloadedFiles.length > 0,
    layout_per_sheet: [rows, cols],
    tile_size: [bestSb.width || 160, bestSb.height || 90],
    sheets: sheetsMeta,
  };

  const indexPath = path.join(spritesDir, 'sprites_index.json');
  await fs.promises.writeFile(indexPath, JSON.stringify(indexData, null, 2), 'utf8');

  return {
    available: downloadedFiles.length > 0,
    files: downloadedFiles,
    index_path: indexPath,
    summary: indexData,
  };
}

/**
 * Format selector strings per SPEC 4.1:
 * - Tier 2: Prefer 480p (landscape height=480 or vertical width=480), fallback UPWARD to 720p, fallback 360p..720p, fallback any video-only or muxed.
 * - Tier 3: Prefer 720p, fallback 1080p, fallback best video-only or muxed.
 */
export const FORMAT_SELECTORS = {
  tier2: [
    'bv*[height=480][vcodec^=avc]',
    'bv*[height=480]',
    'bv*[width=480][vcodec^=avc]',
    'bv*[width=480]',
    'bv*[height=720][vcodec^=avc]',
    'bv*[height=720]',
    'bv*[width=720]',
    'bv*[height<=720][height>=360]',
    'bv*[width<=720][width>=360]',
    'bv*[height<=480]',
    'bv*',
    'b[height<=720]',
    'b',
  ].join('/'),

  tier3: [
    'bv*[height=720][vcodec^=avc]',
    'bv*[height=720]',
    'bv*[width=720]',
    'bv*[height=1080][vcodec^=avc]',
    'bv*[height=1080]',
    'bv*[width=1080]',
    'bv*',
    'b',
  ].join('/'),
};

/**
 * Download pure video stream into .cache/ (reuses existing cached file if present).
 */
export async function ensureCachedVideoStream({
  platform,
  canonicalUrl,
  cacheDir,
  tier = 'tier2',
  cookieFilePath,
}) {
  await fs.promises.mkdir(cacheDir, { recursive: true });
  const prefix = tier === 'tier3' ? 'source_hd' : 'source_std';

  // Reuse cached stream if already downloaded and non-empty
  const existing = (await fs.promises.readdir(cacheDir)).find(
    (f) => f.startsWith(`${prefix}.`) && !f.endsWith('.part') && !f.endsWith('.ytdl')
  );
  if (existing) {
    const full = path.join(cacheDir, existing);
    const stat = await fs.promises.stat(full);
    if (stat.size > 1024) {
      return full;
    }
  }

  // Also if requesting tier2 and tier3 HD is already cached, reuse tier3 HD directly!
  if (tier === 'tier2') {
    const existingHd = (await fs.promises.readdir(cacheDir)).find(
      (f) => f.startsWith('source_hd.') && !f.endsWith('.part') && !f.endsWith('.ytdl')
    );
    if (existingHd) {
      const fullHd = path.join(cacheDir, existingHd);
      const stat = await fs.promises.stat(fullHd);
      if (stat.size > 1024) return fullHd;
    }
  }

  const ytdlp = resolveBinary('yt-dlp');
  const outTemplate = path.join(cacheDir, `${prefix}.%(ext)s`);
  const selector = FORMAT_SELECTORS[tier] || FORMAT_SELECTORS.tier2;

  const args = [
    ...buildBaseYtDlpArgs(platform, cookieFilePath),
    '-f',
    selector,
    '-o',
    outTemplate,
    canonicalUrl,
  ];

  await runCommand(ytdlp, args, { timeoutMs: 300_000 });

  const afterFiles = await fs.promises.readdir(cacheDir);
  const downloaded = afterFiles.find(
    (f) => f.startsWith(`${prefix}.`) && !f.endsWith('.part') && !f.endsWith('.ytdl')
  );
  if (!downloaded) {
    throw new Error(`yt-dlp completed without producing video file in ${cacheDir}`);
  }
  return path.join(cacheDir, downloaded);
}

/**
 * Stream-slice only [startSec, endSec] via yt-dlp --download-sections (Tier 3 range slicing).
 */
export async function downloadVideoClipSection({
  platform,
  canonicalUrl,
  startSec,
  endSec,
  clipCacheDir,
  slug,
  cookieFilePath,
}) {
  await fs.promises.mkdir(clipCacheDir, { recursive: true });
  const prefix = `section_${slug}`;

  const existing = (await fs.promises.readdir(clipCacheDir)).find(
    (f) => f.startsWith(`${prefix}.`) && !f.endsWith('.part') && !f.endsWith('.ytdl')
  );
  if (existing) {
    const full = path.join(clipCacheDir, existing);
    const stat = await fs.promises.stat(full);
    if (stat.size > 1024) return full;
  }

  const ytdlp = resolveBinary('yt-dlp');
  const outTemplate = path.join(clipCacheDir, `${prefix}.%(ext)s`);
  const sectionExpr = `*${startSec}-${endSec}`;

  const args = [
    ...buildBaseYtDlpArgs(platform, cookieFilePath),
    '-f',
    FORMAT_SELECTORS.tier3,
    '--download-sections',
    sectionExpr,
    '-o',
    outTemplate,
    canonicalUrl,
  ];

  await runCommand(ytdlp, args, { timeoutMs: 180_000 });

  const afterFiles = await fs.promises.readdir(clipCacheDir);
  const downloaded = afterFiles.find(
    (f) => f.startsWith(`${prefix}.`) && !f.endsWith('.part') && !f.endsWith('.ytdl')
  );
  if (!downloaded) {
    throw new Error(`Failed to download clip section ${sectionExpr}`);
  }
  return path.join(clipCacheDir, downloaded);
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
