import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { bus, type LpEvent } from '../src/events.ts';
import { scan, registerFixtureOrigin, closeBrowser, getBrowser, captureEvidence } from '../src/scan/scanner.ts';
import { loadBrain } from '../src/brain/store.ts';
import { verifyFinding } from '../src/agents/verifier.ts';
import type { Finding } from '../src/checks/checks.ts';

test('scanner and verifier inspect rendered pages while a media request remains pending', { timeout: 25_000 }, async () => {
  let pendingMedia = 0;
  const server = createServer((request, response) => {
    if (request.url?.endsWith('/slow.png')) {
      pendingMedia++;
      response.writeHead(200, { 'content-type': 'image/png' });
      response.flushHeaders(); // Deliberately never finish: the load event cannot fire.
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<!doctype html><html><body><h1>Rendered content</h1>
      <a href="/fixtures/app-z/privacy.html">Privacy policy</a>
      <p>We do not collect personal information.</p>
      <img width="20" height="20" src="/fixtures/app-z/slow.png"></body></html>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  registerFixtureOrigin(base);
  const url = `${base}/fixtures/app-z/`;
  const root = await mkdtemp(join(tmpdir(), 'clueso-scanner-'));
  const previews: LpEvent[] = [];
  const onEvent = (event: LpEvent) => { if ((event.data as any)?.preview) previews.push(event); };
  bus.on('event', onEvent);
  try {
    const brain = loadBrain('v0');
    const result = await scan(url, brain, root);
    assert.ok(previews.length >= 2);
    const first = (previews[0].data as any).preview;
    assert.equal(first.url, url);
    assert.equal(first.file, 'opening.png');
    assert.equal(first.width, 1280);
    assert.ok(first.targets.some((target: any) => target.label === 'Privacy policy'));
    assert.ok(first.targets.every((target: any) => target.x >= 0 && target.y >= 0 && target.x + target.width <= first.width && target.y + target.height <= first.height));
    assert.deepEqual([...(await readFile(join(root, first.file))).subarray(0, 4)], [137, 80, 78, 71]);
    assert.ok(result.policy.text?.includes('We do not collect personal information.'));
    assert.equal(result.policy.url, `${url}privacy.html`);
    assert.ok(result.requests.some((r) => r.url.endsWith('/slow.png')));
    assert.deepEqual([...(await readFile(join(root, 'pre.png'))).subarray(0, 4)], [137, 80, 78, 71]);
    const finding = await verifyFinding({ type: 'missing_privacy_policy', key: 'missing_privacy_policy', subject: 'policy', evidence: [] } as unknown as Finding, url, brain, undefined, false);
    assert.equal(finding.status, 'rejected');
    assert.ok(pendingMedia >= 3); // Scanner, policy reader, and independent verifier.
  } finally {
    bus.off('event', onEvent);
    await closeBrowser();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});


test('evidence capture reveals scroll-hidden fixed headers and restores the previous scroll', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clueso-crop-'));
  const ctx = await (await getBrowser()).newContext({ viewport: { width: 800, height: 600 } });
  try {
    const page = await ctx.newPage();
    await page.setContent(`<style>body{margin:0;height:3000px;background:white}header{position:fixed;top:0;left:0;width:120px;height:40px}svg{display:block}</style>
      <header><svg width="120" height="40"><rect width="120" height="40" fill="black"/><circle cx="30" cy="20" r="10" fill="white"/></svg></header>
      <script>addEventListener('scroll',()=>document.querySelector('header').style.opacity=scrollY>80?'0':'1')</script>`);
    const header = page.locator('header');
    const baseline = await header.screenshot();
    await page.evaluate(() => scrollTo(0, 2000));
    await page.waitForFunction(() => getComputedStyle(document.querySelector('header')!).opacity === '0');
    await captureEvidence(page, header, join(root, 'header.png'));
    assert.deepEqual(await readFile(join(root, 'header.png')), baseline);
    assert.equal(await page.evaluate(() => scrollY), 2000);
  } finally {
    await ctx.close();
    await closeBrowser();
    await rm(root, { recursive: true, force: true });
  }
});


test('lazy store badges are decoded before inspection probes measure their artwork', { timeout: 25_000 }, async () => {
  const server = createServer((request, response) => {
    if (request.url?.endsWith('/badge.svg')) {
      response.writeHead(200, { 'content-type': 'image/svg+xml' });
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="black"/></svg>');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<!doctype html><body><h1>Lazy artwork</h1><div style="height:6000px"></div>
      <a href="https://apps.apple.com/app/example"><img loading="lazy" alt="Download on the App Store" width="120" height="40" src="/fixtures/app-y/badge.svg"></a></body>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  registerFixtureOrigin(base);
  const root = await mkdtemp(join(tmpdir(), 'clueso-lazy-badge-'));
  try {
    const result = await scan(`${base}/fixtures/app-y/`, loadBrain('v0'), root);
    assert.ok(result.storeLinks[0].shot);
    const badge = result.assets.find((a) => a.imageUrl.endsWith('/badge.svg'));
    assert.ok(badge, 'the lazy badge must be available to the probes');
    assert.equal(badge.naturalW, 120);
    assert.equal(badge.naturalH, 40);
    assert.ok(badge.shot);
    assert.ok(badge.contextShot);
    assert.ok(badge.bounds && badge.bounds.x>=0 && badge.bounds.y>=0);
    assert.ok(badge.bounds.y<badge.bounds.viewportHeight);
    assert.deepEqual([...(await readFile(join(root,badge.contextShot))).subarray(0,4)],[137,80,78,71]);
    assert.ok(result.storeLinks[0].contextShot);
    assert.deepEqual(result.probeErrors, []);
  } finally {
    await closeBrowser();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
