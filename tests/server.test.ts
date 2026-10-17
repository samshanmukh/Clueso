import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { chromium } from 'playwright';

test('UI starts, API rejects invalid requests, and browser audit renders evidence and fix prompts', { timeout: 90_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-server-test-'));
  await fs.mkdir(path.join(root, 'brain/versions'), { recursive: true });
  await fs.copyFile('brain/versions/v0.json', path.join(root, 'brain/versions/v0.json'));
  await fs.writeFile(path.join(root, 'brain/registry.json'), JSON.stringify({ active: 'v0', versions: ['v0'], decisions: [] }));
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = (socket.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.ts'], { env: { ...process.env, PORT: String(port), LLM_MODE: 'off', YOU_API_KEY: '', LP_BRAIN_DIR: path.join(root, 'brain'), LP_DATA_DIR: path.join(root, 'data') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', (s) => { output += s; }); child.stderr.on('data', (s) => { output += s; });
  let browser;
  try {
    for (let i = 0; i < 100; i++) {
      if (output.includes('Clueso UI')) break;
      if (child.exitCode !== null) throw new Error(output);
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.match(output, /Clueso UI/);
    assert.equal(await (await fetch(`${base}/api/learn/checker/latest`)).json(),null);
    assert.equal((await fetch(`${base}/api/learn/checker`,{method:'POST'})).status,400);
    assert.equal(await (await fetch(`${base}/api/learn/real/latest`)).json(),null);
    assert.equal((await fetch(`${base}/api/learn/real`,{method:'POST'})).status,400); // Never run live learning when inference is disabled.

    const post = (body: string, headers = {}) => fetch(`${base}/api/audit`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
    assert.equal((await post('{')).status, 400);
    assert.equal((await post('[]')).status, 400);
    assert.equal((await post(JSON.stringify({ url: 'fixture:app-a', version: '../v0' }))).status, 400);
    assert.equal((await post('{}', { origin: 'https://untrusted.example' })).status, 403);
    assert.equal((await post(JSON.stringify({ url: 'fixture:../../secret' }))).status, 400);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base);
    await page.waitForFunction(() => document.querySelector('#ver option[value="v0"]') !== null);
    await page.waitForFunction(() => document.querySelectorAll('.agent-card canvas').length === 6);
    await page.waitForFunction(() => document.documentElement.dataset.motion === 'framer');
    assert.equal(await page.locator('#pills').count(),0);
    assert.equal(await page.locator('#url').inputValue(),'https://zupapps.com/');
    await page.locator('[data-example="https://mojo-app.com/"]').click();
    assert.equal(await page.locator('#url').inputValue(),'https://mojo-app.com/');
    await page.locator('[data-example="https://zupapps.com/"]').click();
    assert.equal(await page.locator('[data-example="https://zupapps.com/"]').getAttribute('aria-pressed'),'true');
    // Keep integration audits offline and deterministic; public examples are never auto-audited.
    await page.locator('#url').fill('fixture:app-a');

    await page.locator('#ver-trigger').click();
    assert.equal(await page.locator('#ver-menu').isVisible(),true);
    await page.locator('#ver-menu [role=option]').first().click();
    assert.equal(await page.locator('#ver').inputValue(),'v0');
    assert.equal(await page.locator('#ver-menu').isVisible(),false);

    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'light');
    await page.locator('#theme-toggle').click();
    assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).colorScheme),'dark');
    await page.reload();
    await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark' && document.querySelector('#ver option[value="v0"]'));
    assert.equal(await page.locator('#theme-toggle').getAttribute('aria-pressed'),'true');
    await page.locator('#theme-toggle').click();
    assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).colorScheme),'light');
    await page.keyboard.press('Control+k');
    assert.equal(await page.locator('#command-dialog').evaluate((el: HTMLDialogElement) => el.open), true);
    await page.locator('#command-search').fill('review');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('[data-filter=review]').getAttribute('aria-pressed'), 'true');
    await page.locator('[data-filter=all]').click();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.locator('#input-beam-root [data-beam][data-active]').waitFor();
    await page.waitForFunction(()=>{
      const beam=document.querySelector('#input-beam-root [data-beam]');
      return beam && Number(getComputedStyle(beam,'::after').opacity)>0.1;
    });
    assert.equal(await page.evaluate(()=>{
      const root=document.getElementById('input-beam-root')!;
      const form=document.getElementById('audit-form')!;
      const beam=root.querySelector('[data-beam]')!;
      return Number(getComputedStyle(root).zIndex)>Number(getComputedStyle(form).zIndex) && getComputedStyle(root).pointerEvents==='none' && beam.getBoundingClientRect().height>30;
    }),true);

    await page.locator('#url').fill('fixture:app-a');
    await page.clock.install();
    const accepted = page.waitForResponse((r) => r.url().endsWith('/api/audit') && r.request().method() === 'POST');
    await page.locator('#go').click();
    assert.equal((await accepted).status(), 202);
    // Submission clears the previous report immediately; the browser capture arrives before completion.
    assert.equal(await page.locator('#preview-stage .website-shot:not(.live-website-shot)').count(),0);
    assert.match(await page.locator('#preview-url').innerText(),/fixture:app-a|fixtures\/app-a/);
    await page.locator('#preview-bot-root .inspection-bot').waitFor();
    await page.locator('[data-agent=scanner][data-state=working]').waitFor();
    assert.match(await page.locator('#go').innerText(), /Scanner working/);
    assert.equal(await page.locator('#go #busy-orb-root .orb-status').isVisible(),true);
    assert.equal(await page.locator('.inspection-heading .orb-status').count(),0);
    await page.locator('.live-website-shot').waitFor();
    await page.locator('.inspection-target').waitFor();
    assert.equal(await page.locator('#go').isDisabled(),true);
    assert.equal(await page.locator('.inspection-bot canvas').count(),1);
    const liveStatus = await (await fetch(`${base}/api/status`)).json();
    assert.equal(liveStatus.busy,'audit');
    assert.match(liveStatus.liveAudit.url,/fixtures\/app-a/);
    assert.match(liveStatus.liveAudit.preview.file,/opening\.png|pre\.png/);
    assert.equal((await fetch(`${base}/artifacts/${liveStatus.liveAudit.job}/${liveStatus.liveAudit.preview.file}`)).status,200);
    await page.clock.fastForward(1300); // Exercise motion without artificially delaying the real scanner.
    await page.waitForFunction(()=>Number(document.querySelector('[data-target-index]')?.getAttribute('data-target-index'))>0);
    // Reloading during an audit restores its current snapshot, not an older completed report.
    await page.reload();
    await page.locator('.live-website-shot').waitFor();
    await page.locator('#preview-bot-root .inspection-bot').waitFor();
    assert.match(await page.locator('#preview-url').innerText(),/fixtures\/app-a/);

    await fs.mkdir('data/ui-review',{recursive:true});
    await page.locator('#theme-toggle').click();
    await page.screenshot({path:'data/ui-review/audit-button-working.png'});
    await page.locator('#theme-toggle').click();
    assert.equal(await page.locator('.team-heading .state-shimmer').evaluate(el=>getComputedStyle(el).animationName),'shimmer');
    await page.emulateMedia({reducedMotion:'reduce'});
    assert.equal(await page.locator('.team-heading .state-shimmer').evaluate(el=>getComputedStyle(el).animationName),'none');
    await page.waitForFunction(() => document.querySelector('#report')?.textContent?.includes('Meta Pixel'), { timeout: 60_000 });
    await page.locator('[data-agent=scanner][data-state=sleeping]').waitFor();
    assert.equal(await page.locator('.inspection-bot').count(),0);
    assert.equal(await page.locator('.live-website-shot').count(),0);
    assert.equal(await page.locator('[data-agent=learner]').getAttribute('data-state'),'idle');
    const reportText = await page.locator('#report').innerText();
    assert.match(reportText, /Mixpanel/);
    assert.match(reportText, /Apple App Store/);
    await page.locator('#report details').first().locator('summary').click();
    assert.match(await page.locator('#report details').first().innerText(), /Acceptance checks/);
    assert.deepEqual(errors, []);
    const runs = await fs.readdir(path.join(root, 'data/runs'));
    const report = JSON.parse(await fs.readFile(path.join(root, 'data/runs', runs[0], 'report.json'), 'utf8'));
    assert.equal(report.findings.length, 3);
    assert.equal(report.scan.stubbedThirdParties, true);
    await page.locator('[data-finding]').filter({ hasText: 'Apple App Store' }).click();
    await page.waitForFunction(() => document.querySelector('#evidence')?.textContent?.includes('Measured by browser'));
    assert.match(await page.locator('#evidence').innerText(), /Painted dimensions/);
    await page.locator('.finding-focus-box').waitFor();
    assert.match(await page.locator('.preview-finding-note').innerText(),/Element located/);
    assert.match(await page.locator('#preview-stage .website-shot').getAttribute('src')??'',/asset-context/);
    assert.ok(Number(await page.locator('.finding-focus-box').evaluate(el=>el.getBoundingClientRect().width))>0);
    await page.locator('#toggle-finding-focus').click();
    assert.equal(await page.locator('.finding-focus-box').count(),0);
    await page.locator('[data-finding]').filter({hasText:'Apple App Store'}).click();
    await page.locator('.finding-focus-box').waitFor();
    await page.locator('[data-finding]').filter({hasText:'Mixpanel'}).click();
    assert.equal(await page.locator('.finding-focus-box').count(),0);
    assert.match(await page.locator('.preview-finding-note').innerText(),/Network evidence/);
    assert.match(await page.locator('.preview-finding-note').innerText(),/no visible element/);
    await page.locator('[data-finding]').filter({hasText:'Apple App Store'}).click();

    assert.ok(await page.locator('.marker').count() > 0);
    await page.locator('#nav-evidence').click();
    assert.equal(await page.locator('#view-evidence').isVisible(), true);
    assert.equal(await page.locator('#view-inspection').isVisible(), false);
    assert.equal(await page.locator('.preview-pane').isVisible(), false);
    assert.match(await page.locator('#evidence').innerText(), /Apple App Store/);
    assert.equal(new URL(page.url()).searchParams.get('view'), 'evidence');
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#finding-list')?.textContent?.includes('Apple App Store'));
    assert.equal(await page.locator('#view-evidence').isVisible(), true);
    await page.locator('#nav-activity').click();
    assert.equal(await page.locator('#view-activity').isVisible(), true);
    assert.equal(await page.locator('#view-evidence').isVisible(), false);
    await page.goBack();
    assert.equal(await page.locator('#view-evidence').isVisible(), true);
    await page.locator('#nav-inspect').click();
    await page.locator('[data-finding]').filter({ hasText: 'Apple App Store' }).click();
    await page.locator('#expand-preview').click();
    assert.equal(await page.locator('#image-dialog').evaluate((el: HTMLDialogElement) => el.open), true);
    await page.keyboard.press('Escape');
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#finding-list')?.textContent?.includes('Apple App Store'));
    assert.match(new URL(page.url()).searchParams.get('audit') ?? '', /^job-/);
    await page.locator('[data-filter="review"]').click();
    assert.equal(await page.locator('#copy-prompt').count(), 0);
    await page.locator('[data-filter=all]').click();
    await page.locator('[data-finding]').filter({hasText:'Apple App Store'}).click();
    await page.setViewportSize({width:1512,height:1100});
    await fs.mkdir('data/ui-review',{recursive:true});
    await page.screenshot({path:'data/ui-review/light-workspace.png',fullPage:true});
    await page.locator('#theme-toggle').click();
    await page.locator('#url').focus();
    await page.screenshot({path:'data/ui-review/dark-workspace.png',fullPage:true});
    await page.locator('#theme-toggle').click();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.locator('#learning-toggle').click();
    // No experiment means no invented per-agent progress scores.
    await page.locator('#learning-memory > summary').click();
    await page.locator('#agent-progress-title').waitFor();
    assert.equal(await page.locator('[data-learning-agent]').count(), 6);
    assert.equal(await page.locator('#agent-progress-root [role=progressbar]').count(), 0);
    const learningEvidence = {
      from:'v1',to:'v2',unchanged:true,promoted:false,modelCallsDuringTransfer:0,
      training:{unknownDomains:['beacon.example'],probesBefore:2,probesAfter:2},
      learnedVendors:[{id:'beacon',name:'Beacon',domains:['beacon.example'],sources:[{url:'https://beacon.example/docs'}]}],
      results:[
        {url:'https://one.example/',independentRecheck:true,verifiedRecognitions:[{vendorId:'beacon',hosts:['static.beacon.example']}],knowledgeTransferred:true},
        {url:'https://two.example/',verifiedRecognitions:[],knowledgeTransferred:false},
        {url:'https://three.example/',verifiedRecognitions:[],knowledgeTransferred:false},
      ],
      newExecutableCheckerLearned:false,knowledgeTransferred:true,scope:'Test evidence',frozenAt:'2026-10-17T00:00:00Z',fingerprint:'test',
    };
    await page.route('**/api/learn/real/latest', route => route.fulfill({json:learningEvidence}));
    // Feed a deterministic saved comparison to verify the visual renderer, not a new model run.
    const sampleMetrics = {tp:1,fn:3,fp:0,recall:.25,unresolved:4,ms:1000,apps:[]};
    await page.route('**/api/eval/latest',route=>route.fulfill({json:{apps:['app-b','app-d'],before:{version:'v0',metrics:sampleMetrics},after:{version:'v1',metrics:{...sampleMetrics,tp:4,fn:0,recall:1,unresolved:0}},llm:false}}));
    await page.reload();
    await page.waitForFunction(()=>document.querySelectorAll('.score-ring').length===2);
    const novaBar = page.locator('[data-learning-agent=learner] [role=progressbar]');
    const scoutBar = page.locator('[data-learning-agent=scanner] [role=progressbar]');
    await novaBar.waitFor({state:'attached'});
    await page.locator('#learning-memory > summary').click();
    await novaBar.waitFor();
    assert.equal(await novaBar.getAttribute('aria-valuenow'),'1');
    assert.equal(await novaBar.getAttribute('aria-valuemax'),'1');
    assert.equal(await scoutBar.getAttribute('aria-valuenow'),'1');
    assert.equal(await scoutBar.getAttribute('aria-valuemax'),'3');
    assert.equal(await page.locator('#agent-progress-root [role=progressbar]').count(),2);
    assert.equal(await page.locator('[data-learning-agent=verifier] [role=progressbar]').count(),0);
    assert.match(await page.locator('[data-learning-agent=verifier]').innerText(),/Not measured/);
    assert.match(await page.locator('.agent-progress-footnote').innerText(),/not model training or accuracy/);
    await page.waitForFunction(()=>{const fill=document.querySelector('.agent-learning-fill');return fill&&new DOMMatrix(getComputedStyle(fill).transform).a===1;});
    await page.locator('#learning-benchmarks > summary').click();
    assert.match(await page.locator('#evalbox').innerText(), /25/);
    assert.match(await page.locator('#evalbox').innerText(), /100/);
    assert.equal(await page.locator('#evalbox table').isVisible(),false);
    await page.locator('#evalbox .lab-details > summary').click();
    assert.equal(await page.locator('#evalbox table').isVisible(),true);
    await page.locator('#evalbox .lab-details > summary').click();
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.setViewportSize({width:1280,height:800});
    await page.waitForFunction(() => !(document.querySelector('#fresh') as HTMLButtonElement).disabled);
    const freshAccepted = page.waitForResponse((r) => r.url().endsWith('/api/eval/fresh') && r.request().method() === 'POST');
    await page.locator('#fresh').click();
    assert.equal((await freshAccepted).status(), 202);
    await page.waitForFunction(() => document.querySelector('#freshbox')?.textContent?.includes('not proven'), { timeout: 60_000 });
    const fresh = await (await fetch(`${base}/api/eval/fresh/latest`)).json();
    assert.equal(fresh.transferred, false); // v0 -> v0 must never claim a learned capability.
    assert.ok(fresh.results.every((r: any) => r.modelCalls === 0));
    // A different second audit must not keep the first site's image or findings visible.
    await page.locator('#nav-inspect').click();
    await page.waitForFunction(() => !(document.querySelector('#go') as HTMLButtonElement).disabled);
    const previousImage = await page.locator('#preview-stage .website-shot').getAttribute('src');
    await page.locator('#url').fill('fixture:app-c');
    const secondAccepted = page.waitForResponse(r => r.url().endsWith('/api/audit') && r.request().method()==='POST');
    await page.locator('#go').click();
    assert.equal((await secondAccepted).status(),202);
    assert.match(await page.locator('#preview-url').innerText(),/fixture:app-c|fixtures\/app-c/);
    assert.equal(await page.locator('#history').inputValue(),'');
    assert.doesNotMatch(await page.locator('#finding-list').innerText(),/Meta Pixel/);
    assert.equal(await page.locator('#preview-stage .website-shot:not(.live-website-shot)').count(),0);
    await page.locator('.live-website-shot').waitFor();
    assert.notEqual(await page.locator('.live-website-shot').getAttribute('src'),previousImage);
    await page.locator('#preview-stage .website-shot:not(.live-website-shot)').waitFor();
    assert.match(await page.locator('#preview-url').innerText(),/fixtures\/app-c/);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    const exited = once(child, 'exit'); child.kill('SIGTERM');
    await exited;
    await fs.rm(root, { recursive: true, force: true });
  }
});
