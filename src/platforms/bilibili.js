import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getTimeoutMs } from '../config.js';
import { parseBilibiliBccJson } from '../parsers/subtitles.js';
import { mapWithConcurrency } from '../utils/exec.js';
import { downloadFile, fetchWithContext } from '../utils/http.js';
import { roundSec } from '../utils/time.js';

// Standard Bilibili WBI 64-byte permutation table
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

export function getMixinKey(orig) {
  return MIXIN_KEY_ENC_TAB.map((n) => orig[n] || '').join('').slice(0, 32);
}

export function signWbiParams(params, imgKey, subKey) {
  const mixinKey = getMixinKey(imgKey + subKey);
  const wts = Math.round(Date.now() / 1000);
  const chrFilter = /[!'()*]/g;

  const fullParams = { ...params, wts };
  const query = Object.keys(fullParams)
    .sort()
    .map((key) => {
      const value = String(fullParams[key]).replace(chrFilter, '');
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    })
    .join('&');

  const wRid = crypto.createHash('md5').update(query + mixinKey).digest('hex');
  return `${query}&w_rid=${wRid}`;
}

/**
 * Ensure Bilibili browser fingerprint cookies (buvid3, buvid4, b_nut) are present in Cookie header
 * to prevent Bilibili WAF -412 ("request was banned") errors when cookies.txt lacks buvid3 or in guest mode.
 */
let cachedFingerCookies = '';
export async function ensureBilibiliFingerCookies(cookieHeader = '') {
  if (cookieHeader && cookieHeader.includes('buvid3=')) {
    return cookieHeader;
  }
  if (!cachedFingerCookies) {
    try {
      const res = await fetchWithContext('https://api.bilibili.com/x/frontend/finger/spi', {
        platform: 'bilibili',
        cookieHeader,
      });
      const json = await res.json();
      if (json?.code === 0 && json?.data?.b_3) {
        const bNut = Math.floor(Date.now() / 1000);
        const parts = [`buvid3=${json.data.b_3}`, `b_nut=${bNut}`];
        if (json.data.b_4) parts.push(`buvid4=${json.data.b_4}`);
        cachedFingerCookies = parts.join('; ');
      }
    } catch {
      // ignore spi error
    }
  }
  if (!cachedFingerCookies) return cookieHeader;
  return cookieHeader ? `${cookieHeader}; ${cachedFingerCookies}` : cachedFingerCookies;
}

/**
 * Fetch Bilibili video metadata & multi-part list via WBI-signed /x/web-interface/wbi/view (with /view fallback)
 */
export async function fetchBilibiliView(resolvedInput, cookieHeader, wbiKeys) {
  const effectiveCookies = await ensureBilibiliFingerCookies(cookieHeader);
  const rawParams =
    resolvedInput.idType === 'aid'
      ? { aid: resolvedInput.aid }
      : { bvid: resolvedInput.videoId };

  let viewUrl;
  if (wbiKeys?.imgKey && wbiKeys?.subKey) {
    const signed = signWbiParams(rawParams, wbiKeys.imgKey, wbiKeys.subKey);
    viewUrl = `https://api.bilibili.com/x/web-interface/wbi/view?${signed}`;
  } else {
    const query =
      resolvedInput.idType === 'aid'
        ? `aid=${encodeURIComponent(resolvedInput.aid)}`
        : `bvid=${encodeURIComponent(resolvedInput.videoId)}`;
    viewUrl = `https://api.bilibili.com/x/web-interface/view?${query}`;
  }

  const res = await fetchWithContext(viewUrl, {
    platform: 'bilibili',
    cookieHeader: effectiveCookies,
  });
  const json = await res.json();
  if (json.code !== 0 || !json.data) {
    throw new Error(`Bilibili view API error (${json.code}): ${json.message || 'Unknown error'}`);
  }

  const d = json.data;
  const pages = (d.pages || []).map((p) => ({
    part: p.page,
    cid: p.cid,
    title: p.part || `P${p.page}`,
    duration_sec: p.duration,
    dimension: p.dimension ? { width: p.dimension.width, height: p.dimension.height } : null,
  }));

  const targetPart = resolvedInput.part || 1;
  const selectedPage = pages.find((p) => p.part === targetPart);
  if (!selectedPage) {
    throw new Error(
      `Requested part p=${targetPart} does not exist. Video ${d.bvid} has ${pages.length} part(s).`
    );
  }

  return {
    bvid: d.bvid,
    aid: d.aid,
    cid: selectedPage.cid,
    part: selectedPage.part,
    partTitle: pages.length > 1 ? selectedPage.title : null,
    title: pages.length > 1 && selectedPage.title ? `${d.title} - P${selectedPage.part} ${selectedPage.title}` : d.title,
    rawTitle: d.title,
    author: d.owner?.name || 'Unknown',
    duration_sec: selectedPage.duration_sec || d.duration,
    description: d.desc || '',
    canonicalUrl: `https://www.bilibili.com/video/${d.bvid}?p=${selectedPage.part}`,
    pages,
  };
}

/**
 * Fetch Bilibili subtitles (including ai-zh) and official view_points chapters via WBI player API.
 */
export async function fetchBilibiliSubtitlesAndChapters(bvid, cid, cookieHeader, wbiKeys) {
  const effectiveCookies = await ensureBilibiliFingerCookies(cookieHeader);
  let url;
  if (wbiKeys?.imgKey && wbiKeys?.subKey) {
    const signedQuery = signWbiParams({ bvid, cid }, wbiKeys.imgKey, wbiKeys.subKey);
    url = `https://api.bilibili.com/x/player/wbi/v2?${signedQuery}`;
  } else {
    url = `https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}`;
  }

  const res = await fetchWithContext(url, {
    platform: 'bilibili',
    cookieHeader: effectiveCookies,
  });
  const json = await res.json();
  if (json.code !== 0 || !json.data) {
    return { chapters: [], subtitleTrack: null, segments: [] };
  }

  const d = json.data;
  const chapters = Array.isArray(d.view_points)
    ? d.view_points.map((vp) => ({
        title: vp.content || '',
        start_sec: Number(vp.from || 0),
        end_sec: Number(vp.to || 0),
      }))
    : [];

  const rawSubs = d.subtitle?.subtitles || [];
  if (rawSubs.length === 0) {
    return { chapters, subtitleTrack: null, segments: [] };
  }

  // Prioritize manual Chinese > manual other > AI Chinese (ai-zh) > AI other
  const scored = rawSubs
    .filter((s) => s.subtitle_url)
    .map((s) => {
      const lan = String(s.lan || '');
      const isAi = lan.startsWith('ai-') || Number(s.ai_type) > 0;
      let score = 0;
      if (!isAi) score += 100;
      if (/^(zh-CN|zh-Hans|zh)$/i.test(lan)) score += 50;
      else if (lan === 'ai-zh') score += 45;
      else if (lan.includes('zh')) score += 35;
      else if (lan.includes('en')) score += 20;
      return { track: s, isAi, score };
    })
    .sort((a, b) => b.score - a.score);

  const chosen = scored[0]?.track;
  if (!chosen) {
    return { chapters, subtitleTrack: null, segments: [] };
  }

  const subUrl = chosen.subtitle_url.startsWith('//')
    ? `https:${chosen.subtitle_url}`
    : chosen.subtitle_url;

  const subRes = await fetchWithContext(subUrl, {
    platform: 'bilibili',
    cookieHeader,
  });
  const subJson = await subRes.json();
  const segments = parseBilibiliBccJson(subJson);

  return {
    chapters,
    subtitleTrack: {
      language: chosen.lan,
      label: chosen.lan_doc || chosen.lan,
      source_type: chosen.lan.startsWith('ai-') || Number(chosen.ai_type) > 0 ? chosen.lan : 'manual',
    },
    segments,
  };
}

/**
 * Download Bilibili pure video DASH stream (.m4s single-file fMP4) directly via WBI playurl API,
 * prioritizing official upos-*.bilivideo.com CDN mirrors over flaky mcdn/szbdyd PCDN (avoids HTTP 567).
 */
export async function downloadBilibiliDashStream({
  bvid,
  cid,
  destDir,
  cookieHeader = '',
  wbiKeys = null,
  targetShortSide = 360,
}) {
  await fs.promises.mkdir(destDir, { recursive: true });
  const prefix = 'source_video';
  const existing = (await fs.promises.readdir(destDir)).find(
    (f) => f.startsWith(`${prefix}.`) && !f.endsWith('.part')
  );
  if (existing) {
    const full = path.join(destDir, existing);
    if ((await fs.promises.stat(full)).size > 1024) return full;
  }

  const effectiveCookies = await ensureBilibiliFingerCookies(cookieHeader);
  const params = {
    bvid,
    cid,
    qn: 64,
    fnval: 4048, // DASH
    fnver: 0,
    fourk: 1,
  };

  const query =
    wbiKeys?.imgKey && wbiKeys?.subKey
      ? signWbiParams(params, wbiKeys.imgKey, wbiKeys.subKey)
      : new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();

  const url = `https://api.bilibili.com/x/player/wbi/playurl?${query}`;
  const res = await fetchWithContext(url, {
    platform: 'bilibili',
    cookieHeader: effectiveCookies,
  });
  const json = await res.json();
  if (json.code !== 0 || !json.data) {
    throw new Error(`Bilibili playurl error (${json.code}): ${json.message || 'Unknown'}`);
  }

  const dashVideos = json.data.dash?.video || [];
  if (dashVideos.length === 0) {
    const durl = json.data.durl?.[0];
    if (!durl) throw new Error('No DASH or durl video streams returned by Bilibili playurl');
    const urls = rankBilibiliCdnUrls([durl.url, ...(durl.backup_url || [])]);
    const destPath = path.join(destDir, `${prefix}.mp4`);
    await downloadFromMirrorList(urls, destPath, effectiveCookies);
    return destPath;
  }

  // Prefer 480p (id=32) -> 360p (id=16, when cell height <= 360) -> 720p (id=64), <=35fps, lowest bandwidth
  const targetOrder = targetShortSide <= 360 ? [32, 16, 64, 80] : [32, 64, 16, 80];
  const scored = dashVideos
    .map((v) => {
      const qnIdx = targetOrder.indexOf(Number(v.id));
      const qnRank = qnIdx !== -1 ? qnIdx : 99;
      const fpsRaw = parseFloat(String(v.frameRate || v.frame_rate || '30'));
      const fpsRank = !Number.isFinite(fpsRaw) || fpsRaw <= 35 ? 0 : 1;
      const bw = Number(v.bandwidth || 999_999_999);
      return { stream: v, qnRank, fpsRank, bw };
    })
    .sort((a, b) => a.qnRank - b.qnRank || a.fpsRank - b.fpsRank || a.bw - b.bw);

  let lastErr = null;
  for (const cand of scored.slice(0, 4)) {
    const v = cand.stream;
    const rawUrls = [v.baseUrl || v.base_url, ...(v.backupUrl || v.backup_url || [])].filter(Boolean);
    const urls = rankBilibiliCdnUrls(rawUrls);
    const destPath = path.join(destDir, `${prefix}.m4s`);
    try {
      await downloadFromMirrorList(urls, destPath, effectiveCookies);
      return destPath;
    } catch (err) {
      lastErr = err;
    }
  }

  throw lastErr || new Error('Failed to download Bilibili DASH stream from all mirrors');
}

function rankBilibiliCdnUrls(urls) {
  return [...urls].sort((a, b) => cdnScore(b) - cdnScore(a));
}

function cdnScore(u) {
  if (u.includes('upos-')) return 100; // Official cloud CDN (Alibaba/Tencent/Akamai/Huawei)
  if (u.includes('bilivideo.com') && !u.includes('mcdn')) return 80;
  if (u.includes('mcdn.bilivideo')) return 10; // PCDN prone to HTTP 567
  if (u.includes('szbdyd.com')) return 5; // PCDN
  return 50;
}

async function downloadFromMirrorList(urls, destPath, cookieHeader) {
  let lastErr = null;
  const partPath = `${destPath}.part`;
  const reqHeaders = {
    Origin: 'https://www.bilibili.com',
    Referer: 'https://www.bilibili.com/',
  };

  for (const rawUrl of urls) {
    const u = rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl;
    try {
      // Probe byte length via Range: bytes=0-0 (avoids single-connection post-burst CDN rate shaping!)
      const probeRes = await fetchWithContext(u, {
        platform: 'bilibili',
        cookieHeader,
        timeoutMs: 15_000,
        headers: { ...reqHeaders, Range: 'bytes=0-0' },
      });

      const contentRange = probeRes.headers.get('content-range') || '';
      const rangeMatch = contentRange.match(/\/(\d+)$/);
      const totalSize = rangeMatch ? Number(rangeMatch[1]) : 0;
      await probeRes.arrayBuffer().catch(() => {});

      if (probeRes.status === 206 && totalSize > 4 * 1024 * 1024) {
        await downloadRangeChunked(u, partPath, totalSize, cookieHeader, reqHeaders);
      } else {
        await downloadFile(u, partPath, {
          platform: 'bilibili',
          cookieHeader,
          timeoutMs: getTimeoutMs(),
          stallTimeoutMs: 30_000,
          headers: reqHeaders,
        });
      }

      const stat = await fs.promises.stat(partPath);
      if (stat.size > 1024) {
        await fs.promises.rename(partPath, destPath);
        return destPath;
      }
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('All Bilibili CDN mirrors failed');
}

async function downloadRangeChunked(url, partPath, totalSize, cookieHeader, extraHeaders) {
  const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB chunks stay inside CDN fast-start window
  const chunks = [];
  for (let start = 0; start < totalSize; start += CHUNK_SIZE) {
    const end = Math.min(totalSize - 1, start + CHUNK_SIZE - 1);
    chunks.push({ start, end });
  }

  const fh = await fs.promises.open(partPath, 'w');
  let completedBytes = 0;
  let nextMilestone = 25;

  try {
    await mapWithConcurrency(chunks, 4, async (chunk) => {
      let attemptErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetchWithContext(url, {
            platform: 'bilibili',
            cookieHeader,
            timeoutMs: 30_000,
            headers: {
              ...extraHeaders,
              Range: `bytes=${chunk.start}-${chunk.end}`,
            },
          });
          if (res.status !== 206 && res.status !== 200) {
            throw new Error(`Unexpected status ${res.status} on Range ${chunk.start}-${chunk.end}`);
          }
          const buf = Buffer.from(await res.arrayBuffer());
          await fh.write(buf, 0, buf.length, chunk.start);

          completedBytes += buf.length;
          const pct = Math.floor((completedBytes / totalSize) * 100);
          if (pct >= nextMilestone) {
            console.error(
              `[video-context] Download progress: ${pct}% (${(completedBytes / 1048576).toFixed(1)}MB / ${(totalSize / 1048576).toFixed(1)}MB)`
            );
            nextMilestone = Math.floor(pct / 25) * 25 + 25;
          }
          return;
        } catch (err) {
          attemptErr = err;
        }
      }
      throw attemptErr;
    });
  } finally {
    await fh.close();
  }
}
