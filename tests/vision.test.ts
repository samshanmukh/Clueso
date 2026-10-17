import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = mkdtempSync(path.join(os.tmpdir(), 'lp-vision-test-'));
process.env.LP_DATA_DIR = root;
process.env.LLM_MODE = 'live';
process.env.CRUSOE_INTELLIGENCE_API_KEY = 'vision-test-key';
process.env.YOU_API_KEY = 'search-test-key';
const { config } = await import('../src/settings.ts');
const { linkedAssets, resolveOfficialReference } = await import('../src/brand/references.ts');
const { compareBadge, pngPart, auditVisuals } = await import('../src/agents/vision.ts');
const { closeBrowser } = await import('../src/scan/scanner.ts');
const { testProbeContract } = await import('../src/eval/probe-contract.ts');
const { vendorPolicyNames } = await import('../src/brain/store.ts');
const { setQuiet } = await import('../src/events.ts');
setQuiet(true);
after(async () => { await closeBrowser(); await fs.rm(root, { recursive: true, force: true }); });
const response = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });

test('official discovery requires an image link on an approved page/host', () => {
  assert.deepEqual(linkedAssets('<img src="https://evil.example/badge.png"><img src="/assets/badge.svg"><img src="javascript:bad.png">', 'https://developer.apple.com/guidelines/', ['developer.apple.com']), ['https://developer.apple.com/assets/badge.svg']);
});

test('official references use You.com, preserve provenance, and vision sends a single labeled image', async () => {
  const original = globalThis.fetch;
  const asset = 'https://developer.apple.com/assets/elements/badges/download-on-the-app-store.svg';
  let inferenceCalls = 0;
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/search')) {
        assert.equal((init?.headers as Record<string,string>)['X-API-Key'], 'search-test-key');
        return response({ results: { web: [{ url: 'https://developer.apple.com/app-store/marketing/guidelines/', title: 'Official', snippets: ['Use original artwork'] }] } });
      }
      if (url.endsWith('/contents')) return response([{ url: 'https://developer.apple.com/app-store/marketing/guidelines/', markdown: 'Use original artwork without modification.' }]);
      if (url.endsWith('/models')) return response({ data: [{ id: config.visionModel, tags: ['image text to text'] }] });
      if (url.endsWith('/chat/completions')) {
        inferenceCalls++;
        const request = JSON.parse(String(init?.body));
        assert.equal(request.model, config.visionModel);
        assert.equal((init?.headers as Record<string,string>).Authorization, 'Bearer vision-test-key');
        const parts = request.messages[1].content;
        assert.equal(parts.filter((p: any) => p.type === 'image_url').length, 1);
        assert.match(parts.find((p: any) => p.type === 'image_url').image_url.url, /^data:image\/png;base64,/);
        return response({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ verdict: 'suspected_difference', differences: ['Artwork differs'], confidence: 0.8 }) } }] });
      }
      if (url === asset) return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="black"/></svg>', { headers: { 'content-type': 'image/svg+xml' } });
      if (url.startsWith('https://developer.apple.com/app-store/')) return new Response(`<html><img src="${asset}"></html>`, { headers: { 'content-type': 'text/html' } });
      throw new Error('Unexpected request: ' + url);
    };
    const ref = await resolveOfficialReference('apple-app-store-badge');
    assert.equal(ref.provenance, 'linked_from_official_page');
    assert.equal(ref.referenceKind, 'downloadable_artwork');
    assert.equal(ref.assetUrl, asset);
    assert.match(ref.sha256, /^[a-f0-9]{64}$/);
    assert.equal(ref.width, 120);
    const verdict = await compareBadge(ref.imagePath, ref.imagePath, ref.imagePath, 'Apple', 'Use unmodified art');
    assert.equal(verdict.verdict, 'suspected_difference');
    assert.equal(inferenceCalls, 1);
    // Vision leads stay unresolved and never become asserted facts in a repair prompt.
    const scan = { url: 'https://example.com', artifactsDir: root, screenshots: { pre: path.basename(ref.imagePath) },
      storeLinks: [{ host: 'apps.apple.com', href: 'https://apps.apple.com/app/x', selector: 'a', shot: 'actual.png' }], assets: [{ selector: 'a > img', href: 'https://apps.apple.com/app/x', imageUrl: asset }] };
    await fs.copyFile(ref.imagePath, path.join(root, 'actual.png'));
    await fs.copyFile(ref.imagePath, path.join(root, path.basename(ref.imagePath)));
    const finding = { type: 'badge_misuse', subject: 'apple-app-store-badge', evidence: [] };
    const result = await auditVisuals(scan as any, { brands: [{ id: 'apple-app-store-badge', name: 'Apple', linkHosts: ['apps.apple.com'] }] } as any, [finding as any]);
    assert.equal(result.assessments[0].status, 'compared');
    assert.equal(result.assessments[0].sourceCheck?.status, 'exact_official_bytes');
    assert.equal(result.unresolved[0].type, 'visual_review');
    assert.ok(!JSON.stringify(finding.evidence).includes('Artwork differs'));
  } finally { globalThis.fetch = original; }
});

test('vision rejects non-image bytes before sending a request', async () => {
  const file = path.join(root, 'bad.png'); await fs.writeFile(file, 'not an image');
  await assert.rejects(() => pngPart(file), /must be a PNG/);
});

test('measurement contract rejects a checker that skips descendant elements', async () => {
  const failures = await testProbeContract({ id: 'empty', name: 'Empty', description: '', addedBy: 'test', code: 'return [];' });
  assert.equal(failures.length, 9);
  assert.ok(failures.some((f) => f.includes('nested span')));
});

test('generic analytics language cannot count as naming a learned vendor', () => {
  assert.deepEqual(vendorPolicyNames({ name: 'Hotjar', policyKeywords: ['hotjar', 'analytics', 'session replay', 'heatmaps', 'contentsquare'] } as any), ['hotjar','contentsquare']);
});
