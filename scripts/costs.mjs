#!/usr/bin/env node
/**
 * What the model calls have cost, from the usage ledger every call writes.
 *
 *   npm run costs                 # last 30 days
 *   npm run costs -- --days 7
 *   npm run costs -- --json
 *
 * Token counts are what each provider reported. Dollar figures are estimates at
 * list price, and only for models with a known price: the "unpriced" column
 * says how many calls a total does NOT cover.
 */
import { usageSummary } from '../server/db.js';

const args = process.argv.slice(2);
const daysIdx = args.indexOf('--days');
const days = daysIdx >= 0 ? Number(args[daysIdx + 1]) || 30 : 30;
const s = usageSummary({ days });

if (args.includes('--json')) {
  console.log(JSON.stringify(s, null, 2));
  process.exit(0);
}

const usd = (v) => (v == null ? '-' : `$${v.toFixed(v < 1 ? 4 : 2)}`);
const num = (v) => (v || 0).toLocaleString('en-US');
const mins = (sec) => (sec ? `${(sec / 60).toFixed(1)} min` : '');

function table(rows, keyCols) {
  const cols = [...keyCols, 'calls', 'tokens', 'audio', 'cost', 'unpriced'];
  const body = rows.map((r) => [
    ...keyCols.map((k) => String(r[k] ?? '')),
    num(r.calls),
    num((r.input_tokens || 0) + (r.output_tokens || 0) + (r.cache_read_tokens || 0) + (r.cache_write_tokens || 0)),
    mins(r.audio_seconds),
    usd(r.cost_usd),
    r.unpriced_calls ? String(r.unpriced_calls) : '',
  ]);
  const widths = cols.map((c, i) => Math.max(c.length, ...body.map((b) => b[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(line(cols));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const b of body) console.log(line(b));
}

console.log(`Last ${days} day(s): ${s.notes} note(s), ${num(s.total.calls)} model call(s)\n`);
if (!s.total.calls) {
  console.log('No model calls recorded yet.');
  process.exit(0);
}
table(s.by_purpose, ['purpose']);
console.log('');
table(s.by_model, ['provider', 'model']);
if (s.total.cost_usd == null) {
  console.log('\nTotal: not priced. Set LLM_PRICE_IN / LLM_PRICE_OUT in .env to estimate these models.');
} else {
  console.log(`\nTotal: ${usd(s.total.cost_usd)}` +
    (s.notes ? `, ${usd(s.total.cost_usd / s.notes)} per note` : '') +
    (s.total.unpriced_calls ? ` (${s.total.unpriced_calls} call(s) unpriced, not included)` : ''));
}
