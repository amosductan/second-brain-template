import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import express from 'express';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-regressions-'));
process.env.DATA_DIR = dir;
process.env.AUTH_TOKEN = 'test-only-token';
process.env.LLM_PROVIDER = 'openai';
process.env.OPENAI_API_KEY = '';
process.env.TRANSCRIBE_API_KEY = '';
const db = await import('../server/db.js');
const { api } = await import('../server/routes.js');
const app = express(); app.use(express.json()); app.use('/api', api); app.use(express.static(path.resolve('public')));
const server = app.listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
try {
  assert.equal((await fetch(base + '/api/notes')).status, 401);
  assert.equal((await fetch(base + '/api/session', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:'wrong'})})).status,401);
  const login = await fetch(base + '/api/session', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:'test-only-token'})});
  assert.equal(login.status,200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly/);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const headers = {Cookie:cookie};
  assert.equal((await fetch(base + '/api/notes', {headers})).status,200);
  const work = db.findCategoryByPath('Work');
  const ideas = db.findCategoryByPath('Ideas');
  for(let i=0;i<121;i++) {
    const n=db.insertNote({source:'text',transcript:i<120?'needle':'needle and additional words'});
    db.updateNote(n.id,{category_id:i<120?work.id:ideas.id});
  }
  const filtered=await (await fetch(base+`/api/notes/search?q=needle&category=${ideas.id}`,{headers})).json();
  assert.equal(filtered.length,1); assert.equal(filtered[0].category_id,ideas.id);
  for(const route of ['/api/notes?', '/api/notes/search?q=needle&']) {
    const first=await (await fetch(base+route+'limit=100&offset=0',{headers})).json();
    const next=await (await fetch(base+route+'limit=100&offset=100',{headers})).json();
    assert.equal(first.length,100); assert.equal(next.length,21);
    assert.equal(new Set([...first,...next].map(n=>n.id)).size,121);
  }
  // Keep a multipart request open while cleanup runs.
  const boundary='review-boundary';
  const response=new Promise((resolve,reject)=>{
    const req=http.request(base+'/api/ingest',{method:'POST',headers:{...headers,'Content-Type':`multipart/form-data; boundary=${boundary}`}},res=>{
      let body='';res.on('data',b=>body+=b);res.on('end',()=>resolve({status:res.statusCode,body}));
    });
    req.on('error',reject);
    req.write(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="recording.webm"\r\nContent-Type: audio/webm\r\n\r\nrecording bytes`);
    globalThis.pendingUpload=req;
  });
  let staged=[];
  for(let i=0;i<100;i++) {
    staged=await fs.readdir(path.join(dir,'uploads'));
    if(staged.length) break;
    await new Promise(r=>setTimeout(r,20));
  }
  assert.equal(staged.length,1);
  const pruneCode=await new Promise(resolve=>{
    const child=spawn(process.execPath,['scripts/prune_audio.mjs'],{env:process.env,stdio:'ignore'});
    child.on('close',resolve);
  });
  assert.equal(pruneCode,0);
  assert.equal((await fs.readdir(path.join(dir,'uploads'))).length,1);
  pendingUpload.end(`\r\n--${boundary}--\r\n`);
  const uploaded=await response;assert.equal(uploaded.status,201);
  const note=JSON.parse(uploaded.body);
  assert.equal(await fs.readFile(note.audio_path,'utf8'),'recording bytes');
  assert.equal((await fs.readdir(path.join(dir,'uploads'))).length,0);
  assert.equal((await fetch(base+`/api/notes/${note.id}/audio`,{headers})).status,200);
  // Exercise the real upload handler's auth-error branch without a browser.
  const source=await fs.readFile('public/app.js','utf8');
  let removed=false, queued=false;
  const context={FormData,postIngest:async()=>{const e=new Error('Unauthorized');e.status=401;throw e;},outboxRemove:async()=>{removed=true;},outboxAdd:async()=>{queued=true;return 1;},outboxLines:new Map(),outboxList:async()=>[],setOutboxBanner:()=>{},scheduleOutboxFlush:()=>{},mb:()=>'',ic:()=>'',esc:x=>x};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function isTransientUploadError('),source.indexOf('// ---------- offline outbox')),context);
  assert.equal(await context.uploadAudio(new Blob(['audio']),'a.webm','live',{}, {outboxId:1}),'offline');
  assert.equal(removed,false);
  assert.equal(await context.uploadAudio(new Blob(['audio']),'a.webm','live',{}),'offline');
  assert.equal(queued,true);
  // Render both pages with the frontend's actual pagination function.
  const elements = {
    '#notes-more': { addEventListener() {}, disabled: false, hidden: true },
    '#search-input': { value: '' }, '#category-filter': { value: '' },
    '#notes-list': { innerHTML: '', insertAdjacentHTML(_position, html) { this.innerHTML += html; } },
  };
  const paging = {
    $: key => elements[key], $$: () => [], URLSearchParams,
    loadCategories() {}, noteCard: n => `<article>${n.id}</article>`,
    apiFetch: url => fetch(base + url, {headers}),
  };
  vm.createContext(paging);
  vm.runInContext(source.slice(source.indexOf('let notesOffset ='), source.indexOf('function statusTag')), paging);
  await paging.refreshNotes();
  assert.equal((elements['#notes-list'].innerHTML.match(/<article>/g)||[]).length,100);
  assert.equal(elements['#notes-more'].hidden,false);
  await paging.refreshNotes(true);
  assert.equal((elements['#notes-list'].innerHTML.match(/<article>/g)||[]).length,122);
  assert.equal(elements['#notes-more'].hidden,true);
  elements['#search-input'].value='needle';
  elements['#category-filter'].value=ideas.id;
  await paging.refreshNotes({type:'change'});
  assert.equal((elements['#notes-list'].innerHTML.match(/<article>/g)||[]).length,1);
  if (process.argv.includes('--browser')) {
    const require = createRequire(import.meta.url);
    const candidates = [path.resolve('node_modules/playwright')];
    for (const root of [path.join(os.homedir(),'AppData/Local/npm-cache/_npx'), path.join(os.homedir(),'.npm/_npx')]) {
      for (const entry of await fs.readdir(root).catch(() => [])) candidates.push(path.join(root,entry,'node_modules/playwright'));
    }
    let playwright;
    for (const candidate of candidates) {
      try { playwright = require(path.join(candidate,'index.js')); break; } catch {}
    }
    assert.ok(playwright, 'Install playwright to run browser checks');
    const browser = await playwright.chromium.launch({headless:true});
    try {
      const page = await browser.newPage();
      const errors=[];page.on('pageerror',err=>errors.push(err.message));
      await page.goto(base);
      await page.waitForSelector('#auth-form', {state:'visible'});
      await page.fill('#auth-token','test-only-token');
      await page.click('#auth-form button');
      await page.waitForSelector('#auth-form', {state:'hidden'});
      await page.click('[data-tab="notes"]');
      await page.waitForFunction(()=>document.querySelectorAll('#notes-list .note-card').length===100);
      await page.click('#notes-more');
      await page.waitForFunction(()=>document.querySelectorAll('#notes-list .note-card').length===122);
      await page.selectOption('#category-filter',ideas.id);
      await page.fill('#search-input','needle');
      await page.waitForFunction(()=>document.querySelectorAll('#notes-list .note-card').length===1);
      assert.deepEqual(errors,[]);
      console.log('PASS: browser token sign-in, Load more, and category search');
    } finally { await browser.close(); }
  }
  console.log('PASS: cookie auth and playback, auth upload retention, category search, pagination, cleanup during upload');
} finally {
  if(globalThis.pendingUpload) globalThis.pendingUpload.destroy();
  await new Promise(r=>server.close(r));
  db.closeDb();
  await fs.rm(dir,{recursive:true,force:true});
}
