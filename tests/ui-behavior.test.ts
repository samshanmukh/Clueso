import assert from 'node:assert/strict';
import { test, before, after, beforeEach, afterEach } from 'node:test';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright';

let root: string, base: string, child: ChildProcess, browser: Browser, page: Page;
let errors: string[];
const report = (job: string, name: string) => ({ job, url: `https://${name}.example/`, brainVersion: 'v0', startedAt: '2026-10-17T12:00:00Z', ms: 100,
  state: 'completed', verdict: 'One verified issue.', investigatorSummary: '', findings: [{ id: 'f1', key: 'undisclosed_vendor:mixpanel', type: 'undisclosed_vendor', subject: 'mixpanel', subjectName: 'Mixpanel', title: `${name} policy finding`, severity: 'medium', status: 'confirmed', source: 'check', evidence: [{ kind: 'policy', summary: 'The policy does not name Mixpanel.' }], rationale: 'Missing vendor disclosure.', verification: { status: 'confirmed', notes: ['Independently checked.'] }, repairPrompt: 'Add the observed service to the privacy policy. Acceptance checks: name Mixpanel and retain existing sections.', repairStatus: 'untested' }],
  unresolved: [], rejected: [], visual: [], scan: { consent: { found: false, clicked: false }, policy: { url: null, text: null }, screenshots: { pre: 'pre.png' }, requests: 1, assets: 0, stubbedThirdParties: false }, llm: { enabled: false, calls: 0, tokens: 0 } });

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'clueso-ui-behavior-'));
  await mkdir(path.join(root, 'brain/versions'), { recursive: true });
  await copyFile('brain/versions/v0.json', path.join(root, 'brain/versions/v0.json'));
  await writeFile(path.join(root, 'brain/registry.json'), JSON.stringify({ active: 'v0', versions: ['v0'], decisions: [] }));
  for (const [job, name] of [['job-ui-a','alpha'],['job-ui-b','beta']]) {
    const dir = path.join(root, 'data/runs', job); await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'report.json'), JSON.stringify(report(job, name)));
    await writeFile(path.join(dir, 'pre.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZuoAAAAASUVORK5CYII=', 'base64'));
  }
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = (socket.address() as { port: number }).port; await new Promise<void>(resolve => socket.close(() => resolve())); base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['src/server.ts'], { env: { ...process.env, PORT: String(port), LLM_MODE: 'off', YOU_API_KEY: '', LP_BRAIN_DIR: path.join(root, 'brain'), LP_DATA_DIR: path.join(root, 'data') }, stdio: ['ignore','pipe','pipe'] });
  let output = ''; child.stdout!.on('data', data => { output += data; }); child.stderr!.on('data', data => { output += data; });
  for (let i = 0; i < 100 && !output.includes('Clueso UI'); i++) { if (child.exitCode !== null) throw new Error(output); await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.match(output, /Clueso UI/); browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); if (child && child.exitCode === null) { const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped; } if (root) await rm(root, { recursive: true, force: true }); });
beforeEach(async () => { errors = []; page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.on('pageerror', error => errors.push(error.message)); });
afterEach(async () => { await page.close(); assert.deepEqual(errors, []); });
async function open(view = '') { await page.goto(`${base}/app?audit=job-ui-a${view ? '&view=' + view : ''}`); await page.waitForFunction(() => document.querySelector('#run-title')?.textContent?.includes('1 verified')); }
async function choose(job: string) { await page.locator('#history-trigger').click(); await page.locator(`#history-menu [data-option-value="${job}"]`).click(); }

test('Back and Forward restore the report as well as the active view', { timeout: 30_000 }, async () => {
  await open(); await page.locator('#nav-activity').click(); await page.locator('#nav-inspect').click(); await choose('job-ui-b');
  await page.waitForFunction(() => new URL(location.href).searchParams.get('audit') === 'job-ui-b');
  await page.goBack(); await page.waitForFunction(() => (document.querySelector('#history') as HTMLSelectElement).value === 'job-ui-a');
  assert.equal(await page.locator('#view-activity').isVisible(), true);
  await page.goForward(); await page.waitForFunction(() => (document.querySelector('#history') as HTMLSelectElement).value === 'job-ui-b');
  assert.match(await page.locator('#finding-list').innerText(), /beta policy finding/);
});

test('rapid Back and Forward cannot paint a late response over the current report', { timeout: 30_000 }, async () => {
  await open(); await page.locator('#nav-activity').click(); await page.locator('#nav-inspect').click(); await choose('job-ui-b');
  await page.waitForFunction(() => new URL(location.href).searchParams.get('audit') === 'job-ui-b');
  let release!: () => void, requested!: () => void;
  const started = new Promise<void>(resolve => { requested = resolve; });
  await page.route('**/api/report/job-ui-a', async route => { requested(); await new Promise<void>(resolve => { release = resolve; }); await route.fulfill({ json: report('job-ui-a','alpha') }); });
  await page.goBack(); await started; await page.goForward(); release(); await page.waitForTimeout(150);
  assert.equal(new URL(page.url()).searchParams.get('audit'), 'job-ui-b'); assert.equal(await page.locator('#history').inputValue(), 'job-ui-b');
  assert.match(await page.locator('#finding-list').innerText(), /beta policy finding/);
});

test('a missing saved report restores the previous selection and keeps the prior evidence', { timeout: 30_000 }, async () => {
  await open(); await page.evaluate(() => (document.querySelector('#history') as HTMLSelectElement).add(new Option('Missing report', 'job-missing')));
  await choose('job-missing'); await page.waitForFunction(() => !document.querySelector('#notice')!.hasAttribute('hidden'));
  assert.equal(await page.locator('#history').inputValue(), 'job-ui-a'); assert.match(await page.locator('#finding-list').innerText(), /alpha policy finding/);
  assert.equal(new URL(page.url()).searchParams.get('audit'), 'job-ui-a');
});

test('dropdown scrolling, keyboard focus and scroll position survive option refreshes', { timeout: 30_000 }, async () => {
  await open(); await page.evaluate(() => { const select = document.querySelector('#history') as HTMLSelectElement; for (let i = 0; i < 25; i++) select.add(new Option(`Archived ${i}`, `job-archived-${i}`)); });
  await page.locator('#history-trigger').click(); await page.keyboard.press('End');
  const menu = page.locator('#history-menu'); await menu.hover(); await page.mouse.wheel(0, 300); await page.waitForTimeout(100);
  assert.equal(await menu.evaluate(el => el.matches(':popover-open')), true);
  const scroll = await menu.evaluate(el => el.scrollTop), focused = await page.evaluate(() => (document.activeElement as HTMLElement).dataset.optionValue);
  await page.evaluate(() => (document.querySelector('#history') as HTMLSelectElement).add(new Option('New archive', 'job-new')));
  await page.waitForFunction(value => (document.activeElement as HTMLElement)?.dataset.optionValue === value, focused);
  assert.ok(Math.abs(await menu.evaluate(el => el.scrollTop) - scroll) < 2);
  await page.keyboard.press('Tab'); assert.equal(await menu.evaluate(el => el.matches(':popover-open')), false);
  assert.notEqual(await page.evaluate(() => document.activeElement?.tagName), 'BODY');
});

test('command buttons honor Enter on the focused control and explain unavailable screenshots', { timeout: 30_000 }, async () => {
  let audits = 0; await page.route('**/api/audit', route => { audits++; return route.fulfill({ status: 202, json: { started: 'audit' } }); });
  await open(); await page.locator('#open-commands').click(); await page.locator('#close-commands').focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#command-dialog').evaluate((el: HTMLDialogElement) => el.open), false); assert.equal(audits, 0);
  await page.locator('#open-commands').click(); await page.locator('[data-command]').filter({ hasText: 'Open learning lab' }).focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#n1').isVisible(), true); assert.equal(audits, 0);
  await page.locator('#open-commands').click(); await page.locator('#command-search').fill('after consent');
  assert.equal(await page.locator('#command-results button').isDisabled(), true); assert.match(await page.locator('#command-results').innerText(), /No after-consent screenshot/);
});

test('a failed auxiliary API does not block saved audits or evidence', { timeout: 30_000 }, async () => {
  await page.route('**/api/brain', route => route.fulfill({ status: 503, json: { error: 'Unavailable' } }));
  await open(); assert.match(await page.locator('#finding-list').innerText(), /alpha policy finding/); assert.equal(await page.locator('#go').isDisabled(), true);
  assert.match(await page.locator('#notice').innerText(), /reload to retry/i); await page.locator('#nav-evidence').click(); assert.match(await page.locator('#evidence').innerText(), /Missing vendor disclosure/);
});

test('missing screenshot artifacts explain the error and disable expansion', { timeout: 30_000 }, async () => {
  await page.route('**/artifacts/job-ui-a/pre.png', route => route.fulfill({ status: 404, body: 'missing' }));
  await open(); await page.waitForFunction(() => document.querySelector('#preview-stage')?.textContent?.includes('Screenshot unavailable'));
  assert.equal(await page.locator('#expand-preview').isDisabled(), true);
  assert.equal(await page.locator('#image-dialog').evaluate((el: HTMLDialogElement) => el.open), false);
});

test('invalid targets keep the saved report; bare domains get normalized', { timeout: 30_000 }, async () => {
  const bodies: any[] = []; await page.route('**/api/audit', route => { bodies.push(route.request().postDataJSON()); return route.fulfill({ status: 400, json: { error: 'Test rejection' } }); });
  await open(); await page.locator('#url').fill('not a website'); await page.locator('#go').click();
  assert.equal(bodies.length, 0); assert.equal(await page.locator('#history').inputValue(), 'job-ui-a'); assert.match(await page.locator('#finding-list').innerText(), /alpha policy finding/);
  await page.locator('#url').fill('example.com'); await page.locator('#go').click(); await page.waitForFunction(() => document.querySelector('#notice')?.textContent === 'Test rejection'); assert.equal(bodies[0].url, 'https://example.com');
});

test('busy responses keep actions disabled and explain the running operation', { timeout: 30_000 }, async () => {
  let busy: string | null = null;
  const original = await (await fetch(base + '/api/status')).json();
  await page.route('**/api/status', route => route.fulfill({ json: { ...original, busy } }));
  await page.route('**/api/eval/fresh', route => { busy = 'held-out eval'; return route.fulfill({ status: 409, json: { error: 'Busy: held-out eval' } }); });
  await open('learning'); await page.locator('#fresh').click(); await page.waitForFunction(() => document.querySelector('#lab-operation-state')?.textContent === 'Could not complete');
  assert.equal(await page.locator('#fresh').isDisabled(), true); assert.equal(await page.locator('#busy-notice').isVisible(), true);
});

test('reset requires confirmation and cancellation never submits a reset', { timeout: 30_000 }, async () => {
  let resets = 0; await page.route('**/api/reset', route => { resets++; return route.fulfill({ json: { ok: true } }); });
  await open('learning'); await page.locator('.lab-advanced > summary').click(); await page.locator('#reset').click();
  assert.equal(resets, 0); assert.equal(await page.locator('#cancel-reset').evaluate(el => el === document.activeElement), true);
  await page.locator('#cancel-reset').click(); assert.equal(resets, 0); await page.locator('#reset').click(); await page.keyboard.press('Escape'); assert.equal(resets, 0);
  await page.locator('#reset').click(); await page.locator('#confirm-reset').click(); await page.waitForFunction(() => document.querySelector('#notice')?.textContent?.includes('reset to v0')); assert.equal(resets, 1);
});

test('quick copy shows feedback and clipboard denial exposes the selectable prompt', { timeout: 30_000 }, async () => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } }));
  await open(); await page.locator('#quick-copy').click(); await page.waitForFunction(() => document.querySelector('#quick-copy')?.textContent === 'Copied ✓');
  assert.match(await page.locator('#notice').innerText(), /copied to clipboard/);
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Denied'); } } }));
  await page.locator('#quick-copy').click(); await page.waitForFunction(() => document.querySelector('#notice')?.textContent?.includes('selected for you'));
  assert.equal(await page.locator('.repair-details').getAttribute('open'), ''); assert.match(await page.evaluate(() => getSelection()?.toString() ?? ''), /Add the observed service/);
});

test('all views and expanded Advanced controls fit narrow and wide light/dark layouts', { timeout: 30_000 }, async () => {
  await open();
  for (const theme of ['light','dark']) {
    if (await page.evaluate(() => document.documentElement.dataset.theme) !== theme) await page.locator('#theme-toggle').click();
    for (const width of [320,390,768,1280]) {
      await page.setViewportSize({ width, height: 850 });
      for (const tab of ['nav-inspect','nav-evidence','learning-toggle','nav-activity']) {
        await page.locator('#' + tab).click(); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${theme} ${width} ${tab}: ${await page.evaluate(()=>[...document.querySelectorAll('body *')].filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.right>innerWidth+1}).slice(0,8).map(el=>el.tagName+'.'+el.className).join(', '))}`);
      }
      await page.locator('#learning-toggle').click(); await page.locator('.lab-advanced > summary').click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await page.locator('.lab-advanced > summary').click();
    }
  }
});


test('N+1 proof stays in Evidence while Inspect stays clear and Learning details start collapsed', {timeout:30000}, async()=>{
 await open();
 assert.equal(await page.locator('#learning-proof').count(),0);
 await page.locator('#nav-evidence').click();
 await page.locator('#evidence-learning-proof h2').waitFor();
 assert.match(await page.locator('#evidence-learning-proof').innerText(),/No learned checker retained yet/);
 assert.match(await page.locator('#evidence-learning-proof').innerText(),/Not proven/);
 await page.locator('#nav-evidence').click();
 assert.equal(await page.locator('#evidence-learning-proof').isVisible(),true);
 await page.locator('#learning-toggle').click();
 for(const id of ['learning-benchmarks','learning-experiments','learning-memory'])assert.equal(await page.locator('#'+id).getAttribute('open'),null);
 await page.locator('#nav-evidence').click();
 await page.locator('#evidence-learning-proof .proof-details').click();
 assert.equal(await page.locator('#learning-story').isVisible(),true);
 assert.equal(await page.locator('.learning-story-grid article').count(),3);
 assert.equal(await page.locator('#learning-memory').getAttribute('open'),'');
 assert.equal(await page.locator('#timeline').evaluate(el=>el===document.activeElement),true);
 for(const id of ['learning-benchmarks','learning-experiments'])assert.equal(await page.locator('#'+id).getAttribute('open'),null);
 await page.locator('#learning-experiments > summary').click();assert.equal(await page.locator('#real-checker-learning').isVisible(),true);
});


test('learning proof in Evidence reveals benchmark results on desktop and mobile', {timeout:30000}, async()=>{
 await page.emulateMedia({reducedMotion:'reduce'});
 const metrics=(tp:number,fn:number)=>({tp,fn,fp:0,unresolved:0,recall:tp/(tp+fn),ms:100,apps:[]});
 await page.route('**/api/eval/latest',route=>route.fulfill({json:{before:{version:'v0',metrics:metrics(1,3)},after:{version:'v1',metrics:metrics(4,0)},apps:['app-b']}}));
 for(const width of [1280,390]){
  await page.setViewportSize({width,height:850});
  await open();
  await page.waitForFunction(()=>document.querySelector('#evidence-learning-proof')?.textContent?.includes('1/4 → 4/4'));
  {
   await page.locator('#nav-evidence').click();
   await page.locator('#evidence-learning-proof .proof-details').click();
   assert.equal(await page.locator('#learning-benchmarks').getAttribute('open'),'');
   assert.equal(await page.locator('#evalbox').evaluate(el=>el===document.activeElement),true);
   const box=await page.locator('#evalbox').boundingBox();
   assert.ok(box&&box.y>=0&&box.y<400,'benchmark results should be scrolled into view');
   assert.match(await page.locator('#evalbox').innerText(),/1 \/ 4 issues found/);
   assert.match(await page.locator('#evalbox').innerText(),/4 \/ 4 issues found/);
  }
 }
});


test('agent rings restore per-site work and never reuse another audit’s score', {timeout:30000}, async()=>{
 await open();await page.locator('[data-agent="scanner"] [role="progressbar"]').waitFor();
 assert.equal(await page.locator('[data-agent="scanner"] [role="progressbar"]').getAttribute('aria-valuenow'),'100');
 assert.equal(await page.locator('[data-agent="learner"] [role="progressbar"]').getAttribute('aria-valuenow'),null);
 assert.match(await page.locator('[data-agent="learner"]').innerText(),/Not needed/);
 await page.route('**/api/report/job-ui-b',route=>route.fulfill({json:{...report('job-ui-b','beta'),roleWork:{scanner:{completed:2,total:4,state:'failed',detail:'Stopped after capture and probes'}}}}));
 await choose('job-ui-b');
 await page.waitForFunction(()=>document.querySelector('[data-agent="scanner"] [role="progressbar"]')?.getAttribute('aria-valuenow')==='50');
 assert.match(await page.locator('.team-site-progress').innerText(),/beta.example/);
 assert.match(await page.locator('[data-agent="scanner"]').innerText(),/Stopped/);
 await page.reload();await page.waitForFunction(()=>document.querySelector('[data-agent="scanner"] [role="progressbar"]')?.getAttribute('aria-valuenow')==='50');
 await choose('job-ui-a');await page.waitForFunction(()=>document.querySelector('[data-agent="scanner"] [role="progressbar"]')?.getAttribute('aria-valuenow')==='100');
});

test('live rings follow matching job checkpoints and preserve partial work when stopped', {timeout:30000}, async()=>{
 await page.addInitScript(()=>{class Events{onmessage:((event:{data:string})=>void)|null=null;onerror=null;constructor(){(window as any).testEvents=this;}};(window as any).EventSource=Events;});
 await open();
 await page.route('**/api/audit',route=>route.fulfill({status:202,json:{job:'job-live',url:'https://live.example/'}}));
 await page.locator('#url').fill('https://live.example/');await page.locator('#go').click();
 const send=async(job:string,completed:number)=>page.evaluate(({job,completed})=>{(window as any).testEvents.onmessage({data:JSON.stringify({t:Date.now(),job,role:'scanner',kind:'step',msg:'Page capture saved',data:{workProgress:{url:'https://live.example/',completed,total:4,state:'running',detail:'Page capture saved'}}})});},{job,completed});
 await send('job-live',1);await page.waitForFunction(()=>document.querySelector('[data-agent="scanner"] [role="progressbar"]')?.getAttribute('aria-valuenow')==='25');
 await send('unrelated-job',4);assert.equal(await page.locator('[data-agent="scanner"] [role="progressbar"]').getAttribute('aria-valuenow'),'25');
 await send('job-live',3);await page.waitForFunction(()=>document.querySelector('[data-agent="scanner"] [role="progressbar"]')?.getAttribute('aria-valuenow')==='75');
 await page.evaluate(()=>{(window as any).testEvents.onmessage({data:JSON.stringify({t:Date.now(),job:'job-live',role:'controller',kind:'error',msg:'Stopped for test'})});});
 await page.waitForFunction(()=>document.querySelector('[data-agent="scanner"]')?.getAttribute('data-state')==='failed');
 assert.equal(await page.locator('[data-agent="scanner"] [role="progressbar"]').getAttribute('aria-valuenow'),'75');
});

test('brand layout review shows measured guidance and locates the captured element', {timeout:30000}, async()=>{
 const snapshot:any=report('job-ui-a','alpha');
 const asset={selector:'#app-store',probe:'img-elements',technique:'img',href:'https://apps.apple.com/app/example',imageUrl:'https://alpha.example/badge.svg',naturalW:120,naturalH:40,drawnW:90,drawnH:30,contextShot:'pre.png',bounds:{x:40,y:80,width:90,height:30,viewportWidth:1280,viewportHeight:900}};
 snapshot.unresolved=[{id:'layout-badge',type:'brand_layout_review',subject:'apple-app-store-badge',summary:'App Store badge size / spacing needs review',data:{asset,selector:asset.selector,measuredHeight:30,minimumHeight:40,standardClearSpace:7.5,limitedClearSpace:3,nearestGap:2,neighbor:'Next label',spacingSupported:true,source:'https://developer.apple.com/app-store/marketing/guidelines/'}}];
 await page.route('**/api/report/job-ui-a',route=>route.fulfill({json:snapshot}));
 await open();await page.getByRole('button',{name:/App Store badge size \/ spacing needs review/}).click();
 assert.match(await page.locator('#evidence').innerText(),/Brand size & spacing/i);
 assert.match(await page.locator('#evidence').innerText(),/30.*40 px/s);
 assert.match(await page.locator('#evidence').innerText(),/Limited-space alternative/);
 assert.equal(await page.locator('#evidence a').filter({hasText:'Official size and clear-space guidance'}).getAttribute('href'),'https://developer.apple.com/app-store/marketing/guidelines/');
 assert.equal(await page.locator('.finding-focus-box').count(),1);
 assert.match(await page.locator('#preview-location').innerText(),/recorded position/);
 assert.equal(await page.locator('#copy-prompt').count(),0);
});

test('Inspect shares live learning execution and pauses the hidden panel', {timeout:30000}, async()=>{
 await page.addInitScript(()=>{class Events{onmessage:((event:{data:string})=>void)|null=null;onerror=null;constructor(){(window as any).testEvents=this;}};(window as any).EventSource=Events;});
 await open();
 assert.equal(await page.locator('#inspection-live-root .inspection-live-panel').count(),0);
 await page.route('**/api/learn/real',route=>route.fulfill({status:202,json:{started:'real-site learning'}}));
 await page.locator('#learning-toggle').click();await page.locator('#learn-real').click();
 await page.evaluate(()=>{(window as any).testEvents.onmessage({data:JSON.stringify({t:Date.now(),job:'real-ui',role:'learner',kind:'step',msg:'Researching services observed on this site'})});});
 await page.locator('#nav-inspect').click();
 const panel=page.locator('#inspection-live-root .inspection-live-panel');await panel.waitFor();
 await page.waitForFunction(()=>document.querySelector('#inspection-live-root h4')?.textContent==='Learning from evidence');
 assert.match(await panel.innerText(),/Nova is working/);
 assert.equal(await panel.locator('.learning-live-count strong').innerText(),'1');
 await page.waitForFunction(()=>document.querySelector('#inspection-live-root .inspection-live-panel')?.getAttribute('data-motion-paused')==='false');
 assert.equal(await page.locator('#lab-live-root .learning-live-stage').getAttribute('data-motion-paused'),'true');
 assert.equal(await panel.locator('.learning-live-agents').count(),0);
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.waitForFunction(()=>document.querySelector('#inspection-live-root .inspection-live-panel')?.getAttribute('data-motion-paused')==='true');
 await page.setViewportSize({width:390,height:850});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.locator('#learning-toggle').click();await page.emulateMedia({reducedMotion:'no-preference'});
 assert.equal(await panel.getAttribute('data-motion-paused'),'true');
 await page.evaluate(()=>{(window as any).testEvents.onmessage({data:JSON.stringify({t:Date.now(),role:'controller',kind:'done',msg:'__idle__'})});});
 await page.waitForFunction(()=>!document.querySelector('#inspection-live-root .inspection-live-panel'));
});

test('retained real checker proof reports coverage and opens its experiment evidence', {timeout:30000},async()=>{
 const state=await (await fetch(base+'/api/brain')).json() as any;
 const probe={id:'svg-artwork',name:'SVG artwork',description:'Measures SVG artwork',code:'return [];',codeHash:'test-only'};
 state.active='v1';state.brain.probes.push(probe);
 state.versions.push({version:'v1',parent:'v0',vendors:state.brain.vendors.length,probes:state.brain.probes.length,changelog:[],addedVendors:[],addedProbes:[probe]});
 state.decisions=[{parent:'v0',candidate:'v1',kind:'probe',accepted:true,summary:'Retained after independent transfer.',reasons:[],parentMetrics:{},candidateMetrics:{}}];
 const result={job:'checker-test',trainingUrl:'https://biuty.ai/',learnerModel:'Nemotron',frozenAt:'2026-10-17T20:00:00Z',probe,development:{cases:12,passed:true},executableCheckerTransferProven:true,promoted:true,unchanged:true,modelCallsDuringTransfer:0,results:[{url:'https://mojo-app.com/',transferred:true,reproducedMeasurements:6,first:{beforeUnmeasured:7,afterUnmeasured:1}}]};
 await page.route('**/api/brain',route=>route.fulfill({json:state}));
 let latestResult:any=result;
 await page.route('**/api/learn/checker/latest',route=>route.fulfill({json:latestResult}));
 await open();await page.waitForFunction(()=>document.querySelector('#evidence-learning-proof')?.textContent?.includes('0 → 6 new measurements'));
 const proof=await page.locator('#evidence-learning-proof').innerText();assert.match(proof,/Passed · real websites/);assert.match(proof,/measurement coverage, not compliance accuracy/);
 await page.locator('#nav-evidence').click();
 await page.locator('#evidence-learning-proof .proof-details').click();
 assert.equal(await page.locator('#learning-experiments').getAttribute('open'),'');
 assert.equal(await page.locator('#real-checker-learning').evaluate(el=>el===document.activeElement),true);
 assert.match(await page.locator('#real-checker-learning').innerText(),/Retained in the active brain/);
 assert.match(await page.locator('#learning-story').innerText(),/biuty\.ai/i);
 latestResult={job:'checker-later',status:'failed',promoted:false,error:'Development validation failed.',retainedResult:result};
 await page.reload();
 await page.waitForFunction(()=>document.querySelector('#evidence-learning-proof')?.textContent?.includes('0 → 6 new measurements'));
 await page.locator('#nav-evidence').click();await page.locator('#evidence-learning-proof .proof-details').click();
 assert.match(await page.locator('#real-checker-learning').innerText(),/No new checker accepted/);
 assert.match(await page.locator('#real-checker-learning').innerText(),/Retained in the active brain/);
 assert.equal(await page.locator('#real-checker-learning .real-checker-card').count(),2);
});

test('real-site learning uses the entered target and keeps the running target stable', {timeout:30000}, async()=>{
 await page.addInitScript(()=>{class Events{onmessage:((event:{data:string})=>void)|null=null;onerror=null;constructor(){(window as any).testEvents=this;}};(window as any).EventSource=Events;});
 const requests:any[]=[];await page.route('**/api/learn/real',route=>{requests.push(route.request().postDataJSON());return route.fulfill({status:202,json:{started:'real-site learning'}});});
 await open();await page.locator('#learning-toggle').click();
 assert.equal(await page.locator('#learn-real').innerText(),'Learn on alpha.example');
 await page.locator('#learn-real').click();assert.equal(requests[0].url,'https://alpha.example/');
 assert.equal(await page.locator('#lab-operation-title').innerText(),'Learn on alpha.example');
 await page.locator('#nav-inspect').click();await page.locator('#url').fill('beta.example/path');
 await page.locator('#learning-toggle').click();
 assert.equal(await page.locator('#learn-real').innerText(),'Learn on alpha.example · Running…');
 const idle=()=>page.evaluate(()=>{(window as any).testEvents.onmessage({data:JSON.stringify({t:Date.now(),role:'controller',kind:'done',msg:'__idle__'})});});
 await idle();await page.waitForFunction(()=>document.querySelector('#learn-real')?.textContent==='Learn on beta.example');
 await page.locator('#learn-real').click();assert.equal(requests[1].url,'https://beta.example/path');
 await idle();await page.waitForFunction(()=>!(document.querySelector('#learn-real') as HTMLButtonElement).disabled);
 await page.locator('#nav-inspect').click();await page.locator('#url').fill('fixture:app-a');await page.locator('#learning-toggle').click();
 await page.locator('#learn-real').click();assert.equal(requests.length,2);assert.match(await page.locator('#notice').innerText(),/Enter a public website/);
});

test('landing page explains the workflow and hands a website to /app without running it', {timeout:30000}, async()=>{
 let runs=0;await page.route('**/api/audit',route=>{runs++;return route.fulfill({status:400,json:{error:'Unexpected run'}});});
 await page.goto(base);assert.match(await page.title(),/Ship with fewer unknowns/);
 await page.locator('.landing-agent').first().waitFor();assert.equal(await page.locator('.landing-agent').count(),6);
 assert.equal(await page.locator('#audit-form').count(),0);
 await page.locator('[data-step="verify"]').click();assert.match(await page.locator('#demo-title').innerText(),/second look/);
 await page.locator('[data-step="verify"]').press('ArrowRight');assert.equal(await page.locator('[data-step="fix"]').getAttribute('aria-selected'),'true');
 await page.locator('#site-url').fill('new-site.example/work');await page.locator('#launch-form button').click();
 await page.waitForURL('**/app?url=*');await page.waitForFunction(()=>(document.querySelector('#url') as HTMLInputElement)?.value==='https://new-site.example/work');
 assert.equal(new URL(page.url()).pathname,'/app');assert.equal(runs,0);
 assert.equal(await page.locator('#run-title').innerText(),'Ready for inspection');
 assert.equal(await page.locator('#learn-real').innerText(),'Learn on new-site.example');
 assert.equal(await page.locator('#learn-checker').innerText(),'Learn checker on new-site.example');
});

test('landing page fits mobile and desktop in both themes and rejects invalid targets', {timeout:30000},async()=>{
 await page.goto(base);await page.locator('.landing-agent').first().waitFor();
 for(const theme of ['light','dark']){
  await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);
  for(const width of [320,390,768,1440]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${theme} landing overflow at ${width}`);}
 }
 await page.locator('#site-url').fill('javascript:alert(1)');await page.locator('#launch-form button').click();
 assert.equal(new URL(page.url()).pathname,'/');assert.equal(await page.locator('#launch-error').isVisible(),true);
 assert.equal(await page.locator('.nav-launch').getAttribute('href'),'/app');
});

test('legacy audit links redirect to /app while ordinary app entry loads the latest report', {timeout:30000},async()=>{
 await page.goto(base+'/?audit=job-ui-a&view=evidence');await page.waitForFunction(()=>document.querySelector('#run-title')?.textContent?.includes('1 verified'));
 assert.equal(new URL(page.url()).pathname,'/app');assert.equal(await page.locator('#view-evidence').isVisible(),true);
 await page.goto(base+'/app');await page.waitForFunction(()=>(document.querySelector('#history') as HTMLSelectElement)?.value==='job-ui-b');
 assert.match(await page.locator('#finding-list').innerText(),/beta policy finding/);
});

test('checker learning targets the selected site while saved evidence keeps its actual source', {timeout:30000},async()=>{
 const requests:any[]=[];await page.route('**/api/learn/checker',route=>{requests.push(route.request().postDataJSON());return route.fulfill({status:202,json:{started:'real checker learning'}});});
 await open();await page.locator('#url').fill('another.example/path');await page.locator('#learning-toggle').click();
 assert.equal(await page.locator('#learn-checker').innerText(),'Learn checker on another.example');
 await page.locator('#learn-checker').click();assert.equal(requests[0].url,'https://another.example/path');
 assert.equal(await page.locator('#lab-operation-title').innerText(),'Learn checker on another.example');
 assert.match(await page.locator('#learning-target').innerText(),/https:\/\/another.example\/path/);
});

test('an already-covered checker run finishes neutrally and preserves the no-change outcome', {timeout:30000},async()=>{
 await page.addInitScript(()=>{class Events{onmessage:((event:{data:string})=>void)|null=null;onerror=null;constructor(){(window as any).testEvents=this;}};(window as any).EventSource=Events;});
 const outcome={job:'checker-covered',trainingUrl:'https://alpha.example/',parent:'v0',status:'no_change',reason:'already_covered',message:'The current brain can already inspect the SVG badge artwork found on this site. No new checker was generated.',newExecutableCheckerLearned:false,promoted:false,results:[]};
 await page.route('**/api/learn/checker/latest',route=>route.fulfill({json:outcome}));
 await page.route('**/api/learn/checker',route=>route.fulfill({status:202,json:{started:'real checker learning'}}));
 await open();await page.locator('#learning-toggle').click();await page.locator('#learn-checker').click();
 await page.evaluate(outcome=>{(window as any).testEvents.onmessage({data:JSON.stringify({t:Date.now(),job:outcome.job,role:'learner',kind:'done',msg:outcome.message,data:{checkerOutcome:'no_change',job:outcome.job,trainingUrl:outcome.trainingUrl}})});},outcome);
 await page.waitForFunction(()=>document.querySelector('#lab-operation')?.getAttribute('data-state')==='no-change');
 assert.equal(await page.locator('#lab-operation-state').innerText(),'No new checker needed');
 await page.waitForFunction(()=>document.querySelector('#lab-live-root h4')?.textContent==='No new checker needed');
 assert.match(await page.locator('#lab-live-root').innerText(),/No new checker needed/);
 assert.doesNotMatch(await page.locator('#lab-live-root').innerText(),/Run stopped|See the error/);
 await page.evaluate(()=>{(window as any).testEvents.onmessage({data:JSON.stringify({t:Date.now(),role:'controller',kind:'done',msg:'__idle__'})});});
 await page.waitForFunction(()=>!(document.querySelector('#learn-checker') as HTMLButtonElement).disabled);
 assert.equal(await page.locator('#lab-operation').getAttribute('data-state'),'no-change');
 assert.equal(await page.locator('#lab-view-result').isVisible(),true);await page.locator('#lab-view-result').click();
 assert.match(await page.locator('#real-checker-learning').innerText(),/Already covered/);
 assert.doesNotMatch(await page.locator('#real-checker-learning').innerText(),/Learning attempt failed|Agent-written checking ability/);
});

test('text-link transfer shows classifications and reduced uncertainty without claiming image measurements', {timeout:30000},async()=>{
 const state=await(await fetch(base+'/api/brain')).json() as any;
 const probe={id:'text-store-links',name:'Text-only store links',kind:'store-link-classifier',code:'return [];',codeHash:'test-only'};
 state.active='v1';state.brain.probes.push(probe);state.versions.push({version:'v1',parent:'v0',vendors:state.brain.vendors.length,probes:state.brain.probes.length,changelog:[],addedVendors:[],addedProbes:[probe]});
 state.decisions=[{parent:'v0',candidate:'v1',kind:'probe',accepted:true,summary:'Text-link classification transfer.',reasons:[],parentMetrics:{},candidateMetrics:{}}];
 const result={capability:'text-store-links',job:'checker-text-test',trainingUrl:'https://training.example/',learnerModel:'Nemotron',frozenAt:'2026-10-18T01:00:00Z',probe,training:{beforeUnmeasured:1,afterUnmeasured:0},development:{cases:16,passed:true},executableCheckerTransferProven:true,promoted:true,unchanged:true,modelCallsDuringTransfer:0,results:[{url:'https://second.example/',transferred:true,reproducedClassifications:2,first:{beforeUnmeasured:2,afterUnmeasured:0}},{url:'https://unavailable.example/',error:'Navigation timed out',transferred:false,reproducedClassifications:0}]};
 await page.route('**/api/brain',route=>route.fulfill({json:state}));await page.route('**/api/learn/checker/latest',route=>route.fulfill({json:result}));
 await open('learning');await page.waitForFunction(()=>document.querySelector('#evidence-learning-proof')?.textContent?.includes('0 → 2 text links classified'));
 await page.locator('#learning-experiments summary').first().click();
 const card=await page.locator('#real-checker-learning').innerText();assert.match(card,/2 classifications reproduced/);assert.match(card,/Unresolved artwork links: 2 → 0/);assert.match(card,/Unavailable/);assert.match(card,/adds no image measurements/);assert.doesNotMatch(card,/2 measurements reproduced/);
 assert.match(await page.locator('#learning-story').innerText(),/Reduced uncertainty was reproduced/);
});

test('legacy unknown-vendor reviews explain evidence, timing, uncertainty and a site-specific next step', {timeout:30000},async()=>{
 const snapshot:any=report('job-ui-a','alpha');snapshot.findings=[];snapshot.state='completed_with_unknowns';snapshot.investigatorSummary='No further action required.';snapshot.scan.consent={found:true,clicked:true,text:'Accept'};snapshot.scan.policy={url:'https://alpha.example/privacy',text:'Policy'};
 snapshot.unresolved=[{id:'unknown-before',type:'unknown_third_party',subject:'service.example',summary:'7 request(s) to service.example — vendor not in the shared brain; fired before consent',data:{hosts:['cdn.service.example'],urls:['https://cdn.service.example/script.js?data=%3Cscript%3E'],phases:['pre','post']}},{id:'unknown-after',type:'unknown_third_party',subject:'later.example',summary:'Later service needs review',data:{requestCount:3,beforeConsent:0,afterConsent:3,hosts:['later.example'],urls:['https://later.example/collect'],phases:['post']}}];
 await page.route('**/api/report/job-ui-a',route=>route.fulfill({json:snapshot}));
 await page.goto(base+'/app?audit=job-ui-a');await page.waitForFunction(()=>document.querySelector('#run-title')?.textContent?.includes('12')||document.querySelector('#run-title')?.textContent?.includes('2 need review'));
 assert.match(await page.locator('#review-context').innerText(),/0 verified issues · 2 unclassified third-party domains/);
 let details=await page.locator('#evidence').innerText();assert.match(details,/Unclassified service: service.example/);assert.match(details,/no reviewed vendor rule/);assert.match(details,/Before and after/);assert.match(details,/Requests observed\s+7/);assert.match(details,/Timing alone does not establish/);assert.match(details,/What to check next/i);assert.doesNotMatch(details,/No further action required/);assert.equal(await page.locator('#copy-prompt').count(),0);
 await page.locator('.review-requests summary').click();assert.match(await page.locator('.review-requests').innerText(),/cdn.service.example\/script.js/);assert.equal(await page.locator('#evidence script').count(),0);
 await page.locator('[data-finding="review-1"]').click();details=await page.locator('#evidence').innerText();assert.match(details,/Only requests after/);assert.match(details,/Requests observed\s+3/);assert.doesNotMatch(details,/Requests observed\s+7/);
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await page.locator('#url').fill('https://different.example/');await page.locator('#open-vendor-learning').click();assert.equal(await page.locator('#url').inputValue(),'https://alpha.example/');assert.equal(await page.locator('#learn-real').innerText(),'Learn on alpha.example');assert.equal(await page.locator('#real-learning').evaluate(el=>el===document.activeElement),true);
});

test('replayed completion events cannot replace an explicitly requested saved audit during startup', {timeout:30000},async()=>{
 await page.addInitScript(()=>{class Events{onmessage:((event:{data:string})=>void)|null=null;onerror=null;constructor(){(window as any).testEvents=this;}};(window as any).EventSource=Events;});
 let release!:()=>void,requested!:()=>void;const started=new Promise<void>(resolve=>requested=resolve);
 await page.route('**/api/report/job-ui-a',async route=>{requested();await new Promise<void>(resolve=>release=resolve);await route.fulfill({json:report('job-ui-a','alpha')});});
 await page.goto(base+'/app?audit=job-ui-a');await started;
 await page.evaluate(()=>{(window as any).testEvents.onmessage({data:JSON.stringify({t:Date.now()-60_000,job:'job-ui-b',role:'controller',kind:'done',msg:'Prior audit completed',data:{job:'job-ui-b'}})});});
 await page.waitForTimeout(80);release();await page.waitForFunction(()=>document.querySelector('#finding-list')?.textContent?.includes('alpha policy finding'));
 assert.equal(new URL(page.url()).searchParams.get('audit'),'job-ui-a');assert.equal(await page.locator('#history').inputValue(),'job-ui-a');assert.doesNotMatch(await page.locator('#finding-list').innerText(),/beta policy finding/);
});

test('experimental vendor re-audits visibly identify the candidate without changing the active version selection', {timeout:30000},async()=>{
 const snapshot:any=report('job-ui-a','alpha');snapshot.brainVersion='v1';snapshot.learningCandidate={job:'real-candidate',parent:'v0',scope:'Experimental vendor research candidate; not retained in the active brain.'};
 await page.route('**/api/learn/real/latest',route=>route.fulfill({json:{trainingUrl:'https://alpha.example/',results:[],learnedVendors:[],training:{unknownDomains:[]},unchanged:true,modelCallsDuringTransfer:0,reAudit:{job:'job-ui-a',beforeUnknown:12,freshUnknown:9,proposedRuleReviews:3,totalReviews:12,investigatorIncomplete:true}}}));
 await page.route('**/api/report/job-ui-a',route=>route.fulfill({json:snapshot}));await open();
 assert.match(await page.locator('#run-meta').innerText(),/Brain v1 \(candidate · not retained\)/);assert.equal(await page.locator('#ver').inputValue(),'v0');assert.match(await page.locator('#real-learning').textContent()??'',/Unclassified domains: 12 → 9/);assert.match(await page.locator('#real-learning').textContent()??'',/investigator did not finish/);
});

test('experimental vendor conclusions stay explicit reviews and keep network details beside the website', {timeout:30000},async()=>{
 const snapshot:any=report('job-ui-a','alpha');snapshot.findings=[];snapshot.learningCandidate={job:'real-candidate',parent:'v0',scope:'Experimental'};snapshot.unresolved=[{id:'rule-review',type:'vendor_rule_review',subject:'new-vendor',summary:'Proposed service rule needs review',data:{vendor:{name:'New Vendor',sources:[{url:'https://vendor.example/docs'}]},finding:{title:'Possible pre-consent request',evidence:[{kind:'request',data:{url:'https://cdn.vendor.example/beacon'}}]}}}];
 await page.route('**/api/report/job-ui-a',route=>route.fulfill({json:snapshot}));await page.goto(base+'/app?audit=job-ui-a');await page.waitForFunction(()=>document.querySelector('#run-title')?.textContent?.includes('1 need review'));
 assert.match(await page.locator('#review-context').innerText(),/1 proposed-rule reviews/);const details=await page.locator('#evidence').innerText();assert.match(details,/new vendor rule has not been accepted/);assert.match(details,/remains provisional/);assert.equal(await page.locator('#evidence a[href="https://vendor.example/docs"]').count(),1);assert.equal(await page.locator('#copy-prompt').count(),0);assert.equal(await page.locator('#preview-stage .preview-finding-note').count(),0);
});

test('review dossiers expose recorded evidence and copy the selected conditional check-and-fix prompt', {timeout:30000},async()=>{
 const {enrichReviewReport}=await import('../src/reviews/details.ts');
 const snapshot:any=report('job-ui-a','alpha');snapshot.findings=[];snapshot.scan.policy={url:'https://alpha.example/privacy',text:'Policy'};snapshot.scan.consent={found:true,clicked:true,text:'Accept'};
 snapshot.unresolved=['first.example','second.example'].map((domain,i)=>({id:'review-'+i,type:'unknown_third_party',subject:domain,summary:`3 request(s) to ${domain} — vendor not in the shared brain`,data:{hosts:[domain],urls:[`https://${domain}/collect?secret=private-value`],phases:['pre','post']}}));
 const scan:any={requests:[{id:'r1',host:'first.example',url:'https://first.example/collect?secret=private-value',phase:'pre',type:'fetch',t:250},{id:'r2',host:'first.example',url:'https://first.example/collect',phase:'post',type:'fetch',t:1250},{id:'r3',host:'second.example',url:'https://second.example/script.js',phase:'pre',type:'script',t:500}],policy:{url:'https://alpha.example/privacy',text:'Our first service is provided by First.example.'}};
 const enriched=enrichReviewReport(snapshot,scan);
 await page.addInitScript(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(text:string)=>{(window as any).copiedReviewPrompt=text;}}}));
 await page.route('**/api/report/job-ui-a',route=>route.fulfill({json:enriched}));await page.goto(base+'/app?audit=job-ui-a&view=evidence');await page.waitForFunction(()=>document.querySelector('.review-dossier')!==null);
 assert.deepEqual(await page.locator('.review-metrics strong').allTextContents(),['2','1','1']);assert.match(await page.locator('.review-request-table').innerText(),/0.25s/);assert.match(await page.locator('#evidence').innerText(),/Policy evidence/i);assert.match(await page.locator('#evidence').innerText(),/What to fix · only if confirmed/i);assert.equal(await page.locator('#preview-stage .preview-finding-note').count(),0);
 await page.locator('#copy-review-prompt').click();let copied=await page.evaluate(()=>(window as any).copiedReviewPrompt);assert.match(copied,/first.example/);assert.doesNotMatch(copied,/private-value|second.example/);assert.match(copied,/Verify it before changing code/);assert.match(copied,/ACCEPTANCE CHECKS/);
 await page.locator('[data-finding="review-1"]').click();await page.locator('#quick-copy').click();copied=await page.evaluate(()=>(window as any).copiedReviewPrompt);assert.match(copied,/second.example/);assert.doesNotMatch(copied,/first.example/);
 await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw Error('Denied');}}}));await page.locator('#copy-review-prompt').click();assert.equal(await page.locator('.review-prompt-details').getAttribute('open'),'');assert.match(await page.evaluate(()=>getSelection()?.toString()??''),/second.example/);
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.locator('#nav-inspect').click();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
});
