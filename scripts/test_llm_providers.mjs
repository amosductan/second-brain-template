#!/usr/bin/env node
/**
 * Drives the categorizer, chat and transcription through each provider adapter
 * against a local stub server, and checks the requests they send and the usage
 * rows they write. No API keys, no network, no cost.
 *
 *   node scripts/test_llm_providers.mjs
 *
 * config.js picks the provider once at import, so each provider runs in its
 * own child process (this file re-runs itself with --child <provider>).
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';

const childIdx = process.argv.indexOf('--child');
if (childIdx < 0) {
  let failed = 0;
  for (const mode of ['anthropic', 'openai', 'openai-priced', 'transcribe']) {
    const r = spawnSync(process.execPath, [import.meta.filename, '--child', mode], { encoding: 'utf8' });
    process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
    if (r.status !== 0) failed++;
  }
  console.log(failed ? `\n${failed} provider suite(s) FAILED` : '\nALL PASS');
  process.exit(failed ? 1 : 0);
}

const mode = process.argv[childIdx + 1];
const requests = [];
let passed = 0;
const check = (label, fn) => {
  try { fn(); passed++; console.log(`  ok   ${label}`); } catch (err) {
    console.log(`  FAIL ${label}\n       ${err.message}`);
    process.exitCode = 1;
  }
};

const CATEGORY_JSON = JSON.stringify({
  title: 'Fence repair before winter',
  summary: 'Fix the leaning fence panel before the first freeze.',
  category_path: 'Personal / Home',
  new_category: null,
  tags: ['home', 'fence'],
  action_items: ['Buy two fence brackets', 'Fix the fence panel by Saturday'],
  memory_note: 'The author files house repairs under Personal / Home.',
});

// ---- stub server: speaks just enough of both protocols -----------------------
const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const isJson = (req.headers['content-type'] || '').includes('json');
  const body = isJson && raw ? JSON.parse(raw) : null;
  requests.push({ url: req.url, headers: req.headers, body });
  const send = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

  if (req.url.endsWith('/audio/transcriptions')) {
    return send({ text: 'stub transcript', duration: 90 });
  }

  if (req.url.startsWith('/v1/messages')) {
    const usage = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const msg = (content, stop_reason = 'end_turn') => send({
      id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: body.model,
      content, stop_reason, stop_sequence: null, usage,
    });
    if (body.output_config?.format) return msg([{ type: 'text', text: CATEGORY_JSON }]);
    const sawToolResult = body.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'));
    if (!sawToolResult) {
      return msg([{ type: 'tool_use', id: 'toolu_1', name: 'search_notes', input: { query: 'fence' } }], 'tool_use');
    }
    return msg([{ type: 'text', text: 'You mentioned the fence on one note: buy two brackets.' }]);
  }

  if (req.url.endsWith('/chat/completions')) {
    const usage = { prompt_tokens: 1200, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 200 } };
    const reply = (message, finish_reason = 'stop') => send({
      id: 'cmpl', object: 'chat.completion', model: body.model, usage,
      choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason }],
    });
    if (body.response_format) return reply({ content: CATEGORY_JSON });
    const sawTool = body.messages.some((m) => m.role === 'tool');
    if (!sawTool) {
      return reply({ content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search_notes', arguments: '{"query":"fence"}' } }] }, 'tool_calls');
    }
    return reply({ content: 'You mentioned the fence on one note: buy two brackets.' });
  }

  res.writeHead(404); res.end('no route');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// ---- environment for this child --------------------------------------------------
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-llm-'));
Object.assign(process.env, {
  DATA_DIR: dataDir,
  ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '', TRANSCRIBE_API_KEY: '',
  LLM_PRICE_IN: '', LLM_PRICE_OUT: '', CATEGORIZER_MODEL: '', CHAT_MODEL: '',
});
if (mode === 'anthropic') {
  Object.assign(process.env, { LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: base });
} else if (mode === 'openai' || mode === 'openai-priced') {
  Object.assign(process.env, { LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'test-key', LLM_BASE_URL: `${base}/v1` });
  if (mode === 'openai-priced') Object.assign(process.env, { LLM_PRICE_IN: '1', LLM_PRICE_OUT: '4' });
} else if (mode === 'transcribe') {
  // A non-OpenAI endpoint is unpriced unless you say what it costs; this suite
  // says so, and checks the unpriced case separately below.
  Object.assign(process.env, { LLM_PROVIDER: '', TRANSCRIBE_API_KEY: 'test-key', TRANSCRIBE_BASE_URL: `${base}/v1`, TRANSCRIBE_PRICE_PER_MIN: '0.006' });
}

const { insertNote, getNote, usageSummary, listTasks, closeDb } = await import('../server/db.js');
console.log(`\n[${mode}]`);

if (mode === 'transcribe') {
  const { transcribeAudio } = await import('../server/transcribe.js');
  const config_test = await import('../server/config.js');
  const clip = path.join(dataDir, 'clip.m4a');
  fs.writeFileSync(clip, Buffer.alloc(2048));
  const text = await transcribeAudio(clip, 'audio/mp4', 'note-1');
  const req = requests[0];
  const u = usageSummary({ days: 1 });
  check('returns the transcript text from verbose_json', () => assert.equal(text, 'stub transcript'));
  check('asks for verbose_json (it carries the duration)', () => assert.ok(req && req.headers['content-type'].includes('multipart')));
  check('logs 90 audio seconds', () => assert.equal(u.total.audio_seconds, 90));
  check('prices 1.5 minutes at $0.006/min', () => assert.equal(u.total.cost_usd.toFixed(4), '0.0090'));
  check("a non-OpenAI endpoint with no price set is logged unpriced, never at OpenAI's rate", () => {
    const { transcribePrice } = config_test;
    assert.equal(transcribePrice({ TRANSCRIBE_BASE_URL: 'http://localhost:8000/v1' }), null);
    assert.equal(transcribePrice({}), 0.006);
    assert.equal(transcribePrice({ TRANSCRIBE_BASE_URL: 'http://localhost:8000/v1', TRANSCRIBE_PRICE_PER_MIN: '0.002' }), 0.002);
  });
} else {
  const { categorizeNote } = await import('../server/agents/categorizer.js');
  const { chat } = await import('../server/agents/chat.js');

  const note = insertNote({ source: 'text', transcript: 'The fence panel by the garage is leaning, I need two brackets.' });
  await categorizeNote(note);
  const filed = getNote(note.id);
  const catReq = requests.find((r) => r.body?.output_config?.format || r.body?.response_format);

  check('note is filed under the returned category', () => assert.equal(filed.category_path, 'Personal / Home'));
  check('tags and action items are saved', () => {
    assert.deepEqual(filed.tags, ['home', 'fence']);
    assert.equal(listTasks({ states: ['open'] }).length, 2);
  });

  if (mode === 'anthropic') {
    check('categorizer runs Opus 5 by default', () => assert.equal(catReq.body.model, 'claude-opus-5'));
    check('adaptive thinking + medium effort + json_schema format', () => {
      assert.deepEqual(catReq.body.thinking, { type: 'adaptive' });
      assert.equal(catReq.body.output_config.effort, 'medium');
      assert.equal(catReq.body.output_config.format.type, 'json_schema');
    });
    check('server-side fallbacks on (body + beta header)', () => {
      assert.equal(catReq.body.fallbacks, 'default');
      assert.ok(String(catReq.headers['anthropic-beta']).includes('server-side-fallback-2026-07-01'));
    });
    check('no stray betas field in the body', () => assert.equal(catReq.body.betas, undefined));
  } else {
    check('strict json_schema response_format', () => {
      assert.equal(catReq.body.response_format.type, 'json_schema');
      assert.equal(catReq.body.response_format.json_schema.strict, true);
    });
  }

  const before = requests.length;
  const reply = await chat([{ role: 'user', content: 'What did I say about the fence?' }]);
  const chatReqs = requests.slice(before);
  check('chat returns the final answer', () => assert.match(reply, /two brackets/));
  check('chat ran the search tool and sent its result back', () => {
    assert.equal(chatReqs.length, 2);
    const second = chatReqs[1].body.messages;
    const sent = mode === 'anthropic'
      ? second.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result' && String(JSON.stringify(b.content)).includes('Fence repair')))
      : second.some((m) => m.role === 'tool' && m.content.includes('Fence repair'));
    assert.ok(sent, 'tool result carrying the filed note was not sent back');
  });
  if (mode === 'anthropic') {
    check('chat carries cache_control and fallbacks', () => {
      assert.deepEqual(chatReqs[0].body.cache_control, { type: 'ephemeral' });
      assert.equal(chatReqs[0].body.fallbacks, 'default');
    });
  }

  const u = usageSummary({ days: 1 });
  check('one usage row per billed call (1 categorize + 2 chat)', () => {
    assert.equal(u.total.calls, 3);
    assert.deepEqual(u.by_purpose.map((p) => [p.purpose, p.calls]).sort(), [['categorize', 1], ['chat', 2]]);
  });
  if (mode === 'anthropic') {
    check('priced at Opus 5 list: 3 x (1000 in @ $5 + 200 out @ $25) = $0.030', () => {
      assert.equal(u.total.cost_usd.toFixed(4), '0.0300');
      assert.equal(u.total.unpriced_calls, 0);
    });
  } else if (mode === 'openai') {
    check('no built-in price: tokens logged, cost left null and counted as unpriced', () => {
      assert.equal(u.total.cost_usd, null);
      assert.equal(u.total.unpriced_calls, 3);
      assert.equal(u.total.input_tokens, 3000);   // 1200 prompt - 200 cached, x3
      assert.equal(u.total.cache_read_tokens, 600);
    });
  } else {
    check('LLM_PRICE_IN/OUT prices it: 3 x (1000 @ $1 + 200 cached @ $0.10 + 300 @ $4) = $0.00666', () => {
      assert.equal(u.total.cost_usd.toFixed(5), '0.00666');
    });
  }
}

server.close();
closeDb(); // Windows won't delete a folder holding an open database
fs.rmSync(dataDir, { recursive: true, force: true });
console.log(`  ${passed} check(s) passed`);
