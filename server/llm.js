// Every model call in the app goes through this file. It does three jobs:
//   1. picks the provider from config (Anthropic, or anything that speaks the
//      OpenAI chat-completions protocol: OpenAI, Gemini, Ollama, a local server),
//   2. retries only failures worth retrying (see retry.js),
//   3. writes every call's token counts, and a cost where one can be priced, to
//      the model_usage table, so "what is this costing me?" has a real answer.
//
// Two shapes are all the app needs: a structured-JSON completion (the
// categorizer) and a tool loop (chat searching your notes).

import Anthropic from '@anthropic-ai/sdk';
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import { config } from './config.js';
import { withRetry, terminal } from './retry.js';
import { recordUsage } from './db.js';

export function llmAvailable() {
  return config.llm.provider !== 'none' && Boolean(config.llm.apiKey);
}

export function llmDescription() {
  if (!llmAvailable()) return 'off';
  const { provider, categorizerModel, chatModel } = config.llm;
  return categorizerModel === chatModel
    ? `${provider} (${categorizerModel})`
    : `${provider} (categorizer ${categorizerModel}, chat ${chatModel})`;
}

// ---- pricing -----------------------------------------------------------------
// USD per million tokens, Anthropic list prices. Other providers' prices change
// too often to ship; set LLM_PRICE_IN / LLM_PRICE_OUT to have them estimated.
const ANTHROPIC_PRICES = {
  'claude-fable-5-1': [10, 50],
  'claude-fable-5': [10, 50],
  'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25],
  'claude-opus-4-7': [5, 25],
  'claude-opus-4-6': [5, 25],
  'claude-sonnet-5': [2, 10],
  'claude-sonnet-4-6': [3, 15],
  'claude-haiku-4-5': [1, 5],
};

function priceFor(model) {
  if (config.llm.priceIn != null && config.llm.priceOut != null) {
    return [config.llm.priceIn, config.llm.priceOut];
  }
  return ANTHROPIC_PRICES[model] || null;
}

/**
 * Cache writes bill at 1.25x input and reads at 0.1x on Anthropic. The OpenAI
 * protocol reports cached tokens as a subset of prompt tokens; the adapter
 * normalizes that before it gets here, so `input` is always the uncached part.
 */
function estimateCost(model, { input = 0, output = 0, cacheRead = 0, cacheWrite = 0 }) {
  const p = priceFor(model);
  if (!p) return { cost: null, basis: 'unpriced' };
  const [pin, pout] = p;
  const cost = (input * pin + cacheWrite * pin * 1.25 + cacheRead * pin * 0.1 + output * pout) / 1e6;
  return { cost, basis: 'estimated' };
}

function logUsage(purpose, model, tokens, extra = {}) {
  const { cost, basis } = estimateCost(model, tokens);
  try {
    recordUsage({
      purpose,
      provider: config.llm.provider,
      model,
      input_tokens: tokens.input || 0,
      output_tokens: tokens.output || 0,
      cache_read_tokens: tokens.cacheRead || 0,
      cache_write_tokens: tokens.cacheWrite || 0,
      cost_usd: cost,
      cost_basis: basis,
      ...extra,
    });
  } catch (err) {
    // The ledger must never be why a note fails to process.
    console.error('[usage] could not record:', err.message);
  }
}

// ---- Anthropic -----------------------------------------------------------------

// Pre-4.6 models take neither adaptive thinking nor effort, and reject both.
const LEGACY_ANTHROPIC = /claude-(3|opus-4-[015]|sonnet-4-[05]|haiku-4-5)/;

// Opus 5 and Fable 5.1 can decline a request on a safety classifier. With
// server-side fallbacks on, the API re-runs a declined request on a model that
// will take it, inside the same call, so a note never fails over a false alarm.
const FALLBACK_MODELS = /^claude-(opus-5|fable-5-1)$/;

function anthropicParams(model, { effort } = {}) {
  const p = {};
  if (!LEGACY_ANTHROPIC.test(model)) {
    p.thinking = { type: 'adaptive' };
    if (effort) p.output_config = { effort };
  }
  if (FALLBACK_MODELS.test(model)) {
    p.betas = ['server-side-fallback-2026-07-01'];
    p.fallbacks = 'default';
  }
  return p;
}

function anthropicTokens(usage = {}) {
  return {
    input: usage.input_tokens || 0,
    output: usage.output_tokens || 0,
    cacheRead: usage.cache_read_input_tokens || 0,
    cacheWrite: usage.cache_creation_input_tokens || 0,
  };
}

function anthropicClient() {
  // Retries are ours (retry.js), so the SDK's own are off; otherwise a failure
  // would be retried up to nine times and logged as three.
  return new Anthropic({ apiKey: config.llm.apiKey, maxRetries: 0 });
}

function checkRefusal(message) {
  if (message.stop_reason === 'refusal') {
    const why = message.stop_details?.explanation || message.stop_details?.category || 'no reason given';
    throw terminal(new Error(`The model declined this request (${why}).`));
  }
}

async function anthropicJSON({ purpose, noteId, model, system, user, schema, effort }) {
  const client = anthropicClient();
  const base = anthropicParams(model, { effort });
  const response = await withRetry(purpose, () => client.beta.messages.create({
    model,
    max_tokens: 16000,
    ...base,
    output_config: { ...(base.output_config || {}), format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content: user }],
  }));
  logUsage(purpose, response.model || model, anthropicTokens(response.usage), { note_id: noteId });
  checkRefusal(response);
  const text = response.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error(`${purpose}: no text in the response (stop_reason: ${response.stop_reason})`);
  return JSON.parse(text);
}

async function anthropicTools({ purpose, model, system, messages, tools, maxIterations }) {
  const client = anthropicClient();
  const runner = client.beta.messages.toolRunner({
    model,
    max_tokens: 16000,
    ...anthropicParams(model),
    // The runner re-sends tools + system + the whole growing conversation on
    // every iteration, and a get_note result is a full transcript. Top-level
    // cache_control puts the breakpoint on the last cacheable block each time,
    // so iteration N reads what N-1 wrote instead of paying full price again.
    cache_control: { type: 'ephemeral' },
    system,
    tools: tools.map((t) => betaTool({
      name: t.name,
      description: t.description,
      inputSchema: t.schema,
      run: t.run,
    })),
    messages,
    max_iterations: maxIterations,
  });

  // Each iteration is its own billed request, so each is logged.
  let last = null;
  for await (const message of runner) {
    logUsage(purpose, message.model || model, anthropicTokens(message.usage));
    last = message;
  }
  if (!last) throw new Error(`${purpose}: the model returned nothing.`);
  checkRefusal(last);
  return last.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

// ---- OpenAI-compatible (OpenAI, Gemini, Ollama, local servers) ------------------

async function chatCompletion(purpose, body) {
  return withRetry(purpose, async () => {
    const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.llm.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`${config.llm.provider} ${res.status}: ${text.slice(0, 500)}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  });
}

function openaiTokens(usage = {}) {
  const cached = usage.prompt_tokens_details?.cached_tokens || 0;
  return {
    input: Math.max(0, (usage.prompt_tokens || 0) - cached),
    output: usage.completion_tokens || 0,
    cacheRead: cached,
  };
}

async function openaiJSON({ purpose, noteId, model, system, user, schema }) {
  const data = await chatCompletion(purpose, {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    response_format: { type: 'json_schema', json_schema: { name: 'result', strict: true, schema } },
  });
  logUsage(purpose, data.model || model, openaiTokens(data.usage), { note_id: noteId });
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error(`${purpose}: no content in the response (finish_reason: ${data.choices?.[0]?.finish_reason})`);
  // Some servers wrap JSON in a code fence even in JSON mode.
  return JSON.parse(text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ''));
}

async function openaiTools({ purpose, model, system, messages, tools, maxIterations }) {
  const convo = [{ role: 'system', content: system }, ...messages];
  const toolDefs = tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.schema },
  }));
  const byName = new Map(tools.map((t) => [t.name, t]));

  for (let i = 0; i <= maxIterations; i++) {
    // On the last pass, tools are withheld so the loop always ends in an answer.
    const final = i === maxIterations;
    const data = await chatCompletion(purpose, {
      model,
      messages: convo,
      ...(final ? {} : { tools: toolDefs }),
    });
    logUsage(purpose, data.model || model, openaiTokens(data.usage));
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error(`${purpose}: no message in the response.`);
    const calls = msg.tool_calls || [];
    if (!calls.length) return (msg.content || '').trim();

    convo.push(msg);
    for (const call of calls) {
      const tool = byName.get(call.function?.name);
      let result;
      try {
        const args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
        result = tool ? await tool.run(args) : `Unknown tool: ${call.function?.name}`;
      } catch (err) {
        result = `Tool error: ${err.message}`;
      }
      convo.push({ role: 'tool', tool_call_id: call.id, content: String(result) });
    }
  }
  throw new Error(`${purpose}: tool loop did not finish.`);
}

// ---- public API -------------------------------------------------------------------

function requireLlm() {
  if (!llmAvailable()) {
    throw terminal(new Error('No model provider is configured. Set one in .env (see .env.example).'));
  }
}

/** One structured completion: returns the parsed object matching `schema`. */
export async function completeJSON(opts) {
  requireLlm();
  return config.llm.provider === 'anthropic' ? anthropicJSON(opts) : openaiJSON(opts);
}

/**
 * A tool loop. `tools` are { name, description, schema, run(args) -> string }.
 * `messages` are plain { role: 'user'|'assistant', content: string } turns.
 * Returns the final reply text.
 */
export async function runTools({ maxIterations = 12, ...opts }) {
  requireLlm();
  return config.llm.provider === 'anthropic'
    ? anthropicTools({ ...opts, maxIterations })
    : openaiTools({ ...opts, maxIterations });
}

export { estimateCost as _estimateCost, anthropicParams as _anthropicParams };
