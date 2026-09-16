import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

// Minimal .env loader so we don't need a dotenv dependency. A real environment
// variable always wins over the file.
const envPath = path.join(repoRoot, '.env');
const fromFile = new Set();
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      fromFile.add(m[1]);
    }
  }
}

// True when a non-empty value came from the shell or service manager rather
// than .env. A stray OPENAI_API_KEY or DATA_DIR in someone's environment is
// used (and billed) silently otherwise; the startup banner names it.
export const fromShell = (name) => !fromFile.has(name) && (process.env[name] ?? '').trim() !== '';

const env = (name, fallback = '') => (process.env[name] ?? '').trim() || fallback;

// Which model provider runs the categorizer and chat. Blank picks one from the
// keys that are set, in this order. Naming one makes it the only one used.
const PROVIDERS = ['anthropic', 'openai', 'gemini', 'ollama'];
function pickProvider() {
  const named = env('LLM_PROVIDER').toLowerCase();
  if (named) {
    if (!PROVIDERS.includes(named)) {
      throw new Error(`LLM_PROVIDER=${named} is not one of ${PROVIDERS.join(', ')}.`);
    }
    return named;
  }
  if (env('ANTHROPIC_API_KEY')) return 'anthropic';
  if (env('OPENAI_API_KEY')) return 'openai';
  if (env('GEMINI_API_KEY')) return 'gemini';
  return 'none';
}

const provider = pickProvider();

// Per-provider defaults. Each can be overridden with CATEGORIZER_MODEL / CHAT_MODEL.
const DEFAULT_MODELS = {
  anthropic: { categorizer: 'claude-opus-5', chat: 'claude-opus-5' },
  openai: { categorizer: 'gpt-5.4-mini', chat: 'gpt-5.4-mini' },
  gemini: { categorizer: 'gemini-3.5-flash', chat: 'gemini-3.5-flash' },
  ollama: { categorizer: 'llama3.1', chat: 'llama3.1' },
  none: { categorizer: '', chat: '' },
};

// Where the OpenAI-compatible providers live. Gemini and Ollama both speak the
// OpenAI chat-completions protocol, so one adapter covers all three.
const DEFAULT_BASE_URLS = {
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  ollama: 'http://localhost:11434/v1',
};

const llmKey = {
  anthropic: env('ANTHROPIC_API_KEY'),
  openai: env('OPENAI_API_KEY'),
  gemini: env('GEMINI_API_KEY'),
  ollama: 'ollama', // Ollama ignores the key but the header must be present
  none: '',
}[provider];

const resolvedDataDir = path.resolve(repoRoot, env('DATA_DIR', 'data'));

export function transcribePrice(source = null) {
  const get = (k, d = '') => (source ? (source[k] ?? d) : env(k, d));
  const set = get('TRANSCRIBE_PRICE_PER_MIN');
  if (set !== '' && set != null) return Number(set) >= 0 ? Number(set) : null;
  const base = get('TRANSCRIBE_BASE_URL', 'https://api.openai.com/v1');
  return /^https:\/\/api\.openai\.com\b/.test(base) ? 0.006 : null;
}

export const config = {
  port: Number(env('PORT', '3000')),
  dataDir: resolvedDataDir,

  llm: {
    provider,
    apiKey: llmKey,
    baseUrl: env('LLM_BASE_URL', DEFAULT_BASE_URLS[provider] || '').replace(/\/+$/, ''),
    categorizerModel: env('CATEGORIZER_MODEL', DEFAULT_MODELS[provider].categorizer),
    chatModel: env('CHAT_MODEL', DEFAULT_MODELS[provider].chat),
    // Optional price per million tokens for models without a built-in price, so
    // the usage ledger can estimate a cost. Blank = tokens are logged, cost isn't.
    priceIn: env('LLM_PRICE_IN') ? Number(env('LLM_PRICE_IN')) : null,
    priceOut: env('LLM_PRICE_OUT') ? Number(env('LLM_PRICE_OUT')) : null,
  },

  // Transcription is a separate provider from the LLM: any server that speaks
  // OpenAI's /audio/transcriptions endpoint works (OpenAI, Groq, a local
  // faster-whisper server). Its key defaults to OPENAI_API_KEY.
  transcribe: {
    apiKey: env('TRANSCRIBE_API_KEY', env('OPENAI_API_KEY')),
    baseUrl: env('TRANSCRIBE_BASE_URL', 'https://api.openai.com/v1').replace(/\/+$/, ''),
    model: env('TRANSCRIBE_MODEL', 'whisper-1'),
    // USD per audio minute, for the usage ledger. whisper-1 lists at $0.006, so
    // that is the default only when the endpoint is OpenAI's. Anything else
    // (Groq, a local Whisper) is unpriced until you set it: a free server logged
    // at OpenAI's price would be a wrong number that looks measured.
    pricePerMinute: transcribePrice(),
  },

  authToken: env('AUTH_TOKEN'),

  // Optional: extra filing rules for the categorizer, one per line, in your own
  // words. Edit the file and the next note uses them; no restart needed.
  conventionsFile: path.join(resolvedDataDir, 'conventions.md'),

  // Optional second copy of the nightly database snapshot (a synced folder, a
  // NAS mount). Blank = snapshots stay in DATA_DIR/backups only.
  backupOffsiteDir: env('BACKUP_OFFSITE_DIR'),

  // Where the front-end bundle is served from, and what the asset fingerprint
  // hashes. One value, so the shell that goes out and the version that
  // describes it can never come from different places. Overridable only so
  // tests can run against a throwaway copy.
  publicDir: path.resolve(env('PUBLIC_DIR', path.join(repoRoot, 'public'))),
};

export const audioDir = path.join(config.dataDir, 'audio');
fs.mkdirSync(audioDir, { recursive: true });

export const uploadDir = path.join(config.dataDir, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
