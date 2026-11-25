import fs from 'node:fs';
import { cleanAsrText, parseVttOrSrt } from '../../parsers/subtitles.js';
import { roundSec } from '../../utils/time.js';
import { AsrApiError, buildAuthHeaders, fetchAsrWithRetry } from '../http-client.js';

export async function transcribeChunkOpenAiChatAudio({
  chunk,
  providerCfg,
  language = 'auto',
  prompt = '',
  timeoutMs = 300_000,
  maxRetries = 2,
  signal = null,
}) {
  const baseUrl = String(providerCfg.base_url || 'https://api.xiaomimimo.com/v1').replace(/\/+$/, '');
  const endpointPath = String(providerCfg.endpoint_path || '/chat/completions');
  const url = `${baseUrl}${endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`}`;
  const model = String(providerCfg.model || '').trim();

  const authHeaders = buildAuthHeaders(providerCfg);
  const audioBuffer = await fs.promises.readFile(chunk.filePath);
  const base64Raw = audioBuffer.toString('base64');
  const format = chunk.codec === 'wav' ? 'wav' : 'mp3';
  const mimeType = format === 'wav' ? 'audio/wav' : 'audio/mpeg';

  const isMimoLike = /xiaomimimo/i.test(baseUrl) || /\bmimo\b/i.test(model);
  const styleCfg = String(providerCfg.audio_data_style || 'auto').toLowerCase();
  const primaryStyle =
    styleCfg === 'data_url' || styleCfg === 'raw_base64'
      ? styleCfg
      : isMimoLike
        ? 'data_url'
        : 'raw_base64';

  const userPrompt = String(providerCfg.user_prompt || prompt || '').trim();
  const includeAsrOptions =
    providerCfg.include_asr_options !== undefined
      ? Boolean(providerCfg.include_asr_options)
      : isMimoLike;

  const sendWithAudioStyle = async (style) => {
    const inputAudioObj =
      style === 'data_url'
        ? { data: `data:${mimeType};base64,${base64Raw}` }
        : { data: base64Raw, format };

    const content = [{ type: 'input_audio', input_audio: inputAudioObj }];
    if (userPrompt) {
      content.push({ type: 'text', text: userPrompt });
    }

    const payload = {
      model,
      messages: [
        {
          role: 'user',
          content,
        },
      ],
    };

    if (includeAsrOptions) {
      payload.asr_options = {
        language: language || 'auto',
      };
    }

    const extraHeaders = { ...authHeaders };
    if (/xiaomimimo/i.test(baseUrl) && providerCfg.api_key && !extraHeaders['api-key']) {
      extraHeaders['api-key'] = String(providerCfg.api_key).trim();
    }

    return fetchAsrWithRetry(
      url,
      async () => ({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...extraHeaders,
        },
        body: JSON.stringify(payload),
      }),
      {
        timeoutMs,
        maxRetries,
        label: `openai-chat-audio(${model})`,
        signal,
      }
    );
  };

  let res;
  try {
    res = await sendWithAudioStyle(primaryStyle);
  } catch (err) {
    if (err instanceof AsrApiError && err.status === 400 && styleCfg === 'auto') {
      const altStyle = primaryStyle === 'data_url' ? 'raw_base64' : 'data_url';
      res = await sendWithAudioStyle(altStyle);
    } else {
      throw err;
    }
  }

  const rawContent = extractChatMessageText(res.json);
  if (rawContent.includes('-->')) {
    const cues = parseVttOrSrt(rawContent, { merge: false });
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

  const text = cleanAsrText(rawContent);
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

function extractChatMessageText(json) {
  if (!json || typeof json !== 'object') return '';
  const msg = json.choices?.[0]?.message;
  if (!msg) return typeof json.text === 'string' ? json.text : '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .filter(Boolean)
      .join(' ');
  }
  return '';
}
