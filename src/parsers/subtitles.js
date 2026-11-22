import { formatTranscriptTimestamp, parseTimestampSec, roundSec } from '../utils/time.js';

/**
 * Parse Bilibili BCC JSON subtitle format: { body: [{ from, to, content }] }
 */
export function parseBilibiliBccJson(rawJson) {
  const data = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
  const body = Array.isArray(data?.body) ? data.body : Array.isArray(data) ? data : [];

  const rawSegments = [];
  for (const item of body) {
    const start = Number(item.from ?? item.start ?? 0);
    const end = Number(item.to ?? item.end ?? start + 2);
    const text = cleanInlineText(String(item.content ?? item.text ?? ''));
    if (!text) continue;
    rawSegments.push({ start, end: Math.max(end, start + 0.1), text });
  }

  return cleanAndMergeSegments(rawSegments);
}

/**
 * Parse YouTube json3 timedtext format: { events: [{ tStartMs, dDurationMs, segs: [{ utf8 }] }] }
 */
export function parseYoutubeJson3(rawJson) {
  const data = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
  const events = Array.isArray(data?.events) ? data.events : [];

  const rawSegments = [];
  for (const ev of events) {
    if (!Array.isArray(ev.segs) || ev.tStartMs === undefined) continue;
    const joined = ev.segs.map((s) => s.utf8 || '').join('');
    const text = cleanInlineText(joined);
    if (!text) continue;
    const start = ev.tStartMs / 1000;
    const duration = (ev.dDurationMs ?? 2000) / 1000;
    rawSegments.push({
      start,
      end: start + Math.max(0.1, duration),
      text,
    });
  }

  return cleanAndMergeSegments(rawSegments);
}

/**
 * Parse WebVTT or SRT subtitle text, handling YouTube auto-caption rolling 2-line duplicates & <c> word tags.
 */
export function parseVttOrSrt(rawText) {
  const lines = rawText.replace(/^\uFEFF/, '').split(/\r?\n/);
  const rawSegments = [];

  const timeArrowRegex =
    /^(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3})/;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    const match = line.match(timeArrowRegex);
    if (!match) {
      i++;
      continue;
    }

    const start = parseTimestampSec(match[1]);
    const end = parseTimestampSec(match[2]);
    i++;

    const cueLines = [];
    while (i < lines.length && lines[i].trim() !== '') {
      if (timeArrowRegex.test(lines[i].trim())) break;
      cueLines.push(lines[i]);
      i++;
    }

    // Skip ultra-short 10ms rollup transition cues if identical text follows
    const cleanedLines = cueLines
      .map((l) => cleanInlineText(l))
      .filter(Boolean);

    if (cleanedLines.length === 0) continue;

    // Join multi-line cue while avoiding internal duplicate lines
    const dedupedCueLines = [];
    for (const cl of cleanedLines) {
      if (dedupedCueLines[dedupedCueLines.length - 1] !== cl) {
        dedupedCueLines.push(cl);
      }
    }

    const text = dedupedCueLines.join(' ').trim();
    if (!text) continue;

    rawSegments.push({
      start,
      end: Math.max(end, start + 0.05),
      text,
    });
  }

  return cleanAndMergeSegments(rawSegments);
}

/**
 * Strip VTT/HTML tags (<00:01.200>, <c.colorE5E5E5>, {\an8}, etc.) and normalize whitespace.
 */
function cleanInlineText(str) {
  return str
    .replace(/<\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}>/g, '') // VTT inline word timestamps
    .replace(/<\/?[^>]+>/g, '') // HTML/VTT tags (<c>, <b>, <font>, etc.)
    .replace(/\{\\[^}]+\}/g, '') // ASS/SSA override tags like {\an8}
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Core deduplication & semantic sentence merging pipeline:
 * 1. Eliminates YouTube rolling overlap (where segment B starts with or contains segment A)
 * 2. Eliminates consecutive identical noise markers ([Music], [音乐], etc.)
 * 3. Merges tiny fragmented cues into readable semantic sentences while keeping accurate start/end
 */
export function cleanAndMergeSegments(rawSegments) {
  if (!rawSegments || rawSegments.length === 0) return [];

  const sorted = [...rawSegments].sort((a, b) => a.start - b.start || a.end - b.end);

  // Pass 1: Rolling overlap deduplication (crucial for YouTube auto-generated VTT)
  const deduped = [];
  for (const seg of sorted) {
    const text = seg.text.trim();
    if (!text) continue;

    if (deduped.length === 0) {
      deduped.push({ ...seg, text });
      continue;
    }

    const prev = deduped[deduped.length - 1];

    // Exact duplicate within close time window
    if (prev.text === text && seg.start - prev.end < 3.0) {
      prev.end = Math.max(prev.end, seg.end);
      continue;
    }

    // Progressive growth: e.g. prev="Hello world" -> seg="Hello world how are you"
    if (text.startsWith(prev.text) && seg.start - prev.end < 2.0) {
      const suffix = text.slice(prev.text.length).trim();
      if (!suffix) {
        prev.end = Math.max(prev.end, seg.end);
      } else if (prev.end - prev.start < 0.5) {
        // Previous was a transient rollup flash cue: absorb into current
        prev.text = text;
        prev.end = Math.max(prev.end, seg.end);
      } else {
        prev.end = Math.min(prev.end, seg.start > prev.start ? seg.start : prev.end);
        deduped.push({ start: seg.start, end: seg.end, text: suffix });
      }
      continue;
    }

    // Suffix-prefix sliding overlap: e.g. prev="today we are going to build", seg="going to build a server"
    const overlapLen = findSuffixPrefixOverlap(prev.text, text);
    if (overlapLen >= 4 && seg.start - prev.end < 2.0) {
      const remainder = text.slice(overlapLen).trim();
      if (!remainder) {
        prev.end = Math.max(prev.end, seg.end);
        continue;
      }
      deduped.push({
        start: seg.start,
        end: seg.end,
        text: remainder,
      });
      continue;
    }

    deduped.push({ ...seg, text });
  }

  // Pass 2: Merge ultra-short fragments into natural semantic lines (unless separated by >0.6s pause or sentence punctuation)
  const merged = [];
  const sentenceEndRegex = /[。！？.!?；;：:]$/;
  const noiseBracketRegex = /^(\[[^\]]+\]|（[^）]+）|\([^)]+\)|♪+)+$/;

  for (const seg of deduped) {
    if (merged.length === 0) {
      merged.push({ ...seg });
      continue;
    }

    const prev = merged[merged.length - 1];

    // Collapse repeated consecutive "[音乐]" / "[Music]" placeholders
    if (noiseBracketRegex.test(seg.text) && prev.text === seg.text) {
      prev.end = Math.max(prev.end, seg.end);
      continue;
    }

    const gap = seg.start - prev.end;
    const prevDuration = prev.end - prev.start;
    const combinedLen = prev.text.length + seg.text.length;

    const shouldMerge =
      !noiseBracketRegex.test(prev.text) &&
      !noiseBracketRegex.test(seg.text) &&
      !sentenceEndRegex.test(prev.text) &&
      gap <= 0.6 &&
      prevDuration < 6.0 &&
      combinedLen <= 72;

    if (shouldMerge) {
      const needsSpace = /[A-Za-z0-9]$/.test(prev.text) && /^[A-Za-z0-9]/.test(seg.text);
      prev.text = `${prev.text}${needsSpace ? ' ' : ''}${seg.text}`;
      prev.end = Math.max(prev.end, seg.end);
    } else {
      merged.push({ ...seg });
    }
  }

  return merged.map((s) => ({
    start: roundSec(s.start, 3),
    end: roundSec(s.end, 3),
    text: s.text,
  }));
}

/**
 * Find longest overlap where suffix of `a` equals prefix of `b`.
 */
function findSuffixPrefixOverlap(a, b) {
  const maxLen = Math.min(a.length, b.length);
  for (let len = maxLen; len >= 4; len--) {
    if (a.slice(a.length - len) === b.slice(0, len)) {
      return len;
    }
  }
  return 0;
}

/**
 * Format cleaned segments into compact token-saving transcript.md content.
 */
export function formatTranscriptMarkdown(segments, meta = {}) {
  const lines = [];
  if (meta.title) {
    lines.push(`# ${meta.title}`);
    const metaParts = [];
    if (meta.author) metaParts.push(`Author: ${meta.author}`);
    if (meta.platform) metaParts.push(`Platform: ${meta.platform}`);
    if (meta.sourceUrl) metaParts.push(`URL: ${meta.sourceUrl}`);
    if (metaParts.length > 0) lines.push(`> ${metaParts.join(' | ')}`);
    lines.push('');
  }

  if (!segments || segments.length === 0) {
    lines.push('*(No subtitle track available for this video.)*');
    return lines.join('\n') + '\n';
  }

  const maxSec = segments[segments.length - 1]?.end || 0;
  const forceHours = maxSec >= 3600;

  for (const seg of segments) {
    const ts = formatTranscriptTimestamp(seg.start, forceHours);
    lines.push(`[${ts}] ${seg.text}`);
  }

  return lines.join('\n') + '\n';
}
