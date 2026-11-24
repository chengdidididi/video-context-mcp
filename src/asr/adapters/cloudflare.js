import fs from 'node:fs';
import { cleanAsrText, parseVttOrSrt } from '../../parsers/subtitles.js';
import { roundSec } from '../../utils/time.js';
import { AsrApiError, fetchAsrWithRetry } from '../http-client.js';

export async function transcribeChunkCloudflare({
  chunk,
  providerCfg,
  language = 'auto',
  prompt = '',
  timeoutMs = 60_000,
  maxRetries = 2,
}) {
  const baseUrl = String(providerCfg.base_url || 'https://api.cloudflare.com/client/v4').replace(
    /\/+$/,
    ''
  );
  const accountId = String(providerCfg.account_id || '').trim();
  const apiKey = String(providerCfg.api_key || '').trim();
  const model = String(providerCfg.model || '@cf/openai/whisper-large-v3-turbo')
    .trim()
    .replace(/^\/+/, '');

  const url = `${baseUrl}/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`;
  const audioBuffer = await fs.promises.readFile(chunk.filePath);

  const configuredMode = String(providerCfg.payload_mode || '').toLowerCase();
  const isLegacyBinaryWhisper =
    configuredMode === 'binary' ||
    (!configuredMode &&
      (model === '@cf/openai/whisper' || model === '@cf/openai/whisper-tiny-en'));

  const primaryMode = isLegacyBinaryWhisper ? 'binary' : 'base64_json';

  const sendWithMode = async (mode) => {
    if (mode === 'binary') {
      return fetchAsrWithRetry(
        url,
        async () => ({
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/octet-stream',
            Accept: 'application/json',
          },
          body: audioBuffer,
        }),
        {
          timeoutMs,
          maxRetries,
          label: `cloudflare(${model})`,
        }
      );
    }

    const body = {
      audio: audioBuffer.toString('base64'),
    };
    if (providerCfg.vad_filter !== undefined) {
      body.vad_filter = Boolean(providerCfg.vad_filter);
    }
    if (language && language !== 'auto') {
      body.language = language;
    }
    if (prompt) {
      body.initial_prompt = prompt;
    }

    return fetchAsrWithRetry(
      url,
      async () => ({
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      }),
      {
        timeoutMs,
        maxRetries,
        label: `cloudflare(${model})`,
      }
    );
  };

  let res;
  try {
    res = await sendWithMode(primaryMode);
  } catch (err) {
    if (err instanceof AsrApiError && err.status === 400 && !configuredMode) {
      const altMode = primaryMode === 'base64_json' ? 'binary' : 'base64_json';
      res = await sendWithMode(altMode);
    } else {
      throw err;
    }
  }

  const envelope = res.json;
  if (envelope && envelope.success === false) {
    const errDetail = JSON.stringify(envelope.errors || envelope.messages || []);
    throw new Error(`Cloudflare Workers AI returned success=false: ${errDetail}`);
  }

  const result = envelope?.result ?? envelope ?? {};
  return parseCloudflareResult(result, chunk);
}

function parseCloudflareResult(result, chunk) {
  if (Array.isArray(result.segments) && result.segments.length > 0) {
    const mapped = [];
    for (const seg of result.segments) {
      if (seg.start !== undefined && seg.text !== undefined) {
        const text = cleanAsrText(seg.text);
        if (!text) continue;
        const relStart = Math.max(0, Number(seg.start || 0));
        const relEnd = Math.max(relStart + 0.05, Number(seg.end ?? chunk.durationSec));
        mapped.push({
          start: roundSec(chunk.startSec + relStart, 3),
          end: roundSec(Math.min(chunk.endSec + 1.0, chunk.startSec + relEnd), 3),
          text,
        });
      } else if (typeof seg.vtt === 'string') {
        const cues = parseVttOrSrt(seg.vtt, { merge: false });
        for (const c of cues) {
          mapped.push({
            start: roundSec(chunk.startSec + c.start, 3),
            end: roundSec(chunk.startSec + c.end, 3),
            text: c.text,
          });
        }
      }
    }
    if (mapped.length > 0) {
      return { segments: mapped };
    }
  }

  if (typeof result.vtt === 'string' && result.vtt.includes('-->')) {
    const cues = parseVttOrSrt(result.vtt, { merge: false });
    if (cues.length > 0) {
      return {
        segments: cues.map((c) => ({
          start: roundSec(chunk.startSec + c.start, 3),
          end: roundSec(chunk.startSec + c.end, 3),
          text: c.text,
        })),
      };
    }
  }

  const text = cleanAsrText(result.text || '');
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
