import express from 'express';
import { config } from './config.js';
import { closeDb } from './db.js';
import { api } from './routes.js';
import { resumePending } from './jobs.js';
import { transcriptionAvailable } from './transcribe.js';
import { llmDescription } from './llm.js';

const app = express();

app.use(express.json({ limit: '10mb' }));
app.use('/api', api);
app.use(express.static(config.publicDir));

const host = process.env.HOST || '127.0.0.1';
const server = app.listen(config.port, host, () => {
  console.log(`Second Brain running at http://${host === '0.0.0.0' ? 'localhost' : host}:${config.port}`);
  console.log(`  data dir:       ${config.dataDir}`);
  console.log(`  transcription:  ${transcriptionAvailable() ? 'on (' + config.transcribe.model + ')' : 'OFF (set OPENAI_API_KEY or TRANSCRIBE_API_KEY)'}`);
  console.log(`  model:          ${llmDescription() === 'off' ? 'OFF (set a provider in .env)' : llmDescription()}`);
  console.log(`  auth:           ${config.authToken ? 'bearer token required' : 'open (set AUTH_TOKEN before exposing it beyond this machine)'}`);
  resumePending();
});

// Graceful shutdown: checkpoint + close the DB so the .db file is self-contained
// on stop. Handles Ctrl+C (SIGINT), SIGTERM (docker stop, systemd) and SIGBREAK
// (Windows).
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[shutdown] ${signal}: checkpointing database…`);
  server.close(() => {
    closeDb();
    console.log('[shutdown] clean.');
    process.exit(0);
  });
  // Don't hang forever if a socket won't drain.
  setTimeout(() => { closeDb(); process.exit(0); }, 4000).unref();
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => shutdown(sig));
process.on('beforeExit', () => closeDb());
