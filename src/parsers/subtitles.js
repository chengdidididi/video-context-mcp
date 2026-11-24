import { formatTranscriptTimestamp, parseTimestampSec, roundSec } from '../utils/time.js';

/**
 * Strip ASR model control tokens (e.g. SenseVoice <|zh|><|NEUTRAL|><|Speech|><|withitn|>, emotion/BGM emojis)
 * and common Whisper silent-chunk boilerplate hallucinations.
 */
export function cleanAsrText(rawStr) {
  const cleaned = String(rawStr || '')
    .replace(/<\|[^|>]+\|>/g, '')
    .replace(/^[🎼🎵🎶👏😀😊😔😡😨🤢😮🤧😭]+\s*/gu, '')
    .replace(/\s*[🎼🎵🎶👏😀😊😔😡😨🤢😮🤧😭]+$/gu, '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return '';

  if (
    /^(字幕由\s*Amara\.org|Subtitles by the Amara\.org|Thank you for watching\.?|Thanks for watching\.?)$/i.test(
      cleaned
    )
  ) {
    return '';
  }

  return cleaned;
}

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
export function parseVttOrSrt(rawText, { merge = true } = {}) {
  const lines = String(rawText || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/);
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

    const cleanedLines = cueLines
      .map((l) => cleanAsrText(cleanInlineText(l)))
      .filter(Boolean);

    if (cleanedLines.length === 0) continue;

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

  return merge ? cleanAndMergeSegments(rawSegments) : rawSegments;
}

/**
 * Strip VTT/HTML tags (<00:01.200>, <c.colorE5E5E5>, {\an8}, etc.) and normalize whitespace.
 */
function cleanInlineText(str) {
  return str
    .replace(/<\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}>/g, '')
    .replace(/<\/?[^>]+>/g, '')
    .replace(/\{\\[^}]+\}/g, '')
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
 * Core deduplication & semantic sentence merging pipeline.
 */
export function cleanAndMergeSegments(rawSegments) {
  if (!rawSegments || rawSegments.length === 0) return [];

  const sorted = [...rawSegments].sort((a, b) => a.start - b.start || a.end - b.end);

  const deduped = [];
  for (const seg of sorted) {
    const text = cleanAsrText(seg.text);
    if (!text) continue;

    if (deduped.length === 0) {
      deduped.push({ ...seg, text });
      continue;
    }

    const prev = deduped[deduped.length - 1];

    if (prev.text === text && seg.start - prev.end < 3.0) {
      prev.end = Math.max(prev.end, seg.end);
      continue;
    }

    if (text.startsWith(prev.text) && seg.start - prev.end < 2.0) {
      const suffix = text.slice(prev.text.length).trim();
      if (!suffix) {
        prev.end = Math.max(prev.end, seg.end);
      } else if (prev.end - prev.start < 0.5) {
        prev.text = text;
        prev.end = Math.max(prev.end, seg.end);
      } else {
        prev.end = Math.min(prev.end, seg.start > prev.start ? seg.start : prev.end);
        deduped.push({ start: seg.start, end: seg.end, text: suffix });
      }
      continue;
    }

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

  const merged = [];
  const sentenceEndRegex = /[。！？.!?；;：:]$/;
  const noiseBracketRegex = /^(\[[^\]]+\]|（[^）]+）|\([^)]+\)|♪+)+$/;

  for (const seg of deduped) {
    if (merged.length === 0) {
      merged.push({ ...seg });
      continue;
    }

    const prev = merged[merged.length - 1];

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
  const maxSegSec = segments?.[segments.length - 1]?.end || 0;
  const totalSec = Math.max(Number(meta.durationSec || 0), maxSegSec);
  const forceHours = totalSec >= 3600;

  if (meta.title) {
    lines.push(`# ${meta.title}`);
    const metaParts = [];
    if (meta.author) metaParts.push(`Author: ${meta.author}`);
    if (meta.platform) metaParts.push(`Platform: ${meta.platform}`);
    if (totalSec > 0) metaParts.push(`Duration: ${formatTranscriptTimestamp(totalSec, forceHours)}`);
    if (meta.sourceUrl) metaParts.push(`URL: ${meta.sourceUrl}`);
    if (metaParts.length > 0) lines.push(`> ${metaParts.join(' | ')}`);
    lines.push('');
  }

  const rawDesc = String(meta.description || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (rawDesc && rawDesc !== '-') {
    const compactDesc = rawDesc.length > 600 ? `${rawDesc.slice(0, 600).trim()}…` : rawDesc;
    lines.push('## Description');
    lines.push(compactDesc);
    lines.push('');
  }

  if (Array.isArray(meta.chapters) && meta.chapters.length > 0) {
    lines.push('## Chapters');
    for (const ch of meta.chapters) {
      const startStr = formatTranscriptTimestamp(Number(ch.start_sec || 0), forceHours);
      const endStr =
        ch.end_sec !== undefined && ch.end_sec !== null
          ? ` - ${formatTranscriptTimestamp(Number(ch.end_sec), forceHours)}`
          : '';
      lines.push(`- [${startStr}${endStr}] ${ch.title}`);
    }
    lines.push('');
  }

  lines.push('## Transcript');
  if (!segments || segments.length === 0) {
    lines.push('*(No subtitle track available for this video.)*');
    return lines.join('\n') + '\n';
  }

  for (const seg of segments) {
    const ts = formatTranscriptTimestamp(seg.start, forceHours);
    lines.push(`[${ts}] ${seg.text}`);
  }

  return lines.join('\n') + '\n';
}
