#!/usr/bin/env node
/**
 * Runs every offline test. None of them calls a paid API: model and
 * transcription calls go to local stub servers.
 *
 *   npm test                 # everything that can run on this machine
 *   npm test -- --browser    # also the real-browser recording test (needs playwright)
 *
 * Three outcomes per test, never two: pass, FAIL, or skipped with the reason
 * (ffmpeg missing, playwright not installed). A skipped test is not a pass.
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

const here = import.meta.dirname;
const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const browser = process.argv.includes('--browser');

const TESTS = [
  { file: 'test_retry.mjs' },
  { file: 'test_review_regressions.mjs', args: browser ? ['--browser'] : [] },
  { file: 'test_second_pass_regressions.mjs' },
  { file: 'test_launch_regressions.mjs' },
  { file: 'test_task_items.mjs' },
  { file: 'test_llm_providers.mjs' },
  { file: 'test_transcribe_retry.mjs' },
  { file: 'test_transcribe_chunking.mjs', needs: hasFfmpeg ? null : 'ffmpeg is not installed',
    slow: 'builds and splits a two-hour recording with ffmpeg, about 3 to 5 minutes' },
  { file: 'test_event_loop_free.mjs', needs: hasFfmpeg ? null : 'ffmpeg is not installed',
    slow: 'splits a 40-minute recording with ffmpeg, about 1 to 2 minutes' },
  { file: 'test_recording_recovery.mjs', needs: browser ? null : 'browser test: run with --browser' },
];

function run(file, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, file), ...args], {
      cwd: path.join(here, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { out += b; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

const results = [];
for (const t of TESTS) {
  if (t.needs) {
    results.push({ file: t.file, state: 'skipped', why: t.needs });
    console.log(`skip  ${t.file} (${t.needs})`);
    continue;
  }
  if (t.slow) console.log(`run   ${t.file} (${t.slow})`);
  const t0 = Date.now();
  const { code, out } = await run(t.file, t.args);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (code === 0) {
    results.push({ file: t.file, state: 'pass' });
    console.log(`pass  ${t.file} (${secs}s)`);
  } else {
    results.push({ file: t.file, state: 'FAIL' });
    console.log(`FAIL  ${t.file} (${secs}s)\n${out.split('\n').map((l) => `      ${l}`).join('\n')}`);
  }
}

const count = (s) => results.filter((r) => r.state === s).length;
console.log(`\n${count('pass')} passed, ${count('FAIL')} failed, ${count('skipped')} skipped`);
process.exit(count('FAIL') ? 1 : 0);
