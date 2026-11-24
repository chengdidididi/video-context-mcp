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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchAsrWithRetry(
  url,
  buildInit,
  { timeoutMs = 60_000, maxRetries = 2, label = 'ASR' } = {}
) {
  let lastErr = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`${label} request timed out after ${timeoutMs}ms`)),
      timeoutMs
    );

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
          {
            status: res.status,
            url,
            bodySnippet: snippet,
            retriable,
          }
        );

        if (retriable && attempt < maxRetries) {
          lastErr = apiErr;
          const retryAfterSec = Number(res.headers.get('retry-after') || 0);
          const delayMs =
            retryAfterSec > 0 && retryAfterSec <= 15
              ? retryAfterSec * 1000
              : 800 * 2 ** attempt;
          console.error(
            `[video-context] ${label} HTTP ${res.status} (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delayMs}ms...`
          );
          await sleep(delayMs);
          continue;
        }
        throw apiErr;
      }

      let parsedJson = null;
      try {
        parsedJson = JSON.parse(rawText);
      } catch {
        // Response may be plain text / VTT / SRT
      }

      return {
        status: res.status,
        rawText,
        json: parsedJson,
      };
    } catch (err) {
      if (err instanceof AsrApiError && !err.retriable) {
        throw err;
      }
      lastErr = err;
      if (attempt < maxRetries) {
        const delayMs = 800 * 2 ** attempt;
        console.error(
          `[video-context] ${label} network/timeout error (${err.message}), retrying in ${delayMs}ms...`
        );
        await sleep(delayMs);
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
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
