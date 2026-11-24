import fs from 'node:fs';
import { cleanAsrText, parseVttOrSrt } from '../../parsers/subtitles.js';
import { roundSec } from '../../utils/time.js';
import { AsrApiError, buildAuthHeaders, fetchAsrWithRetry } from '../http-client.js';

export async function transcribeChunkOpenAiTranscriptions({
  chunk,
  providerCfg,
  language = 'auto',
  prompt = '',
  timeoutMs = 60_000,
  maxRetries = 2,
}) {
  const baseUrl = String(providerCfg.base_url || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '');
  const endpointPath = String(providerCfg.endpoint_path || '/audio/transcriptions');
  const url = `${baseUrl}${endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`}`;
  const model = String(providerCfg.model || '').trim();

  const authHeaders = buildAuthHeaders(providerCfg);
  const audioBuffer = await fs.promises.readFile(chunk.filePath);
  const preferredFormat = String(providerCfg.response_format || '').trim();

  const sendWithFormat = async (responseFormat) =>
    fetchAsrWithRetry(
      url,
      async () => {
        const form = new FormData();
        const blob = new Blob([audioBuffer], { type: chunk.mimeType || 'audio/mpeg' });
        form.append('file', blob, chunk.fileName);
        form.append('model', model);

        if (responseFormat) {
          form.append('response_format', responseFormat);
        }
        if (language && language !== 'auto') {
          form.append('language', language);
        }
        if (prompt) {
          form.append('prompt', prompt);
        }

        return {
          method: 'POST',
          headers: {
            Accept: 'application/json, text/plain, */*',
            ...authHeaders,
          },
          body: form,
        };
      },
      {
        timeoutMs,
        maxRetries,
        label: `openai-transcriptions(${model})`,
      }
    );

  let res;
  try {
    res = await sendWithFormat(preferredFormat);
  } catch (err) {
    if (err instanceof AsrApiError && err.status === 400 && preferredFormat) {
      res = await sendWithFormat('');
    } else {
      throw err;
    }
  }

  return parseOpenAiTranscriptionResponse(res, chunk);
}

function parseOpenAiTranscriptionResponse(res, chunk) {
  const { json, rawText } = res;

  if (json && Array.isArray(json.segments) && json.segments.length > 0) {
    const mapped = [];
    for (const seg of json.segments) {
      const text = cleanAsrText(seg.text ?? '');
      if (!text) continue;
      const relStart = Math.max(0, Number(seg.start ?? 0));
      const relEnd = Math.max(relStart + 0.05, Number(seg.end ?? chunk.durationSec));
      mapped.push({
        start: roundSec(chunk.startSec + relStart, 3),
        end: roundSec(Math.min(chunk.endSec + 1.0, chunk.startSec + relEnd), 3),
        text,
      });
    }
    return { segments: mapped };
  }

  if (!json && rawText && rawText.includes('-->')) {
    const cues = parseVttOrSrt(rawText, { merge: false });
    return {
      segments: cues.map((c) => ({
        start: roundSec(chunk.startSec + c.start, 3),
        end: roundSec(chunk.startSec + c.end, 3),
        text: c.text,
      })),
    };
  }

  const text = cleanAsrText(json?.text ?? rawText ?? '');
  return {
    segments: text
      ? [
          {
            start: chunk.startSec,
            end: chunk.endSec,
            text,
          },
        ]
      : [],
  };
}
