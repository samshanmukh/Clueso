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
async function open(view = '') { await page.goto(`${base}/?audit=job-ui-a${view ? '&view=' + view : ''}`); await page.waitForFunction(() => document.querySelector('#run-title')?.textContent?.includes('1 verified')); }
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


test('N+1 proof is visible in inspections and evidence while Learning details start collapsed', {timeout:30000}, async()=>{
 await open();
 await page.locator('#learning-proof h2').waitFor();
 assert.match(await page.locator('#learning-proof').innerText(),/No learned checker retained yet/);
 assert.match(await page.locator('#learning-proof').innerText(),/Not proven/);
 await page.locator('#nav-evidence').click();
 assert.equal(await page.locator('#evidence-learning-proof').isVisible(),true);
 await page.locator('#evidence-learning-proof .proof-details').click();
 assert.equal(await page.locator('#learning-story').isVisible(),true);
 assert.equal(await page.locator('.learning-story-grid article').count(),3);
 for(const id of ['learning-benchmarks','learning-experiments','learning-memory'])assert.equal(await page.locator('#'+id).getAttribute('open'),null);
 await page.locator('#learning-experiments > summary').click();assert.equal(await page.locator('#real-checker-learning').isVisible(),true);
});
