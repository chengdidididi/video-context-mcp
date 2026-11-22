/**
 * Parse flexible timestamp input (number of seconds, "MM:SS", "HH:MM:SS.ms", "04m10s") into float seconds.
 */
export function parseTimestampSec(input) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) {
      throw new Error(`Invalid timestamp number: ${input}`);
    }
    return input;
  }
  if (typeof input !== 'string') {
    throw new Error(`Unsupported timestamp type: ${typeof input}`);
  }
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Empty timestamp string');
  }

  // Pure numeric seconds (e.g. "124.5" or "124.5s")
  if (/^\d+(\.\d+)?s?$/i.test(trimmed)) {
    return parseFloat(trimmed);
  }

  // Human slug like "02m10s" or "1h02m10.5s"
  const hmsSlug = trimmed.match(/^(?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s?$/i);
  if (hmsSlug && (hmsSlug[1] !== undefined || hmsSlug[2] !== undefined)) {
    const h = parseInt(hmsSlug[1] || '0', 10);
    const m = parseInt(hmsSlug[2] || '0', 10);
    const s = parseFloat(hmsSlug[3]);
    return h * 3600 + m * 60 + s;
  }

  // Colon format "MM:SS.ms" or "HH:MM:SS,ms" (SRT/VTT compatible)
  const normalized = trimmed.replace(',', '.');
  const parts = normalized.split(':');
  if (parts.length === 2) {
    const m = parseInt(parts[0], 10);
    const s = parseFloat(parts[1]);
    if (Number.isNaN(m) || Number.isNaN(s)) throw new Error(`Invalid timestamp: ${input}`);
    return m * 60 + s;
  }
  if (parts.length === 3) {
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    const s = parseFloat(parts[2]);
    if (Number.isNaN(h) || Number.isNaN(m) || Number.isNaN(s)) {
      throw new Error(`Invalid timestamp: ${input}`);
    }
    return h * 3600 + m * 60 + s;
  }

  throw new Error(`Unrecognized timestamp format: "${input}"`);
}

/**
 * Format seconds for grid header bar: "01:24.5" or "01:05:24.5"
 */
export function formatFrameTimestamp(sec, forceHours = false) {
  const clamped = Math.max(0, sec);
  const totalTenths = Math.round(clamped * 10);
  const tenths = totalTenths % 10;
  const totalWholeSec = Math.floor(totalTenths / 10);
  const s = totalWholeSec % 60;
  const totalMin = Math.floor(totalWholeSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);

  const ss = String(s).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  if (h > 0 || forceHours) {
    const hh = String(h).padStart(2, '0');
    return `${hh}:${mm}:${ss}.${tenths}`;
  }
  return `${mm}:${ss}.${tenths}`;
}

/**
 * Format seconds for compact transcript lines: "[01:24]" or "[01:05:24]"
 */
export function formatTranscriptTimestamp(sec, forceHours = false) {
  const clamped = Math.max(0, Math.floor(sec));
  const s = clamped % 60;
  const totalMin = Math.floor(clamped / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);

  const ss = String(s).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  if (h > 0 || forceHours) {
    const hh = String(h).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

/**
 * Format seconds for safe filenames: "00m28s" or "01h02m10s"
 */
export function formatSlugTimestamp(sec) {
  const clamped = Math.max(0, Math.round(sec));
  const s = clamped % 60;
  const totalMin = Math.floor(clamped / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);

  const ss = String(s).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  if (h > 0) {
    const hh = String(h).padStart(2, '0');
    return `${hh}h${mm}m${ss}s`;
  }
  return `${mm}m${ss}s`;
}

export function roundSec(sec, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(sec * factor) / factor;
}
