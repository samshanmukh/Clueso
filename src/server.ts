import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './settings.ts';
import { bus, emit, type LpEvent } from './events.ts';
import { serveFixture } from './fixtures/server.ts';
import { runAudit } from './agents/controller.ts';
import {reviewAwareSummary} from './agents/investigator.ts';
import {enrichReviewReport} from './reviews/details.ts';
import { learnCycle } from './learn/learner.ts';
import { learnOnRealSites,loadFrozenVendorCandidate } from './learn/real-sites.ts';
import {validatePublicUrl} from './tools/network.ts';
import { learnRealChecker } from './learn/real-checker.ts';
import { loadCheckerEvidence } from './learn/checker-evidence.ts';
import { runTransfer } from './eval/transfer.ts';
import { evaluateFreshTransfer } from './eval/fresh-transfer.ts';
import { loadBrain, loadRegistry, resetBrain } from './brain/store.ts';
import { loadLabels } from './eval/score.ts';
import { llmAvailable } from './llm.ts';
import { searchAvailable } from './learn/research.ts';
import { registerFixtureOrigin, closeBrowser } from './scan/scanner.ts';
import { buildUI } from '../scripts/build-ui.ts';

await buildUI();

const recent: LpEvent[] = [];
bus.on('event', (e: LpEvent) => { recent.push(e); if (recent.length > 400) recent.shift(); });

let busy: string | null = null;
let jobTarget: string|null = null;
let liveAudit: { job: string; url: string; preview?: unknown; role?: string; workedRoles?: string[]; progress?: Record<string,unknown> } | null = null;
bus.on('event', (event: LpEvent) => {
  if (busy !== 'audit') return;
  const data = event.data as { job?: string; url?: string; preview?: unknown; workProgress?: import('./ui/site-progress.ts').WorkProgress & {url:string} } | undefined;
  if (event.role === 'controller' && event.kind === 'info' && data?.job && data.job === event.job && data.url) liveAudit = { job: data.job, url: data.url };
  if (event.role === 'scanner' && liveAudit && event.job === liveAudit.job && data?.preview) liveAudit.preview = data.preview;
  if(liveAudit&&event.job===liveAudit.job&&data?.workProgress?.url===liveAudit.url){const {url,...work}=data.workProgress;liveAudit.progress={...liveAudit.progress,[event.role]:work};}
  if(liveAudit && event.job===liveAudit.job && ['scanner','vision','investigator','verifier','fixer'].includes(event.role)){liveAudit.role=event.role;liveAudit.workedRoles=[...new Set([...(liveAudit.workedRoles??[]),event.role])];}
});

const base = () => `http://localhost:${config.port}/fixtures`;

function json(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
}
async function body(req: http.IncomingMessage): Promise<any> {
  let s = '';
  for await (const c of req) {
    s += c;
    if (Buffer.byteLength(s) > 16_384) throw Object.assign(new Error('Request body too large'), { status: 413 });
  }
  try {
    const parsed = s ? JSON.parse(s) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw Object.assign(new Error('Expected a JSON object'), { status: 400 }); }
}
function startJob(res: http.ServerResponse, name: string, fn: () => Promise<unknown>, details: { job?: string; url: string } | undefined = undefined) {
  if (busy) return json(res, 409, { error: `Busy: ${busy}` });
  busy = name; jobTarget=details?.url??null;
  json(res, 202, { started: name, ...details });
  fn().catch((e) => emit('controller', 'error', `${name} failed: ${e?.message ?? e}`)).finally(() => { busy = null; liveAudit = null; jobTarget=null; bus.emit('event', { t: Date.now(), role: 'controller', kind: 'done', msg: `__idle__` }); });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  try {
    if (req.method !== 'GET' && req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`) return json(res, 403, { error: 'Cross-origin requests are not allowed' });
      if (req.headers['content-type'] && !req.headers['content-type'].startsWith('application/json')) return json(res, 415, { error: 'Use application/json' });
    }
    if (serveFixture(req, res)) return;
    if (u.pathname === '/' || u.pathname === '/index.html') {
      if(u.searchParams.has('audit')||u.searchParams.has('view')){res.writeHead(302,{location:'/app'+u.search});return void res.end();}
      res.writeHead(200, {'content-type':'text/html; charset=utf-8','cache-control':'no-cache'});
      return void res.end(fs.readFileSync(path.resolve('src/ui/landing.html')));
    }
    if(u.pathname==='/app'||u.pathname==='/app/'){
      res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-cache'});
      return void res.end(fs.readFileSync(path.resolve('src/ui/index.html')));
    }
    if (req.method === 'GET' && ['/ui/app.js', '/ui/workspace.css', '/ui/vendor-effects.js', '/ui/landing.css', '/ui/landing.js'].includes(u.pathname)) {
      const file = path.resolve('src/ui', path.basename(u.pathname));
      res.writeHead(200, { 'content-type': u.pathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8', 'cache-control': 'no-cache' });
      return void res.end(fs.readFileSync(file));
    }
    if (req.method === 'GET' && u.pathname === '/api/reports') {
      const root = path.join(config.dataDir, 'runs');
      const entries = fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && /^job-[\w-]+$/.test(e.name)).map((e) => e.name).sort().reverse().slice(0, 30) : [];
      const reports = entries.flatMap((job) => {
        try {
          const r = JSON.parse(fs.readFileSync(path.join(root, job, 'report.json'), 'utf8'));
          return [{ job, url: r.url, startedAt: r.startedAt, brainVersion: r.brainVersion, findings: r.findings.length, unresolved: r.unresolved.length, ms: r.ms }];
        } catch { return []; }
      });
      return json(res, 200, { reports });
    }
    if (u.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      for (const e of recent) res.write(`data: ${JSON.stringify(e)}\n\n`);
      const on = (e: LpEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
      bus.on('event', on); req.on('close', () => bus.off('event', on));
      return;
    }
    if (u.pathname === '/api/status') {
      const reg = loadRegistry(); const labels = loadLabels();
      return json(res, 200, { busy, jobTarget, liveAudit: busy === 'audit' ? liveAudit : null, llm: llmAvailable(), model: config.model, search: searchAvailable(), active: reg.active,
        fixtures: [...labels.splits.dev.map((a) => ({ app: a, split: 'dev' })), ...labels.splits.heldout.map((a) => ({ app: a, split: 'held-out' }))], base: base() });
    }
    if (u.pathname === '/api/brain') {
      const reg = loadRegistry();
      const snapshots = new Map(reg.versions.map(v => [v, loadBrain(v)]));
      const versions = [...snapshots.values()].map(b => {
        const parent = snapshots.get(b.parent ?? '');
        return { version: b.version, parent: b.parent, vendors: b.vendors.length, probes: b.probes.length, changelog: b.changelog,
          addedVendors: parent ? b.vendors.filter(v => !parent.vendors.some(prior => prior.id === v.id)) : [],
          addedProbes: parent ? b.probes.filter(p => !parent.probes.some(prior => prior.id === p.id)) : [] };
      });
      return json(res, 200, { active: reg.active, versions, decisions: reg.decisions, brain: loadBrain(reg.active) });
    }
    if (req.method === 'GET' && u.pathname === '/api/learn/checker/latest') {
      return json(res,200,loadCheckerEvidence(config.dataDir,loadBrain()));
    }
    if (req.method === 'GET' && u.pathname === '/api/learn/real/latest') {
      const file=path.join(config.dataDir,'real-learning-latest.json');
      return json(res,200,fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null);
    }
    if (u.pathname === '/api/eval/latest') {
      const p = path.join(config.dataDir, 'eval', 'latest.json');
      return json(res, 200, fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);
    }
    if (req.method === 'GET' && u.pathname === '/api/eval/fresh/latest') {
      const file = path.join(config.dataDir, 'fresh-transfer.json');
      return json(res, 200, fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);
    }
    const rep = u.pathname.match(/^\/api\/report\/([\w.-]+)$/);
    if (rep) {
      const p = path.join(config.dataDir, 'runs', rep[1], 'report.json');
      if(!fs.existsSync(p))return json(res,404,{error:'not found'});
      const saved=JSON.parse(fs.readFileSync(p,'utf8'));
      let scan,brain;
      try{scan=JSON.parse(fs.readFileSync(path.join(config.dataDir,'runs',rep[1],'scan.json'),'utf8'));}catch{}
      try{brain=loadBrain(saved.brainVersion);}catch{if(/^real-[\w-]+$/.test(saved.learningCandidate?.job??'')){try{brain=JSON.parse(fs.readFileSync(path.join(config.dataDir,'real-learning',saved.learningCandidate.job,'candidate.json'),'utf8'));}catch{}}}
      const report=enrichReviewReport(saved,scan,brain);
      const summary=reviewAwareSummary(String(report.investigatorSummary??''),report.unresolved??[]);
      return json(res,200,summary===report.investigatorSummary?report:{...report,investigatorSummary:summary,investigatorSummaryOriginal:report.investigatorSummaryOriginal??report.investigatorSummary});
    }
    const art = u.pathname.match(/^\/artifacts\/([\w.-]+)\/([\w.-]+\.png)$/);
    if (art) {
      const p = path.join(config.dataDir, 'runs', art[1], art[2]);
      if (!fs.existsSync(p)) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'content-type': 'image/png' }); return void fs.createReadStream(p).pipe(res);
    }
    if (req.method === 'POST' && u.pathname === '/api/audit') {
      const b = await body(req);
      if (b.version !== undefined) {
        try { loadBrain(b.version); } catch { return json(res, 400, { error: 'Unknown or invalid brain version' }); }
      }
      if (String(b.url ?? '').startsWith('fixture:') && !/^fixture:app-[a-z0-9-]+$/.test(String(b.url))) return json(res, 400, { error: 'Invalid fixture name' });
      const url = String(b.url ?? '').startsWith('fixture:') ? `${base()}/${String(b.url).slice(8)}/` : String(b.url ?? '');
      try { const p = new URL(url); if (!/^https?:$/.test(p.protocol)) throw 0; } catch { return json(res, 400, { error: 'Enter an http(s) URL you are authorised to audit' }); }
      let candidate:Awaited<ReturnType<typeof loadFrozenVendorCandidate>>|undefined;
      if(b.candidateJob!==undefined){try{if(typeof b.candidateJob!=='string'||b.version!==undefined)throw new Error('Choose a candidate job or a retained version, not both');candidate=await loadFrozenVendorCandidate(b.candidateJob);}catch(error){return json(res,400,{error:error instanceof Error?error.message:String(error)});}}
      const job=`job-${new Date().toISOString().replace(/[:.]/g,'-')}`;
      return startJob(res, 'audit', () => runAudit(url, { job, version: b.version || undefined,...candidate }), {job,url});
    }
    if (req.method === 'POST' && u.pathname === '/api/learn/checker') {
      const b=await body(req);let target:URL;
      try{if(typeof b.url!=='string')throw new Error('Choose a website to learn from.');target=await validatePublicUrl(b.url,{resolveDns:false});}
      catch(error){return json(res,400,{error:error instanceof Error?error.message:'Enter a public HTTP(S) website.'});}
      if(!llmAvailable())return json(res,400,{error:'Real checker learning requires live Nemotron inference.'});
      let holdouts:string[]|undefined;
      if(b.holdouts!==undefined){if(!Array.isArray(b.holdouts)||b.holdouts.length<1||b.holdouts.length>10||b.holdouts.some((url:unknown)=>typeof url!=='string'))return json(res,400,{error:'holdouts must contain 1 to 10 public URLs'});holdouts=b.holdouts;try{for(const url of holdouts!)await validatePublicUrl(url,{resolveDns:false});}catch(error){return json(res,400,{error:String(error)});}}
      return startJob(res,'real checker learning',()=>learnRealChecker(target.href,holdouts,typeof b.checkpoint==='string'?b.checkpoint:undefined),{url:target.href});
    }
    if (req.method === 'POST' && u.pathname === '/api/learn/real') {
      const b=await body(req);let target:URL;
      try{if(typeof b.url!=='string')throw new Error('Choose a website to learn from.');target=await validatePublicUrl(b.url,{resolveDns:false});}
      catch(error){return json(res,400,{error:error instanceof Error?error.message:'Enter a public HTTP(S) website.'});}
      if(!llmAvailable() || !searchAvailable())return json(res,400,{error:'Real-site learning needs live inference and research.'});
      return startJob(res,'real-site learning',()=>learnOnRealSites(target.href),{url:target.href});
    }
    if (req.method === 'POST' && u.pathname === '/api/learn') return startJob(res, 'learning cycle', () => learnCycle(base(), loadLabels().splits.dev));
    if (req.method === 'POST' && u.pathname === '/api/eval/fresh') {
      const b = await body(req);
      try { loadBrain(b.from ?? 'v0'); loadBrain(b.to ?? undefined); } catch { return json(res, 400, { error: 'Unknown or invalid brain version' }); }
      return startJob(res, 'fresh-app transfer', async () => {
        const r = await evaluateFreshTransfer(b.from ?? 'v0', b.to);
        emit('eval', 'done', `Fresh-app checker transfer ${r.transferred ? 'passed' : 'did not pass'}; no inference used`, r);
      });
    }
    if (req.method === 'POST' && u.pathname === '/api/eval') {
      const b = await body(req);
      try { loadBrain(b.from ?? 'v0'); loadBrain(b.to ?? undefined); } catch { return json(res, 400, { error: 'Unknown or invalid brain version' }); }
      return startJob(res, 'held-out eval', () => runTransfer(base(), b.from || 'v0', b.to || undefined, b.llm !== false));
    }
    if (req.method === 'POST' && u.pathname === '/api/reset') {
      if (busy) return json(res, 409, { error: `Busy: ${busy}` });
      resetBrain(); emit('controller', 'info', 'Shared brain reset to v0'); return json(res, 200, { ok: true });
    }
    json(res, 404, { error: 'not found' });
  } catch (e: any) { json(res, e?.status ?? 500, { error: String(e?.message ?? e) }); }
});

server.listen(config.port, '127.0.0.1', () => {
  registerFixtureOrigin(base());
  console.log(`Clueso UI → http://localhost:${config.port}  (model ${llmAvailable() ? config.model : 'OFF'}, search ${searchAvailable() ? 'on' : 'OFF'})`);
});

async function shutdown() {
  server.closeAllConnections();
  server.close();
  await closeBrowser();
}
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
