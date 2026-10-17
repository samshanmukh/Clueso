import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { inspectPage } from '../src/tools/browser.ts';

test('real Chromium collects rendered asset transforms, stylesheet masks, focus and artifacts', async () => {
  let posts = 0;
  const server = createServer((request, response) => {
    if (request.method === 'POST') posts++;
    if (request.url === '/logo.svg') {
      response.writeHead(200, { 'content-type': 'image/svg+xml' });
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20"/></svg>');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<!doctype html><html><head><title>Clueso integration fixture</title>
      <style>.wrapper{transform:scaleX(1.5);width:50px}.mask{width:24px;height:24px;mask-image:url('/logo.svg');background:red}</style></head>
      <body><a id="home" href="/home" aria-label="Home">Home</a><div class="wrapper"><img id="logo" src="/logo.svg" alt="Fixture logo" width="20" height="20"></div>
      <div class="mask"></div><button id="action">Action</button>
      <script>fetch('/submit',{method:'POST',body:'should-not-send'}).catch(()=>{});</script></body></html>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const root = await mkdtemp(join(tmpdir(), 'clueso-browser-'));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const result = await inspectPage(url, { artifactRoot: root, allowLocalhost: true });
    assert.equal(result.title, 'Clueso integration fixture');
    const logo = result.assets.find((asset) => asset.selector === '#logo');
    assert.ok(logo);
    assert.equal(logo.naturalSize?.width, 20);
    assert.ok(logo.ancestors.some((ancestor) => ancestor.styles.transform.includes('1.5')));
    assert.ok(result.styledAssets.some((asset) => asset.styles.maskImage.includes('logo.svg')));
    assert.ok(result.keyboardTrace.some((focus) => focus.id === 'home'));
    assert.ok(result.links.some((link) => link.ariaLabel === 'Home'));
    assert.equal(posts, 0);
    assert.ok(result.blockedOrigins.includes(url));
    const screenshot = await readFile(result.screenshotPath);
    assert.deepEqual([...screenshot.subarray(0, 4)], [137, 80, 78, 71]);
    assert.equal(JSON.parse(await readFile(result.evidencePath, 'utf8')).status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
