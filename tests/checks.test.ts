import assert from 'node:assert/strict';
import { test } from 'node:test';
import { brandForAsset, isQrAsset, assetsForStoreLink, measureAsset, runChecks } from '../src/checks/checks.ts';
import { loadBrain } from '../src/brain/store.ts';
import type { AssetInstance, StoreLink, ScanResult } from '../src/scan/scanner.ts';

import { cloudflareWebAnalytics } from '../src/brain/reviewed-vendors.ts';

const brain = loadBrain('v0');
const asset = (values: Partial<AssetInstance>): AssetInstance => ({ probe: 'img', technique: 'img', selector: 'a > img', href: null,
  imageUrl: 'https://example.com/image.png', naturalW: 120, naturalH: 40, drawnW: 120, drawnH: 40, ...values });

test('App Store screenshot folders do not establish badge identity', () => {
  assert.equal(brandForAsset(asset({ imageUrl: 'https://example.com/app-preview/app-store/04-choose-tone.webp', label: 'A tone for every kind of moment',
    naturalW: 860, naturalH: 1864, drawnW: 211, drawnH: 358, transform: 'matrix(0.98, -0.17, 0.17, 0.98, 0, 0)' }), brain), null);
  const badge = asset({ imageUrl: 'https://example.com/download-on-the-app-store.svg', drawnW: 200 });
  const brand = brandForAsset(badge, brain);
  assert.ok(brand);
  assert.ok(measureAsset(badge, brand).problems.length); // Actual distorted badges stay covered.
});

test('store-linked QR codes are distinct from badge artwork and matched to their own link', () => {
  const href = 'https://apps.apple.com/app/example';
  const qr = asset({ selector: 'a#qr > img', href, imageUrl: 'https://example.com/app-store-qr.svg', label: 'Scan to download Example' });
  const badge = asset({ selector: 'a#badge > img', href, imageUrl: 'https://example.com/download-on-the-app-store.svg' });
  assert.equal(isQrAsset(qr), true);
  assert.equal(brandForAsset(qr, brain), null);
  assert.ok(brandForAsset(badge, brain));
  assert.deepEqual(assetsForStoreLink({ selector: 'a#qr' } as StoreLink, [qr, badge]), [qr]);
});


test('Cloudflare analytics is identified without inventing a consent violation, while disclosure stays checked', () => {
  const known = { ...brain, vendors: [...brain.vendors, cloudflareWebAnalytics] };
  const snapshot = { host: 'example.com', requests: [{ id: 'r1', url: 'https://static.cloudflareinsights.com/beacon.min.js', host: 'static.cloudflareinsights.com', phase: 'pre', type: 'script', t: 0 }],
    policy: { url: 'https://example.com/privacy', text: 'We use a payment provider.' }, consent: { found: false, clicked: false },
    assets: [], storeLinks: [], probeErrors: [], screenshots: {} } as unknown as ScanResult;
  const result = runChecks(snapshot, known);
  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(result.findings.map((f) => f.key), ['undisclosed_vendor:cloudflare-web-analytics']);
  assert.ok(result.findings[0].evidence.some((e) => e.summary.includes('does not establish a consent violation')));
  assert.deepEqual(runChecks({ ...snapshot, policy: { ...snapshot.policy, text: 'We use Cloudflare Web Analytics for performance metrics.' } }, known).findings, []);
});


test('brand layout measurements remain review leads with official provenance, never confirmed findings', () => {
  const measured = asset({selector:'#badge',href:'https://apps.apple.com/app/example',drawnH:30});
  const layout={selector:measured.selector,asset:measured,brand:'apple-app-store-badge',measuredHeight:30,minimumHeight:40,standardClearSpace:7.5,limitedClearSpace:3,nearestGap:2,neighbor:'Next label',spacingSupported:true,reasons:['Review measured size and spacing against the placement context.'],source:'https://developer.apple.com/app-store/marketing/guidelines/',status:'measured_review'};
  const scan={host:'example.com',requests:[],policy:{url:null,text:''},consent:{found:false,clicked:false},assets:[],storeLinks:[],probeErrors:[],screenshots:{},layouts:[layout]} as unknown as ScanResult;
  const result=runChecks(scan,brain);
  assert.deepEqual(result.findings,[]);
  assert.equal(result.unresolved.length,1);
  assert.equal(result.unresolved[0].type,'brand_layout_review');
  assert.equal((result.unresolved[0].data as typeof layout).source,layout.source);
  assert.equal((result.unresolved[0].data as typeof layout).asset.selector,'#badge');
});
