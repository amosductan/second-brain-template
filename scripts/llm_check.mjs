#!/usr/bin/env node
/**
 * One short call to prove the configured model provider answers, and what it
 * cost. Run it after editing .env, before trusting a recording to the pipeline.
 *
 *   npm run check                      # the model provider
 *   npm run check -- --audio memo.m4a  # also transcribe a file
 *
 * Exit 0 = everything asked for answered; 1 = something didn't.
 */
import fs from 'node:fs';
import { config } from '../server/config.js';
import { completeJSON, llmAvailable, llmDescription } from '../server/llm.js';
import { transcribeAudio, transcriptionAvailable } from '../server/transcribe.js';
import { usageSummary } from '../server/db.js';

const args = process.argv.slice(2);
const audioIdx = args.indexOf('--audio');
const audioFile = audioIdx >= 0 ? args[audioIdx + 1] : null;
let failed = false;

const before = usageSummary({ days: 1 }).total;

console.log(`model provider: ${llmDescription()}`);
if (!llmAvailable()) {
  console.log('  not configured: set a provider and key in .env (see .env.example)');
  failed = true;
} else {
  try {
    const t0 = Date.now();
    const out = await completeJSON({
      purpose: 'check',
      model: config.llm.categorizerModel,
      effort: 'low',
      system: 'You are a connectivity check. Answer in one short sentence.',
      user: 'Say that the second brain is connected.',
      schema: {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
        additionalProperties: false,
      },
    });
    console.log(`  ok in ${((Date.now() - t0) / 1000).toFixed(1)}s: "${out.answer}"`);
  } catch (err) {
    console.log(`  FAILED: ${err.message}`);
    failed = true;
  }
}

if (audioFile) {
  console.log(`\ntranscription: ${transcriptionAvailable() ? config.transcribe.model : 'off'}`);
  if (!fs.existsSync(audioFile)) {
    console.log(`  no such file: ${audioFile}`);
    failed = true;
  } else if (!transcriptionAvailable()) {
    console.log('  not configured: set OPENAI_API_KEY or TRANSCRIBE_API_KEY in .env');
    failed = true;
  } else {
    try {
      const text = await transcribeAudio(audioFile, null);
      console.log(`  ok: "${text.slice(0, 160)}${text.length > 160 ? '…' : ''}"`);
    } catch (err) {
      console.log(`  FAILED: ${err.message}`);
      failed = true;
    }
  }
}

const after = usageSummary({ days: 1 }).total;
const spent = (after.cost_usd || 0) - (before.cost_usd || 0);
const calls = after.calls - before.calls;
const tokens = (after.input_tokens + after.output_tokens) - (before.input_tokens + before.output_tokens);
if (calls > 0) {
  const unpriced = after.unpriced_calls - before.unpriced_calls;
  console.log(`\nthis check: ${calls} call(s), ${tokens} tokens, ` +
    (unpriced === calls ? 'cost not priced (set LLM_PRICE_IN / LLM_PRICE_OUT to estimate it)' : `~$${spent.toFixed(4)} at list price`));
}
process.exit(failed ? 1 : 0);
