import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

export const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const EXAMPLE_CONFIG_PATH = path.join(PROJECT_ROOT, 'config.example.yaml');
const IS_INSTALLED_IN_NODE_MODULES = PROJECT_ROOT.includes(`${path.sep}node_modules${path.sep}`);
const DEFAULT_OUTPUT_PATH = IS_INSTALLED_IN_NODE_MODULES
  ? path.join(os.homedir(), 'video-context-output')
  : './output';

let runtimeOutputDir = null;

export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const REFERERS = {
  bilibili: 'https://www.bilibili.com/',
  youtube: 'https://www.youtube.com/',
};

export const DEFAULT_CONFIG = {
  output: {
    dir: DEFAULT_OUTPUT_PATH,
    keep_video_cache: false,
  },
  runtime: {
    timeout_sec: 300,
    rpc_wait_sec: 45,
  },
  auth: {
    bilibili_cookie: '',
    allow_guest_degraded: false,
  },
  asr: {
    provider: '',
    language: 'auto',
    prompt: '',
    max_duration_sec: 7200,
    concurrency: 6,
    request_timeout_sec: 300,
    max_retries: 2,
    providers: {
      siliconflow: {
        protocol: 'openai-transcriptions',
        base_url: 'https://api.siliconflow.cn/v1',
        endpoint_path: '/audio/transcriptions',
        api_key: '',
        model: 'FunAudioLLM/SenseVoiceSmall',
        response_format: '',
        auth_header: 'Authorization',
        auth_prefix: 'Bearer ',
      },
      mimo: {
        protocol: 'openai-chat-audio',
        base_url: 'https://api.xiaomimimo.com/v1',
        endpoint_path: '/chat/completions',
        api_key: '',
        model: 'mimo-v2.5-asr',
        audio_data_style: 'data_url',
        user_prompt: '',
        include_asr_options: true,
        auth_header: 'Authorization',
        auth_prefix: 'Bearer ',
      },
      cloudflare: {
        protocol: 'cloudflare',
        base_url: 'https://api.cloudflare.com/client/v4',
        account_id: '',
        api_key: '',
        model: '@cf/openai/whisper-large-v3-turbo',
        payload_mode: 'base64_json',
        vad_filter: true,
      },
    },
  },
  sampling: {
    probe_fps: 2.5,
    diff_threshold: 0.15,
    settle_threshold: 0.045,
    min_interval_sec: 0.8,
    max_interval_sec: 15.0,
    max_frames: 180,
  },
  grid: {
    cols: 3,
    rows: 3,
    cell_width: 640,
    cell_height: 360,
    header_height: 24,
    gutter: 8,
    jpeg_quality: 85,
  },
  binaries: {
    yt_dlp: '',
    ffmpeg: '',
    ffprobe: '',
  },
};

/**
 * Complete 1-to-1 mapping between config.yaml dot-paths and external Environment Variables.
 */
export const ENV_VAR_MAP = {
  'output.dir': { env: 'VIDEO_CONTEXT_OUTPUT_DIR', type: 'string' },
  'output.keep_video_cache': { env: 'VIDEO_CONTEXT_KEEP_VIDEO_CACHE', type: 'boolean' },
  'runtime.timeout_sec': { env: 'VIDEO_CONTEXT_TIMEOUT_SEC', type: 'integer' },
  'runtime.rpc_wait_sec': { env: 'VIDEO_CONTEXT_RPC_WAIT_SEC', type: 'integer' },
  'auth.bilibili_cookie': { env: 'BILIBILI_COOKIE', type: 'string' },
  'auth.allow_guest_degraded': { env: 'VIDEO_CONTEXT_ALLOW_GUEST', type: 'boolean' },

  'asr.provider': { env: 'VIDEO_CONTEXT_ASR_PROVIDER', type: 'string' },
  'asr.language': { env: 'VIDEO_CONTEXT_ASR_LANGUAGE', type: 'string' },
  'asr.prompt': { env: 'VIDEO_CONTEXT_ASR_PROMPT', type: 'string' },
  'asr.max_duration_sec': { env: 'VIDEO_CONTEXT_ASR_MAX_DURATION_SEC', type: 'integer' },
  'asr.concurrency': { env: 'VIDEO_CONTEXT_ASR_CONCURRENCY', type: 'integer' },
  'asr.request_timeout_sec': { env: 'VIDEO_CONTEXT_ASR_REQUEST_TIMEOUT_SEC', type: 'integer' },
  'asr.max_retries': { env: 'VIDEO_CONTEXT_ASR_MAX_RETRIES', type: 'integer' },

  'asr.providers.siliconflow.protocol': { env: 'SILICONFLOW_PROTOCOL', type: 'string' },
  'asr.providers.siliconflow.base_url': { env: 'SILICONFLOW_BASE_URL', type: 'string' },
  'asr.providers.siliconflow.endpoint_path': { env: 'SILICONFLOW_ENDPOINT_PATH', type: 'string' },
  'asr.providers.siliconflow.api_key': { env: 'SILICONFLOW_API_KEY', type: 'string' },
  'asr.providers.siliconflow.model': { env: 'SILICONFLOW_MODEL', type: 'string' },
  'asr.providers.siliconflow.response_format': { env: 'SILICONFLOW_RESPONSE_FORMAT', type: 'string' },
  'asr.providers.siliconflow.auth_header': { env: 'SILICONFLOW_AUTH_HEADER', type: 'string' },
  'asr.providers.siliconflow.auth_prefix': { env: 'SILICONFLOW_AUTH_PREFIX', type: 'string' },

  'asr.providers.mimo.protocol': { env: 'MIMO_PROTOCOL', type: 'string' },
  'asr.providers.mimo.base_url': { env: 'MIMO_BASE_URL', type: 'string' },
  'asr.providers.mimo.endpoint_path': { env: 'MIMO_ENDPOINT_PATH', type: 'string' },
  'asr.providers.mimo.api_key': { env: 'MIMO_API_KEY', type: 'string' },
  'asr.providers.mimo.model': { env: 'MIMO_MODEL', type: 'string' },
  'asr.providers.mimo.audio_data_style': { env: 'MIMO_AUDIO_DATA_STYLE', type: 'string' },
  'asr.providers.mimo.user_prompt': { env: 'MIMO_USER_PROMPT', type: 'string' },
  'asr.providers.mimo.include_asr_options': { env: 'MIMO_INCLUDE_ASR_OPTIONS', type: 'boolean' },
  'asr.providers.mimo.auth_header': { env: 'MIMO_AUTH_HEADER', type: 'string' },
  'asr.providers.mimo.auth_prefix': { env: 'MIMO_AUTH_PREFIX', type: 'string' },

  'asr.providers.cloudflare.protocol': { env: 'CLOUDFLARE_PROTOCOL', type: 'string' },
  'asr.providers.cloudflare.base_url': { env: 'CLOUDFLARE_BASE_URL', type: 'string' },
  'asr.providers.cloudflare.account_id': { env: 'CLOUDFLARE_ACCOUNT_ID', type: 'string' },
  'asr.providers.cloudflare.api_key': { env: 'CLOUDFLARE_API_KEY', type: 'string' },
  'asr.providers.cloudflare.model': { env: 'CLOUDFLARE_MODEL', type: 'string' },
  'asr.providers.cloudflare.payload_mode': { env: 'CLOUDFLARE_PAYLOAD_MODE', type: 'string' },
  'asr.providers.cloudflare.vad_filter': { env: 'CLOUDFLARE_VAD_FILTER', type: 'boolean' },

  'sampling.probe_fps': { env: 'VIDEO_CONTEXT_PROBE_FPS', type: 'number' },
  'sampling.diff_threshold': { env: 'VIDEO_CONTEXT_DIFF_THRESHOLD', type: 'number' },
  'sampling.settle_threshold': { env: 'VIDEO_CONTEXT_SETTLE_THRESHOLD', type: 'number' },
  'sampling.min_interval_sec': { env: 'VIDEO_CONTEXT_MIN_INTERVAL_SEC', type: 'number' },
  'sampling.max_interval_sec': { env: 'VIDEO_CONTEXT_MAX_INTERVAL_SEC', type: 'number' },
  'sampling.max_frames': { env: 'VIDEO_CONTEXT_MAX_FRAMES', type: 'integer' },
  'grid.cols': { env: 'VIDEO_CONTEXT_GRID_COLS', type: 'integer' },
  'grid.rows': { env: 'VIDEO_CONTEXT_GRID_ROWS', type: 'integer' },
  'grid.cell_width': { env: 'VIDEO_CONTEXT_CELL_WIDTH', type: 'integer' },
  'grid.cell_height': { env: 'VIDEO_CONTEXT_CELL_HEIGHT', type: 'integer' },
  'grid.header_height': { env: 'VIDEO_CONTEXT_HEADER_HEIGHT', type: 'integer' },
  'grid.gutter': { env: 'VIDEO_CONTEXT_GRID_GUTTER', type: 'integer' },
  'grid.jpeg_quality': { env: 'VIDEO_CONTEXT_JPEG_QUALITY', type: 'integer' },
  'binaries.yt_dlp': { env: 'YTDLP_PATH', type: 'string' },
  'binaries.ffmpeg': { env: 'FFMPEG_PATH', type: 'string' },
  'binaries.ffprobe': { env: 'FFPROBE_PATH', type: 'string' },
};

export function getConfigFilePath() {
  if (process.env.VIDEO_CONTEXT_CONFIG_PATH && process.env.VIDEO_CONTEXT_CONFIG_PATH.trim()) {
    return path.resolve(process.env.VIDEO_CONTEXT_CONFIG_PATH.trim());
  }
  return path.join(PROJECT_ROOT, 'config.yaml');
}

function readYamlConfigObject() {
  const cfgPath = getConfigFilePath();
  if (!fs.existsSync(cfgPath)) return {};
  try {
    const raw = fs.readFileSync(cfgPath, 'utf8');
    const parsed = YAML.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    console.error(`[video-context] Failed to parse ${cfgPath}: ${err.message}`);
    return {};
  }
}

/**
 * Load merged effective configuration:
 * Precedence: Startup CLI override > Environment Variables > config.yaml > DEFAULT_CONFIG
 * Also preserves any custom provider slots added under `asr.providers.*` in config.yaml.
 */
export function loadEffectiveConfig() {
  const yamlObj = readYamlConfigObject();
  const merged = structuredClone(DEFAULT_CONFIG);
  const activeEnvOverrides = [];

  if (yamlObj?.asr?.providers && typeof yamlObj.asr.providers === 'object') {
    for (const [pName, pVal] of Object.entries(yamlObj.asr.providers)) {
      if (pVal && typeof pVal === 'object') {
        merged.asr.providers[pName] = {
          ...(merged.asr.providers[pName] || {}),
          ...structuredClone(pVal),
        };
      }
    }
  }

  // Also preserve optional user-tuned `asr.chunking` or `asr.audio` overrides if placed in config.yaml
  if (yamlObj?.asr?.chunking && typeof yamlObj.asr.chunking === 'object') {
    merged.asr.chunking = structuredClone(yamlObj.asr.chunking);
  }
  if (yamlObj?.asr?.audio && typeof yamlObj.asr.audio === 'object') {
    merged.asr.audio = structuredClone(yamlObj.asr.audio);
  }

  for (const dotPath of Object.keys(ENV_VAR_MAP)) {
    const val = getByPath(yamlObj, dotPath);
    if (val !== undefined && val !== null) {
      setByPath(merged, dotPath, coerceValue(val, ENV_VAR_MAP[dotPath].type));
    }
  }

  for (const [dotPath, spec] of Object.entries(ENV_VAR_MAP)) {
    const envRaw = process.env[spec.env];
    if (envRaw !== undefined && envRaw !== '') {
      const coerced = coerceValue(envRaw, spec.type);
      if (coerced !== undefined) {
        setByPath(merged, dotPath, coerced);
        activeEnvOverrides.push(spec.env);
      }
    }
  }

  if (runtimeOutputDir) {
    merged.output.dir = runtimeOutputDir;
  }

  return {
    config: merged,
    configFilePath: getConfigFilePath(),
    configFileExists: fs.existsSync(getConfigFilePath()),
    activeEnvOverrides,
  };
}

/**
 * Persist partial dot-path updates into config.yaml while preserving YAML comments.
 */
export async function saveConfigUpdates(updates = {}) {
  const cfgPath = getConfigFilePath();
  await fs.promises.mkdir(path.dirname(cfgPath), { recursive: true });

  let doc;
  if (fs.existsSync(cfgPath)) {
    doc = YAML.parseDocument(await fs.promises.readFile(cfgPath, 'utf8'));
  } else if (fs.existsSync(EXAMPLE_CONFIG_PATH)) {
    doc = YAML.parseDocument(await fs.promises.readFile(EXAMPLE_CONFIG_PATH, 'utf8'));
  } else {
    doc = new YAML.Document(structuredClone(DEFAULT_CONFIG));
  }

  for (const [dotPath, rawVal] of Object.entries(updates)) {
    if (rawVal === undefined) continue;
    const spec = ENV_VAR_MAP[dotPath];
    if (!spec && !dotPath.startsWith('asr.providers.')) {
      throw new Error(`Unknown configuration key: "${dotPath}"`);
    }
    const coerced = spec ? coerceValue(rawVal, spec.type) : rawVal;
    doc.setIn(dotPath.split('.'), coerced);
  }

  await fs.promises.writeFile(cfgPath, doc.toString(), 'utf8');
  if (updates['output.dir']) {
    runtimeOutputDir = null;
  }
  return loadEffectiveConfig();
}

export function maskConfigSecrets(config) {
  const copy = structuredClone(config);
  if (copy.auth?.bilibili_cookie) {
    const len = copy.auth.bilibili_cookie.length;
    copy.auth.bilibili_cookie = `<configured: ${len} chars>`;
  }
  if (copy.asr?.providers && typeof copy.asr.providers === 'object') {
    for (const prov of Object.values(copy.asr.providers)) {
      if (prov && typeof prov === 'object' && prov.api_key) {
        const len = String(prov.api_key).length;
        prov.api_key = `<configured: ${len} chars>`;
      }
    }
  }
  return copy;
}

export function setRuntimeOutputDir(dirPath) {
  if (dirPath && typeof dirPath === 'string' && dirPath.trim()) {
    runtimeOutputDir = resolvePathFromProject(dirPath.trim());
  }
}

export function resolvePathFromProject(targetPath) {
  if (path.isAbsolute(targetPath)) return path.normalize(targetPath);
  return path.resolve(PROJECT_ROOT, targetPath);
}

export function resolveOutputDir(outputDirOverride) {
  if (outputDirOverride && typeof outputDirOverride === 'string' && outputDirOverride.trim()) {
    return path.resolve(outputDirOverride.trim());
  }
  const { config } = loadEffectiveConfig();
  return resolvePathFromProject(config.output.dir || DEFAULT_OUTPUT_PATH);
}

export function getBilibiliCookieConfig() {
  const { config, configFilePath } = loadEffectiveConfig();
  const fromEnv = Boolean(process.env.BILIBILI_COOKIE && process.env.BILIBILI_COOKIE.trim());
  const rawValue = config.auth.bilibili_cookie || '';
  return {
    raw: rawValue,
    source: fromEnv ? 'env:BILIBILI_COOKIE' : rawValue ? `yaml:${configFilePath}` : 'none',
    allowGuestDegraded: Boolean(config.auth.allow_guest_degraded),
  };
}

export function getTimeoutMs() {
  const { config } = loadEffectiveConfig();
  const sec = Number(config.runtime?.timeout_sec || 300);
  return Math.max(15, Number.isFinite(sec) ? sec : 300) * 1000;
}

export function getRpcWaitMs() {
  const { config } = loadEffectiveConfig();
  const sec = Number(config.runtime?.rpc_wait_sec ?? 45);
  if (!Number.isFinite(sec) || sec <= 0) return 0;
  return Math.max(5, sec) * 1000;
}

export function getGridSpec() {
  const { config } = loadEffectiveConfig();
  return {
    cols: config.grid.cols,
    rows: config.grid.rows,
    cellWidth: config.grid.cell_width,
    cellHeight: config.grid.cell_height,
    headerHeight: config.grid.header_height,
    gutter: config.grid.gutter,
    jpegQuality: config.grid.jpeg_quality,
  };
}

const EXTRA_BIN_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  path.join(os.homedir(), '.local', 'bin'),
];

const BIN_CONFIG_KEY = {
  'yt-dlp': 'yt_dlp',
  ffmpeg: 'ffmpeg',
  ffprobe: 'ffprobe',
};

export function resolveBinary(name) {
  const { config } = loadEffectiveConfig();
  const cfgField = BIN_CONFIG_KEY[name];
  const configuredPath = cfgField ? config.binaries?.[cfgField] : '';
  if (configuredPath && configuredPath.trim()) {
    return resolvePathFromProject(configuredPath.trim());
  }

  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const searchDirs = [...new Set([...pathDirs, ...EXTRA_BIN_DIRS])];
  for (const dir of searchDirs) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // continue searching
    }
  }
  return name;
}

export function getEnhancedEnv() {
  const currentPath = process.env.PATH || '';
  const merged = [
    ...new Set([...currentPath.split(path.delimiter).filter(Boolean), ...EXTRA_BIN_DIRS]),
  ].join(path.delimiter);
  return {
    ...process.env,
    PATH: merged,
  };
}

function getByPath(obj, dotPath) {
  return dotPath.split('.').reduce((acc, key) => (acc && typeof acc === 'object' ? acc[key] : undefined), obj);
}

function setByPath(obj, dotPath, value) {
  const keys = dotPath.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!cur[keys[i]] || typeof cur[keys[i]] !== 'object') {
      cur[keys[i]] = {};
    }
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

function coerceValue(val, type) {
  if (type === 'string') return String(val);
  if (type === 'boolean') {
    if (typeof val === 'boolean') return val;
    const s = String(val).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(s)) return true;
    if (['false', '0', 'no', 'off'].includes(s)) return false;
    return Boolean(val);
  }
  if (type === 'integer') {
    const n = parseInt(String(val), 10);
    return Number.isFinite(n) ? n : undefined;
  }
  if (type === 'number') {
    const n = parseFloat(String(val));
    return Number.isFinite(n) ? n : undefined;
  }
  return val;
}
