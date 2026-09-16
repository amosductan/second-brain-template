# Second Brain: instructions for AI coding assistants

This file is read by AI coding assistants (Codex, Cursor, GitHub Copilot, Gemini CLI, Claude Code
and others) when someone opens this folder. Most people open it to say
**"set up my second brain."** Follow the setup script below. Do the work yourself; ask the person
only for what only they know or can do (which provider they want, an API key, whether it should be
reachable from their phone).

## Setup script ("set up my second brain")

1. **Check the machine.** `node --version` must be 22.13 or newer (the app uses Node's built-in
   SQLite). Run `npm install`, then `npm test`: it must end with `0 failed`. With ffmpeg
   installed the suite takes a few minutes; the runner says which test it's on. Skipped tests are fine
   and say why (ffmpeg missing, browser test not requested). If ffmpeg isn't installed, install it
   (`brew install ffmpeg`, `sudo apt install ffmpeg`, `winget install Gyan.FFmpeg`): without it,
   recordings over about 25 minutes can't be transcribed.
2. **Pick the providers.** Ask, in one message:
   - which model provider should file notes and answer questions: Anthropic, OpenAI, Gemini, or a
     local model through Ollama;
   - which key goes with it, and whether they have an OpenAI key for transcription (or another
     Whisper-compatible service).
   Copy `.env.example` to `.env` and fill in only what they gave you. Set `LLM_PROVIDER`
   explicitly. Never print a key back.
3. **Prove it answers.** `npm run check`. It makes one short call and prints what it cost. To check
   transcription too, record any short clip and run `npm run check -- --audio <file>`.
4. **Show them the app.** Optionally `npm run demo` for a few weeks of example notes. Start it with
   `npm start` and open http://127.0.0.1:3000. Remind them to remove the demo notes before real use
   (`npm run demo -- --clear`); it removes only notes tagged `demo`.
5. **Their own filing rules (optional).** Ask whether there's anything the app should always do
   when filing ("anything about the garden goes under Projects / Garden", "tag every note that
   mentions a client with client:<name>"). Write each as one line in `data/conventions.md`. The
   next note uses them; no restart needed.
6. **Phone access (optional).** The server listens on 127.0.0.1. The simplest private route is
   [Tailscale](https://tailscale.com): install it on the computer and the phone, set `HOST=0.0.0.0`
   in `.env`, and run `tailscale serve --bg --https=443 http://localhost:3000`. On the phone, open
   the `https://<machine>.<tailnet>.ts.net` address in Safari and choose Share > Add to Home Screen.
   Anyone on their tailnet can reach it, so only add people they'd trust with their notes. If they
   want it on the public internet instead, set `AUTH_TOKEN` first and put it behind HTTPS.
7. **Keep it running.** On a machine that stays on: Docker (`docker compose up -d`), or a service
   manager (systemd, launchd, pm2, or a Windows Task Scheduler task whose working directory is this
   folder, set to run on battery too). Schedule `npm run backup` nightly,
   `node scripts/verify_backups.mjs` after it, and `node scripts/prune_audio.mjs` weekly.
8. **Show them it works.** Record one real note on the phone, watch it go from captured to ready,
   then ask the chat tab about it. `npm run costs` shows what that cost.

## Rules for working in this repo

- **Nothing synchronous in a request or job path.** Use `node:fs/promises` and `spawn`, never
  `*Sync()` or `spawnSync`. `server/config.js` (startup only) and `node:sqlite` are the exceptions.
  `scripts/test_event_loop_free.mjs` guards this.
- **Model calls go through `server/llm.js` only**: `completeJSON()` for structured output,
  `runTools()` for a tool loop. It picks the provider, retries what's worth retrying, and writes
  every call to the usage ledger. A call that skips it is a cost nobody can see.
- **`data/` and `.env` never get committed**, and never go into a Docker image (`.dockerignore` is
  an allowlist).
- Run `npm test` after any change. Add a test when you fix a failure; `docs/RELIABILITY.md` lists
  the failures the existing ones guard.
- Front-end changes need no restart and no cache-busting: open pages reload themselves when the
  asset fingerprint changes. Server changes need a restart.
- An element hidden with the `hidden` attribute needs an explicit `.thing[hidden] { display: none; }`
  if a class rule sets `display`, or the class wins.
