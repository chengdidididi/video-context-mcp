import {
  getBilibiliCookieConfig,
  getConfigFilePath,
  resolveBinary,
} from '../config.js';
import { runCommand } from '../utils/exec.js';
import { fetchWithContext, resolveCookieHeader } from '../utils/http.js';

export class AuthRequiredError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AuthRequiredError';
    this.code = code; // 'AUTH_REQUIRED' | 'COOKIE_EXPIRED'
    this.details = details;
  }
}

export function buildBilibiliCookieGuide() {
  const cfgPath = getConfigFilePath();
  return [
    '[Bilibili Cookie Setup Instructions]',
    '1. Log in to https://www.bilibili.com in your desktop browser and copy the Cookie header string (buvid3=...; SESSDATA=...).',
    '2. Provide it via either method:',
    '   - Environment Variable (Agent MCP Settings): set BILIBILI_COOKIE="buvid3=...; SESSDATA=..."',
    `   - Unified YAML Config: set auth.bilibili_cookie in ${cfgPath} (or call MCP tool video_config).`,
    '3. Re-run the tool once configured.',
  ].join('\n');
}

/**
 * Check Bilibili login status via /x/web-interface/nav AND extract WBI keys (imgKey, subKey).
 */
export async function checkBilibiliAuth() {
  const cookieCfg = getBilibiliCookieConfig();
  const cookieHeader = resolveCookieHeader(cookieCfg.raw, 'bilibili.com');
  const hasConfiguredCookie = Boolean(cookieHeader);

  let navData = null;
  let errorMsg = null;
  try {
    const res = await fetchWithContext('https://api.bilibili.com/x/web-interface/nav', {
      platform: 'bilibili',
      cookieHeader,
    });
    const json = await res.json();
    navData = json?.data || null;
  } catch (err) {
    errorMsg = err.message;
  }

  const isLogin = Boolean(navData?.isLogin);
  const wbiImg = navData?.wbi_img || {};
  const imgKey = extractWbiKey(wbiImg.img_url);
  const subKey = extractWbiKey(wbiImg.sub_url);

  let status = 'authenticated';
  if (!hasConfiguredCookie) {
    status = 'missing_cookie';
  } else if (!isLogin) {
    status = 'cookie_expired_or_logged_out';
  }

  return {
    platform: 'bilibili',
    status,
    authenticated: isLogin,
    cookie_source: cookieCfg.source,
    cookie_configured: hasConfiguredCookie,
    username: isLogin ? navData?.uname || null : null,
    mid: isLogin ? navData?.mid || null : null,
    vip_status: isLogin ? Boolean(navData?.vipStatus) : false,
    wbi_keys: imgKey && subKey ? { imgKey, subKey } : null,
    cookie_header: cookieHeader,
    network_error: errorMsg,
    guide: isLogin ? null : buildBilibiliCookieGuide(),
  };
}

/**
 * Enforce Bilibili login rule (anti-silent-degradation per SPEC 3.2).
 */
export async function ensureBilibiliAuth(allowGuestOverride) {
  const cookieCfg = getBilibiliCookieConfig();
  const allowGuest =
    allowGuestOverride !== undefined ? Boolean(allowGuestOverride) : cookieCfg.allowGuestDegraded;

  const auth = await checkBilibiliAuth();
  if (auth.authenticated || allowGuest) {
    return auth;
  }

  const code = auth.cookie_configured ? 'COOKIE_EXPIRED' : 'AUTH_REQUIRED';
  const reason = auth.cookie_configured
    ? `Configured Bilibili cookie (${auth.cookie_source}) is expired or logged out (nav.isLogin = false). Refusing to silently degrade to 360p without AI subtitles.`
    : 'Bilibili cookie is not configured. Bilibili requires login cookies to access AI subtitles (ai-zh) and >=480p video streams.';

  const { cookie_header: _omit, ...publicDetails } = auth;
  throw new AuthRequiredError(code, `${reason}\n\n${auth.guide}`, publicDetails);
}

export async function checkSystemBinaries() {
  const ytdlpBin = resolveBinary('yt-dlp');
  const ffmpegBin = resolveBinary('ffmpeg');
  const ffprobeBin = resolveBinary('ffprobe');

  const results = {};

  try {
    const { stdout } = await runCommand(ytdlpBin, ['--version'], { timeoutMs: 10_000 });
    results.yt_dlp = { available: true, path: ytdlpBin, version: stdout.trim() };
  } catch (err) {
    results.yt_dlp = { available: false, path: ytdlpBin, error: err.message };
  }

  try {
    const { stdout } = await runCommand(ffmpegBin, ['-version'], { timeoutMs: 10_000 });
    const firstLine = stdout.split(/\r?\n/)[0] || '';
    const filtersRes = await runCommand(ffmpegBin, ['-filters'], {
      timeoutMs: 10_000,
      allowNonZero: true,
    });
    const hasDrawtext = filtersRes.stdout.includes(' drawtext ');
    results.ffmpeg = {
      available: true,
      path: ffmpegBin,
      version: firstLine.trim(),
      has_drawtext_filter: hasDrawtext,
      grid_renderer: 'sharp-svg-compositor (libfreetype not required)',
    };
  } catch (err) {
    results.ffmpeg = { available: false, path: ffmpegBin, error: err.message };
  }

  try {
    const { stdout } = await runCommand(ffprobeBin, ['-version'], { timeoutMs: 10_000 });
    const firstLine = stdout.split(/\r?\n/)[0] || '';
    results.ffprobe = { available: true, path: ffprobeBin, version: firstLine.trim() };
  } catch (err) {
    results.ffprobe = { available: false, path: ffprobeBin, error: err.message };
  }

  return results;
}

function extractWbiKey(url) {
  if (!url || typeof url !== 'string') return '';
  const filename = url.split('/').pop() || '';
  return filename.split('.')[0] || '';
}
