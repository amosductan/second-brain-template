// Bounded retry with exponential backoff + jitter for the two external API calls
// in the pipeline (Whisper transcribe, Claude categorize). A 429 or a 30-second
// network blip used to burn a note permanently — the audio was fine, the moment
// wasn't. Retrying is only correct for failures that might succeed on a second
// try; a real reject (bad audio, missing key, 4xx) must still fail fast and loud.

const TRANSIENT_STATUSES = new Set([408, 409, 425, 429]);
const TRANSIENT_NAMES = new Set([
  'AbortError', 'TimeoutError',
  'APIConnectionError', 'APIConnectionTimeoutError', // Anthropic SDK
]);
const TRANSIENT_MESSAGE = /fetch failed|network|socket hang up|other side closed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|terminated/i;

/** Errors we explicitly refuse to retry, regardless of shape. */
export function terminal(err) {
  err.terminal = true;
  return err;
}

export function isTransientError(err) {
  if (!err || err.terminal) return false;

  const status = err.status ?? err.statusCode ?? err.response?.status;
  // An HTTP status means the request DID land: only the server's own fault or a
  // rate limit is worth repeating. Every other 4xx is the caller's problem.
  if (typeof status === 'number') return status >= 500 || TRANSIENT_STATUSES.has(status);

  if (TRANSIENT_NAMES.has(String(err.name))) return true;
  if (TRANSIENT_MESSAGE.test(String(err.code || ''))) return true;
  return TRANSIENT_MESSAGE.test(String(err.message || ''));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs fn, retrying only transient failures: 3 attempts, ~1s -> 2s -> 4s with
 * +/-25% jitter so a burst of queued notes doesn't retry in lockstep.
 */
export async function withRetry(label, fn, { attempts = 3, baseDelay = 1000, onRetry } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= attempts || !isTransientError(err)) throw err;
      const delay = Math.round(baseDelay * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5));
      const why = err.status ?? err.code ?? err.name ?? 'error';
      console.warn(`[retry] ${label}: attempt ${attempt}/${attempts} failed (${why}: ${err.message}) — retrying in ${delay}ms`);
      if (onRetry) onRetry(attempt, delay, err);
      await sleep(delay);
    }
  }
}
