import fs from 'node:fs';
import { getConfigFilePath } from '../config.js';
import { cleanAndMergeSegments } from '../parsers/subtitles.js';
import { mapWithConcurrency } from '../utils/exec.js';
import { transcribeChunkCloudflare } from './adapters/cloudflare.js';
import { transcribeChunkOpenAiChatAudio } from './adapters/openai-chat-audio.js';
import { transcribeChunkOpenAiTranscriptions } from './adapters/openai-transcriptions.js';
import { prepareAudioChunks } from './audio-chunker.js';

export class AsrConfigRequiredError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'AsrConfigRequiredError';
    this.code = 'ASR_CONFIG_REQUIRED';
    this.details = details;
  }
}

export const SUPPORTED_ASR_PROTOCOLS = new Set([
  'openai-transcriptions',
  'openai-chat-audio',
  'cloudflare',
]);

function resolveAdapter(protocol) {
  const normalized = String(protocol || '').trim().toLowerCase();
  switch (normalized) {
    case 'openai-transcriptions':
    case 'openai-transcription':
      return { protocol: 'openai-transcriptions', fn: transcribeChunkOpenAiTranscriptions };
    case 'openai-chat-audio':
      return { protocol: 'openai-chat-audio', fn: transcribeChunkOpenAiChatAudio };
    case 'cloudflare':
      return { protocol: 'cloudflare', fn: transcribeChunkCloudflare };
    default:
      return null;
  }
}

/**
 * Inspect redacted ASR configuration status for `video_auth_status` without leaking secrets.
 */
export function getAsrStatusSummary(asrConfig = {}) {
  const providerName = String(asrConfig.provider || '').trim();
  const providers = asrConfig.providers || {};
  const availableSlots = Object.keys(providers);

  if (!providerName) {
    return {
      provider: null,
      ready: false,
      status: 'provider_not_selected',
      available_providers: availableSlots,
    };
  }

  const chosen = providers[providerName];
  if (!chosen || typeof chosen !== 'object') {
    return {
      provider: providerName,
      ready: false,
      status: 'provider_not_found',
      available_providers: availableSlots,
    };
  }

  const adapter = resolveAdapter(chosen.protocol);
  const missing = [];
  if (!adapter) missing.push('valid_protocol');
  if (!String(chosen.model || '').trim()) missing.push('model');
  if (!String(chosen.api_key || '').trim()) missing.push('api_key');
  if (adapter?.protocol === 'cloudflare' && !String(chosen.account_id || '').trim()) {
    missing.push('account_id');
  }

  return {
    provider: providerName,
    protocol: adapter?.protocol || chosen.protocol || null,
    model: chosen.model || null,
    ready: missing.length === 0,
    status: missing.length === 0 ? 'ready' : 'missing_credentials',
    missing_fields: missing.length > 0 ? missing : undefined,
  };
}

/**
 * Enforce strict explicit single-provider selection when ASR is triggered.
 * Never guesses a fallback provider even if multiple API keys exist in config.yaml.
 */
export function requireValidAsrProvider(asrConfig = {}) {
  const cfgPath = getConfigFilePath();
  const status = getAsrStatusSummary(asrConfig);

  if (!status.provider) {
    throw new AsrConfigRequiredError(
      `This video has no native subtitles (or is a local video with audio) and requires cloud ASR, but \`asr.provider\` is not set.\n` +
        `Please explicitly set \`asr.provider\` (e.g. "siliconflow", "mimo", or "cloudflare") and its credentials in ${cfgPath} (or via VIDEO_CONTEXT_ASR_PROVIDER).`,
      status
    );
  }

  if (status.status === 'provider_not_found') {
    throw new AsrConfigRequiredError(
      `Configured \`asr.provider: "${status.provider}"\` does not exist under \`asr.providers\` in ${cfgPath}. Available providers: ${status.available_providers.join(', ')}`,
      status
    );
  }

  if (!status.ready) {
    throw new AsrConfigRequiredError(
      `Configured ASR provider "${status.provider}" is missing required field(s): ${status.missing_fields.join(', ')}. Please complete \`asr.providers.${status.provider}\` in ${cfgPath}.`,
      status
    );
  }

  const providerCfg = asrConfig.providers[status.provider];
  const adapter = resolveAdapter(providerCfg.protocol);

  return {
    providerName: status.provider,
    providerCfg,
    protocol: adapter.protocol,
    adapterFn: adapter.fn,
  };
}

/**
 * End-to-end audio chunking + single-provider cloud ASR execution.
 */
export async function transcribeAudioMedia({
  audioMediaPath,
  cacheDir,
  asrConfig,
  resolvedProvider,
  timeoutMs: budgetTimeoutMs,
  signal = null,
  onProgress = null,
}) {
  const { providerName, providerCfg, protocol, adapterFn } =
    resolvedProvider || requireValidAsrProvider(asrConfig);

  if (onProgress) onProgress('slicing_audio_chunks');
  const prepared = await prepareAudioChunks(audioMediaPath, cacheDir, asrConfig, providerCfg, signal);
  if (prepared.chunks.length === 0) {
    return {
      segments: [],
      providerName,
      protocol,
      model: providerCfg.model,
    };
  }

  console.error(
    `[video-context] Running cloud ASR via [${providerName}/${protocol}] on ${prepared.chunks.length} chunk(s) (${prepared.chunkTier}, ${Math.round(prepared.durationSec)}s audio)...`
  );

  const concurrency = Math.max(1, Math.min(8, Number(asrConfig.concurrency || 2)));
  const configuredReqMs = Math.max(15, Number(asrConfig.request_timeout_sec || 300)) * 1000;
  const effectiveReqMs = budgetTimeoutMs ? Math.min(configuredReqMs, budgetTimeoutMs) : configuredReqMs;
  const maxRetries = Math.max(0, Number(asrConfig.max_retries ?? 2));
  const language = asrConfig.language || 'auto';
  const prompt = asrConfig.prompt || '';
  const cacheKeyTag = `${providerName}:${protocol}:${providerCfg.model}:${language}`;

  let completedChunks = 0;
  let resumedFromCache = 0;
  if (onProgress) {
    onProgress(`0/${prepared.chunks.length} chunks (${providerName})`);
  }

  const chunkOutputs = await mapWithConcurrency(
    prepared.chunks,
    concurrency,
    async (chunk) => {
      const chunkResultPath = `${chunk.filePath}.result.json`;
      if (fs.existsSync(chunkResultPath)) {
        try {
          const cached = JSON.parse(await fs.promises.readFile(chunkResultPath, 'utf8'));
          if (cached && cached.cacheKeyTag === cacheKeyTag && Array.isArray(cached.segments)) {
            completedChunks += 1;
            resumedFromCache += 1;
            if (onProgress) {
              onProgress(`${completedChunks}/${prepared.chunks.length} chunks (${providerName})`);
            }
            return { segments: cached.segments };
          }
        } catch {
          // ignore corrupt cache file and re-transcribe this chunk
        }
      }

      const out = await adapterFn({
        chunk,
        providerCfg,
        language,
        prompt,
        timeoutMs: effectiveReqMs,
        maxRetries,
        signal,
      });

      const tmpResultPath = `${chunkResultPath}.tmp`;
      await fs.promises.writeFile(
        tmpResultPath,
        JSON.stringify({ cacheKeyTag, segments: out.segments || [] }),
        'utf8'
      );
      await fs.promises.rename(tmpResultPath, chunkResultPath);

      completedChunks += 1;
      if (onProgress) {
        onProgress(`${completedChunks}/${prepared.chunks.length} chunks (${providerName})`);
      }
      return out;
    },
    signal
  );

  if (resumedFromCache > 0) {
    console.error(
      `[video-context] Resumed ${resumedFromCache}/${prepared.chunks.length} previously completed ASR chunk(s) from cache.`
    );
  }

  const rawSegments = chunkOutputs.flatMap((o) => o.segments || []);
  const mergedSegments = cleanAndMergeSegments(rawSegments);

  console.error(
    `[video-context] Cloud ASR [${providerName}] completed -> ${mergedSegments.length} merged subtitle line(s).`
  );

  return {
    segments: mergedSegments,
    providerName,
    protocol,
    model: providerCfg.model,
  };
}
