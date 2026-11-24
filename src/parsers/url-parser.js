import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchWithContext } from '../utils/http.js';

const BV_REGEX = /\b(BV[0-9A-Za-z]{10})\b/;
const AV_REGEX = /\bav(\d+)\b/i;
const YT_ID_REGEX = /^[0-9A-Za-z_-]{11}$/;
const VIDEO_EXT_REGEX = /\.(mp4|mov|mkv|webm|avi|flv|m4v|ts|mts|m2ts|wmv|mpg|mpeg|3gp|ogv)$/i;

function looksLikeLocalFilePath(input) {
  return (
    /^file:\/\//i.test(input) ||
    input.startsWith('/') ||
    input.startsWith('./') ||
    input.startsWith('../') ||
    input.startsWith('~/') ||
    input.startsWith('~\\') ||
    /^[A-Za-z]:[\\/]/.test(input) ||
    (!/^https?:\/\//i.test(input) && VIDEO_EXT_REGEX.test(input))
  );
}

function resolveCandidateLocalPath(input) {
  if (/^file:\/\//i.test(input)) {
    return fileURLToPath(input);
  }
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return path.resolve(input);
}

function buildLocalBundleSlug(resolvedPath, stat) {
  const ext = path.extname(resolvedPath);
  const rawBase = path.basename(resolvedPath, ext);
  const cleanStem =
    rawBase
      .replace(/[<>:"/\\|?*\x00-\x1F\s]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48) || 'video';

  const hash8 = crypto
    .createHash('sha1')
    .update(`${resolvedPath}:${stat.size}:${Math.floor(stat.mtimeMs)}`)
    .digest('hex')
    .slice(0, 8);

  return `${cleanStem}_${hash8}`;
}

/**
 * Resolve deterministic video input:
 * - Local video file path (absolute path, ~/..., relative path, or file:// URI)
 * - Bilibili URL, BV ID, av ID, or b23.tv short URL
 * - YouTube URL or 11-char Video ID
 * Explicitly rejects fuzzy title queries.
 */
export async function resolveVideoInput(rawInput, explicitPart) {
  if (!rawInput || typeof rawInput !== 'string') {
    throw new Error('url_or_id must be a non-empty string.');
  }
  const input = rawInput.trim();

  // 0. Local video file path detection (explicit path syntax or existing local file)
  if (!/^https?:\/\//i.test(input)) {
    const isPathSyntax = looksLikeLocalFilePath(input);
    let candidatePath = null;
    try {
      candidatePath = resolveCandidateLocalPath(input);
    } catch {
      candidatePath = null;
    }

    if (candidatePath && fs.existsSync(candidatePath)) {
      const stat = fs.statSync(candidatePath);
      if (!stat.isFile()) {
        throw new Error(`Local path is not a regular file: "${candidatePath}"`);
      }
      const videoId = buildLocalBundleSlug(candidatePath, stat);
      return {
        platform: 'local',
        videoId,
        idType: 'local',
        localPath: candidatePath,
        fileName: path.basename(candidatePath),
        part: 1,
        partExplicit: false,
        canonicalUrl: `file://${candidatePath}`,
      };
    }

    if (isPathSyntax) {
      throw new Error(`Local video file not found: "${candidatePath || input}"`);
    }
  }

  // 1. Bare Bilibili BV ID (e.g. "BV1xx411c7mD")
  if (/^BV[0-9A-Za-z]{10}$/.test(input)) {
    const part = normalizePart(explicitPart, 1);
    return {
      platform: 'bilibili',
      videoId: input,
      idType: 'bvid',
      part,
      partExplicit: explicitPart !== undefined,
      canonicalUrl: `https://www.bilibili.com/video/${input}?p=${part}`,
    };
  }

  // 2. Bare Bilibili av ID (e.g. "av170001")
  const bareAv = input.match(/^av(\d+)$/i);
  if (bareAv) {
    const part = normalizePart(explicitPart, 1);
    return {
      platform: 'bilibili',
      videoId: `av${bareAv[1]}`,
      idType: 'aid',
      aid: Number(bareAv[1]),
      part,
      partExplicit: explicitPart !== undefined,
      canonicalUrl: `https://www.bilibili.com/video/av${bareAv[1]}?p=${part}`,
    };
  }

  // 3. Bare 11-character YouTube Video ID (must not look like spaces/CJK title)
  if (YT_ID_REGEX.test(input) && !input.startsWith('BV')) {
    return {
      platform: 'youtube',
      videoId: input,
      idType: 'ytid',
      part: 1,
      partExplicit: false,
      canonicalUrl: `https://www.youtube.com/watch?v=${input}`,
    };
  }

  // 4. URL-like strings (with or without leading https://)
  let candidateUrl = input;
  if (/^(www\.|m\.|bilibili\.com|b23\.tv|youtube\.com|youtu\.be)/i.test(candidateUrl)) {
    candidateUrl = `https://${candidateUrl}`;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(candidateUrl);
  } catch {
    const embeddedUrlMatch = input.match(/https?:\/\/[^\s"'<>]+/i);
    if (embeddedUrlMatch) {
      return resolveVideoInput(embeddedUrlMatch[0], explicitPart);
    }
    const embeddedBv = input.match(BV_REGEX);
    if (embeddedBv) {
      return resolveVideoInput(embeddedBv[1], explicitPart);
    }
    throw new Error(
      `Invalid input "${input}". Fuzzy title search is disabled by design; please provide a deterministic YouTube/Bilibili URL, BV ID, Video ID, or an existing local video file path.`
    );
  }

  const host = parsedUrl.hostname.toLowerCase();

  // 4a. b23.tv short link redirect resolution
  if (host === 'b23.tv' || host.endsWith('.b23.tv')) {
    const res = await fetchWithContext(parsedUrl.toString(), {
      platform: 'bilibili',
      redirect: 'manual',
    });
    const location = res.headers.get('location');
    if (!location) {
      throw new Error(`Failed to resolve b23.tv short URL: ${parsedUrl.toString()}`);
    }
    const resolvedUrl = new URL(location, parsedUrl.toString()).toString();
    return resolveVideoInput(resolvedUrl, explicitPart);
  }

  // 4b. Bilibili standard URLs
  if (host === 'bilibili.com' || host.endsWith('.bilibili.com')) {
    const urlPartParam = parsedUrl.searchParams.get('p');
    const urlPart = urlPartParam ? parseInt(urlPartParam, 10) : undefined;
    const finalPart = normalizePart(explicitPart ?? urlPart, 1);
    const partExplicit = explicitPart !== undefined || urlPart !== undefined;

    const bvMatch = parsedUrl.pathname.match(BV_REGEX) || parsedUrl.search.match(BV_REGEX);
    if (bvMatch) {
      const bvid = bvMatch[1];
      return {
        platform: 'bilibili',
        videoId: bvid,
        idType: 'bvid',
        part: finalPart,
        partExplicit,
        canonicalUrl: `https://www.bilibili.com/video/${bvid}?p=${finalPart}`,
      };
    }

    const avMatch = parsedUrl.pathname.match(AV_REGEX);
    if (avMatch) {
      const aid = Number(avMatch[1]);
      return {
        platform: 'bilibili',
        videoId: `av${aid}`,
        idType: 'aid',
        aid,
        part: finalPart,
        partExplicit,
        canonicalUrl: `https://www.bilibili.com/video/av${aid}?p=${finalPart}`,
      };
    }

    throw new Error(
      `Could not extract BV or av ID from Bilibili URL: ${parsedUrl.toString()}`
    );
  }

  // 4c. YouTube URLs
  if (
    host === 'youtu.be' ||
    host === 'youtube.com' ||
    host.endsWith('.youtube.com') ||
    host === 'youtube-nocookie.com' ||
    host.endsWith('.youtube-nocookie.com')
  ) {
    let ytid = null;
    if (host === 'youtu.be') {
      ytid = parsedUrl.pathname.split('/').filter(Boolean)[0] || null;
    } else if (parsedUrl.searchParams.get('v')) {
      ytid = parsedUrl.searchParams.get('v');
    } else {
      const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
      if (
        pathParts.length >= 2 &&
        ['shorts', 'live', 'embed', 'v'].includes(pathParts[0].toLowerCase())
      ) {
        ytid = pathParts[1];
      }
    }

    if (!ytid || !YT_ID_REGEX.test(ytid)) {
      throw new Error(`Could not extract valid 11-character YouTube Video ID from: ${input}`);
    }

    return {
      platform: 'youtube',
      videoId: ytid,
      idType: 'ytid',
      part: 1,
      partExplicit: false,
      canonicalUrl: `https://www.youtube.com/watch?v=${ytid}`,
    };
  }

  throw new Error(
    `Unsupported domain "${host}". Only YouTube/Bilibili deterministic URLs/IDs and local video file paths are supported.`
  );
}

function normalizePart(part, fallback = 1) {
  if (part === undefined || part === null) return fallback;
  const n = Number(part);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid part number "${part}". Must be an integer >= 1.`);
  }
  return n;
}
