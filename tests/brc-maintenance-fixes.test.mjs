import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TraefikInput } from '../packages/cli/dist/adapters/traefik/input.js';
import { PlatformEnvironment } from '../packages/cli/dist/config/platform-environment.js';
import { cleanRuntime as runCleanup } from '../packages/cli/dist/adapters/storage/cleanup.js';
import { LifecycleLock as LifecycleLockImpl } from '../packages/cli/dist/adapters/storage/lock.js';
import { LockStore } from '../packages/cli/dist/adapters/storage/lock-store.js';
import { FileSnapshotStore } from '../packages/shared/dist/diagnostics/adapters/snapshots.js';
import { ProcessManager } from '../packages/cli/dist/adapters/process/controller.js';

function LifecycleLock(paths, options) {
  return new LifecycleLockImpl(paths, new LockStore(paths), options);
}

function cleanRuntime(paths, options = {}) {
  return runCleanup(paths, options, {
    lockStore: new LockStore(paths),
    lifecycleLock: new LifecycleLock(paths, {
      waitMs: options.settings?.runtime.lockWaitMs,
      pollMs: options.settings?.runtime.lockPollMs,
    }),
    snapshotStore: new FileSnapshotStore({ directory: paths.diagnostics ?? path.join(paths.root, 'diagnostics') }),
    createProcessManager: (options) => new ProcessManager(paths, options),
  });
}

const api = 'https://api.github.com/repos/traefik/traefik/releases/latest';
const target = new PlatformEnvironment().resolveTraefikTarget();
const archiveName = (v) => `traefik_v${v}_${target.platform}_${target.arch}.${target.archiveExt}`;
const release = (v) => ({ tag_name: 'v' + v, draft: false, prerelease: false, assets: [
 {name:archiveName(v),browser_download_url:'https://github.com/traefik/traefik/releases/download/v'+v+'/'+archiveName(v)},
 {name:'traefik_v'+v+'_checksums.txt',browser_download_url:'https://github.com/traefik/traefik/releases/download/v'+v+'/traefik_v'+v+'_checksums.txt'}
]});
test('release discovery retries a transient GitHub 403 and retains validation', async () => {
  let attempts = 0;
  const input = new TraefikInput({ releaseApiUrl: api, fetch: async () => {
    attempts++;
    return attempts === 1 ? new Response('temporary forbidden', {status:403}) : Response.json(release('3.7.17'));
  }});
  assert.equal((await input.latestRelease()).version, '3.7.17');
  assert.equal(attempts, 2);
});

test('release discovery reports a confirmed rate limit without unnecessary retry', async () => {
  let attempts = 0;
  const input = new TraefikInput({ fetch: async () => {
    attempts++;
    return new Response('API rate limit exceeded', {status:403,headers:{'x-ratelimit-remaining':'0','x-ratelimit-reset':'2000000000'}});
  }});
  await assert.rejects(input.latestRelease(), /rate limit/i);
  assert.equal(attempts, 1);
});
test('clean does not warn for the empty Traefik versions directory during setup', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(),'brc-clean-setup-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,'traefik','versions'), {recursive:true});
  const paths = Object.fromEntries(['traefik','config','data','runtime','logs','tmp'].map(n=>[n,path.join(root,n)]));
  const report = await cleanRuntime({root,...paths});
  assert.equal(report.preserved.length,0,JSON.stringify(report.preserved));
});

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { createDefaultServices } from '../packages/cli/dist/adapters/process/specs.js';
import { DEFAULT_SETTINGS } from '../packages/cli/dist/config/settings.js';

test('managed services inherit one release version from CLI package metadata', async () => {
 const base = path.join(os.tmpdir(),'brc-version-check');
 const paths = {root:base,config:path.join(base,'config'),data:path.join(base,'data'),
   runtime:path.join(base,'runtime'),logs:path.join(base,'logs'),traefik:path.join(base,'traefik'),tmp:path.join(base,'tmp')};
 const services = createDefaultServices(paths, DEFAULT_SETTINGS, {BRC_PRODUCT_VERSION:'stale'});
 const versions = services.map(s=>s.env.BRC_PRODUCT_VERSION);
 const expected = JSON.parse(await readFile(new URL('../packages/cli/package.json', import.meta.url),'utf8')).version;
 assert.deepEqual(versions,Array(3).fill(expected));
});
test('real Agent exposes a manageable pairing state before user approval', async (t) => {
 const root = await mkdtemp(path.join(os.tmpdir(),'brc-agent-pair-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const server = createServer((req,res)=>{
   res.setHeader('content-type','application/json');
   if(req.url==='/device/start')return res.end(JSON.stringify({
     device_code:'fake',user_code:'TEST-CODE',verification_uri:'http://127.0.0.1/device/verify',
     verification_uri_complete:'http://127.0.0.1/device/verify?user_code=TEST-CODE',expires_in:900,interval:5}));
   if(req.url==='/device/poll') return res.writeHead(400).end(JSON.stringify({error:'authorization_pending'}));
   res.writeHead(404).end('{}');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const agentEntry = new URL('../packages/agent/dist/cli.js',import.meta.url);
 const file = path.join(root,'agent.ready.json');
 const child = spawn(process.execPath,[fileURLToPath(agentEntry),'connect','--relay','http://127.0.0.1:'+server.address().port,'--no-browser'],
 {windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...Object.fromEntries(Object.entries(process.env).filter(([name])=>!name.startsWith('BRC_'))),BRC_DATA_ROOT:path.join(root,'home'),BRC_UPSTREAM_TELEMETRY:'0',
 BRC_CONTROL_TOKEN:'a'.repeat(64),BRC_CONTROL_READY_FILE:file,BRC_MANAGED_ID:'00000000-0000-4000-8000-000000000001',
 BRC_MANAGED_SERVICE:'agent'}});
 let childOutput = '';
 child.stdout.on('data', (chunk) => { childOutput += chunk.toString(); });
 child.stderr.on('data', (chunk) => { childOutput += chunk.toString(); });
 t.after(()=>{try{child.kill()}catch{}});
 let ready;
 for(let i=0;i<120;i++){
   try{ready=JSON.parse(await readFile(file,'utf8'));break}catch{await sleep(100)}
 }
 assert.ok(ready,'Agent should publish the managed control endpoint before human pairing. Output: ' + childOutput);
 let response;
 for (let i = 0; i < 100; i++) {
   response = await fetch('http://127.0.0.1:'+ready.port+'/health',{
     headers:{authorization:'Bearer '+'a'.repeat(64)}});
   if (response.status === 202) break;
   await sleep(100);
 }
 const health = await response.json();
 assert.equal(response.status,202,JSON.stringify(health) + '\n' + childOutput);
 assert.equal(health.state,'pairing');
});

test('release discovery recovers from a network interruption, 429, and 503', async () => {
 for(const failure of ['network',429,503]){
   let attempts=0;
   const input=new TraefikInput({fetch:async()=>{
     attempts++;
     if(attempts===1){
       if(failure==='network')throw new Error('socket closed');
       return new Response('temporarily unavailable',{status:failure});
     }
     return Response.json(release('3.7.17'));
   }});
   assert.equal((await input.latestRelease()).version,'3.7.17');
   assert.equal(attempts,2);
 }
});

test('release discovery respects a long retry-after window', async () => {
 let attempts=0;
 const input=new TraefikInput({fetch:async()=>{
   attempts++;
   return new Response('rate limited',{status:429,headers:{'retry-after':'60'}});
 }});
 await assert.rejects(input.latestRelease(),/retry after 60 seconds/i);
 assert.equal(attempts,1);
});
