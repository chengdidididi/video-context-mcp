import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getTimeoutMs, REFERERS, USER_AGENT } from '../config.js';

/**
 * Parse either Netscape cookies.txt text (preserving #HttpOnly_ entries like Bilibili SESSDATA)
 * or a raw DevTools Cookie header string ("buvid3=...; SESSDATA=...").
 */
export function parseCookieEntries(content, domainFilter = '') {
  const cookies = [];
  const nowSec = Math.floor(Date.now() / 1000);
  const lines = String(content || '').split(/\r?\n/);

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    // Strip #HttpOnly_ prefix BEFORE skipping regular comment lines!
    let line = trimmed;
    if (line.startsWith('#HttpOnly_')) {
      line = line.slice('#HttpOnly_'.length);
    } else if (line.startsWith('#')) {
      continue;
    }

    // Raw HTTP Cookie header string ("Cookie: a=1; b=2" or "a=1; b=2")
    if (!line.includes('\t') && line.includes('=')) {
      const cleanedHeader = line.replace(/^Cookie:\s*/i, '');
      for (const pair of cleanedHeader.split(';')) {
        const eqIdx = pair.indexOf('=');
        if (eqIdx <= 0) continue;
        const name = pair.slice(0, eqIdx).trim();
        const value = pair.slice(eqIdx + 1).trim();
        if (!name) continue;
        cookies.push({
          domain: domainFilter ? `.${domainFilter.replace(/^\./, '')}` : '.bilibili.com',
          path: '/',
          secure: true,
          expires: 0,
          name,
          value,
        });
      }
      continue;
    }

    const cols = line.split('\t');
    if (cols.length < 7) continue;

    const [domain, , cookiePath, secure, expiresStr, name, value] = cols;
    const expires = parseInt(expiresStr, 10);

    if (!Number.isNaN(expires) && expires > 0 && expires < nowSec) {
      continue;
    }

    if (domainFilter) {
      const cleanDom = domain.replace(/^\./, '').toLowerCase();
      const target = domainFilter.replace(/^\./, '').toLowerCase();
      if (
        cleanDom !== target &&
        !target.endsWith(`.${cleanDom}`) &&
        !cleanDom.endsWith(`.${target}`)
      ) {
        continue;
      }
    }

    cookies.push({
      domain,
      path: cookiePath,
      secure: secure.toUpperCase() === 'TRUE',
      expires: Number.isNaN(expires) ? 0 : expires,
      name,
      value,
    });
  }

  return cookies;
}

/**
 * Resolve raw cookie configuration value (inline Cookie string, inline Netscape text, or file path)
 * into a deduplicated HTTP "Cookie: k1=v1; k2=v2" header string.
 */
export function resolveCookieHeader(rawConfigValue, domainFilter = '') {
  if (!rawConfigValue || typeof rawConfigValue !== 'string' || !rawConfigValue.trim()) {
    return '';
  }
  const trimmed = rawConfigValue.trim();
  const text =
    !trimmed.includes('=') && fs.existsSync(trimmed)
      ? fs.readFileSync(trimmed, 'utf8')
      : trimmed;

  const parsed = parseCookieEntries(text, domainFilter);
  if (parsed.length === 0) return '';

  const map = new Map();
  for (const c of parsed) {
    map.set(c.name, c.value);
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * Materialize a temporary Netscape cookies.txt file inside output/<bundle>/cache/ ONLY when yt-dlp fallback needs --cookies.
 */
export async function writeTempNetscapeCookieFile(rawConfigValue, destPath, defaultDomain = '.bilibili.com') {
  const entries = parseCookieEntries(rawConfigValue, defaultDomain);
  if (entries.length === 0) return null;

  const lines = ['# Netscape HTTP Cookie File'];
  const fallbackExp = Math.floor(Date.now() / 1000) + 86400 * 30;
  for (const e of entries) {
    const dom = e.domain.startsWith('.') ? e.domain : `.${e.domain}`;
    const exp = e.expires > 0 ? e.expires : fallbackExp;
    lines.push(`${dom}\tTRUE\t${e.path || '/'}\t${e.secure ? 'TRUE' : 'FALSE'}\t${exp}\t${e.name}\t${e.value}`);
  }
  await fs.promises.writeFile(destPath, lines.join('\n') + '\n', 'utf8');
  return destPath;
}

export async function fetchWithContext(url, options = {}) {
  const {
    platform,
    cookieHeader,
    headers = {},
    redirect = 'follow',
    timeoutMs = getTimeoutMs(),
    signal: parentSignal = null,
  } = options;
  const finalHeaders = {
    'User-Agent': USER_AGENT,
    Accept: 'application/json, text/plain, */*',
    ...headers,
  };

  if (platform && REFERERS[platform] && !finalHeaders.Referer) {
    finalHeaders.Referer = REFERERS[platform];
  }
  if (cookieHeader) {
    finalHeaders.Cookie = cookieHeader;
  }

  if (parentSignal?.aborted) {
    throw parentSignal.reason || new Error(`HTTP request aborted before start: ${url}`);
  }

  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = () => {
    controller.abort(parentSignal.reason || new Error(`HTTP request interrupted: ${url}`));
  };
  if (parentSignal) {
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`HTTP request timed out after ${Math.round(timeoutMs / 1000)}s: ${url}`));
  }, timeoutMs);

  try {
    const { signal: _omit, ...restOptions } = options;
    return await fetch(url, {
      ...restOptions,
      headers: finalHeaders,
      redirect,
      signal: controller.signal,
    });
  } catch (err) {
    if (parentSignal?.aborted) {
      throw parentSignal.reason || new Error(`HTTP request interrupted by pipeline abort: ${url}`);
    }
    if (timedOut) {
      throw new Error(`HTTP request timed out after ${Math.round(timeoutMs / 1000)}s: ${url}`);
    }
    throw new Error(`Network request failed for ${url}: ${err?.message || String(err)}`);
  } finally {
    clearTimeout(timer);
    if (parentSignal) {
      parentSignal.removeEventListener('abort', onParentAbort);
    }
  }
}

export async function downloadFile(url, destPath, options = {}) {
  const fullUrl = url.startsWith('//') ? `https:${url}` : url;
  const {
    platform,
    cookieHeader,
    headers = {},
    timeoutMs = getTimeoutMs(),
    stallTimeoutMs = 45_000,
    signal: parentSignal = null,
  } = options;

  const finalHeaders = {
    'User-Agent': USER_AGENT,
    Accept: '*/*',
    ...headers,
  };
  if (platform && REFERERS[platform] && !finalHeaders.Referer) {
    finalHeaders.Referer = REFERERS[platform];
  }
  if (cookieHeader) {
    finalHeaders.Cookie = cookieHeader;
  }

  if (parentSignal?.aborted) {
    throw parentSignal.reason || new Error(`Download aborted before start: ${fullUrl}`);
  }

  const controller = new AbortController();
  const onParentAbort = () => {
    controller.abort(parentSignal.reason || new Error(`Download interrupted: ${fullUrl}`));
  };
  if (parentSignal) {
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }

  const totalTimer = setTimeout(
    () => controller.abort(new Error(`Download timed out after ${Math.round(timeoutMs / 1000)}s: ${fullUrl}`)),
    timeoutMs
  );
  let stallTimer = null;
  const resetStallTimer = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(
      () => controller.abort(new Error(`Stream stalled with zero bytes for ${Math.round(stallTimeoutMs / 1000)}s: ${fullUrl}`)),
      stallTimeoutMs
    );
  };

  try {
    resetStallTimer();
    const res = await fetch(fullUrl, {
      headers: finalHeaders,
      redirect: 'follow',
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} downloading ${fullUrl}`);
    }
    if (!res.body) {
      throw new Error(`Empty response body downloading ${fullUrl}`);
    }

    const totalBytes = Number(res.headers.get('content-length') || 0);
    let receivedBytes = 0;
    let nextMilestone = 25;

    const nodeStream = Readable.fromWeb(res.body);
    nodeStream.on('data', (chunk) => {
      resetStallTimer();
      receivedBytes += chunk.length;
      if (totalBytes > 5 * 1024 * 1024) {
        const pct = Math.floor((receivedBytes / totalBytes) * 100);
        if (pct >= nextMilestone) {
          const mbDone = (receivedBytes / 1048576).toFixed(1);
          const mbTotal = (totalBytes / 1048576).toFixed(1);
          console.error(`[video-context] Download progress: ${pct}% (${mbDone}MB / ${mbTotal}MB)`);
          nextMilestone = Math.floor(pct / 25) * 25 + 25;
        }
      }
    });

    const fileStream = fs.createWriteStream(destPath);
    await pipeline(nodeStream, fileStream, { signal: controller.signal });
    return destPath;
  } catch (err) {
    if (parentSignal?.aborted) {
      throw parentSignal.reason || new Error(`Download interrupted by pipeline abort: ${fullUrl}`);
    }
    if (controller.signal.aborted && controller.signal.reason instanceof Error) {
      throw controller.signal.reason;
    }
    throw err;
  } finally {
    clearTimeout(totalTimer);
    if (stallTimer) clearTimeout(stallTimer);
    if (parentSignal) {
      parentSignal.removeEventListener('abort', onParentAbort);
    }
  }
}
