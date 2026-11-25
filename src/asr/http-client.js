import { getTimeoutMs } from '../config.js';

export class AsrApiError extends Error {
  constructor(message, { status = 0, url = '', bodySnippet = '', retriable = false } = {}) {
    super(message);
    this.name = 'AsrApiError';
    this.status = status;
    this.url = url;
    this.bodySnippet = bodySnippet;
    this.retriable = retriable;
  }
}

const RETRIABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const FIXED_RETRY_DELAY_MS = 1500;

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error('Aborted during retry wait'));
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('Aborted during retry wait'));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function fetchAsrWithRetry(
  url,
  buildInit,
  { timeoutMs = getTimeoutMs(), maxRetries = 2, label = 'ASR', signal: parentSignal = null } = {}
) {
  let lastErr = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (parentSignal?.aborted) {
      throw parentSignal.reason || new Error(`${label} aborted by pipeline timeout`);
    }

    const controller = new AbortController();
    let timedOut = false;
    const onParentAbort = () => {
      controller.abort(parentSignal.reason || new Error(`${label} interrupted`));
    };
    if (parentSignal) {
      parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    try {
      const init = await buildInit();
      const res = await fetch(url, {
        ...init,
        signal: controller.signal,
      });

      const rawText = await res.text();
      if (!res.ok) {
        const snippet = rawText.slice(0, 600);
        const retriable = RETRIABLE_STATUSES.has(res.status);
        const apiErr = new AsrApiError(
          `[${label}] HTTP ${res.status} from ${url}: ${snippet}`,
          { status: res.status, url, bodySnippet: snippet, retriable }
        );
        if (retriable && attempt < maxRetries && !parentSignal?.aborted) {
          lastErr = apiErr;
          await sleep(FIXED_RETRY_DELAY_MS, parentSignal);
          continue;
        }
        throw apiErr;
      }

      let json = null;
      try {
        json = JSON.parse(rawText);
      } catch {
        // plain text / VTT / SRT
      }
      return { status: res.status, rawText, json };
    } catch (err) {
      if (parentSignal?.aborted) {
        throw parentSignal.reason || new Error(`${label} interrupted by pipeline timeout`);
      }
      if (err instanceof AsrApiError && !err.retriable) {
        throw err;
      }
      lastErr = timedOut
        ? new Error(`[${label}] Request timed out after ${Math.round(timeoutMs / 1000)}s (${url})`)
        : err instanceof AsrApiError
          ? err
          : new Error(`[${label}] Network error (${url}): ${err?.message || String(err)}`);

      if (attempt < maxRetries && !parentSignal?.aborted) {
        await sleep(FIXED_RETRY_DELAY_MS, parentSignal);
        continue;
      }
      throw lastErr;
    } finally {
      clearTimeout(timer);
      if (parentSignal) {
        parentSignal.removeEventListener('abort', onParentAbort);
      }
    }
  }

  throw lastErr;
}

export function buildAuthHeaders(providerCfg) {
  const apiKey = String(providerCfg.api_key || '').trim();
  const headerName = String(providerCfg.auth_header || 'Authorization').trim() || 'Authorization';
  const prefix = providerCfg.auth_prefix !== undefined ? String(providerCfg.auth_prefix) : 'Bearer ';
  return {
    [headerName]: `${prefix}${apiKey}`,
  };
}
