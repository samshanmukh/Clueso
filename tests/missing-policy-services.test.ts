import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runChecks } from '../src/checks/checks.ts';
import { templatePrompt } from '../src/agents/fixer.ts';
import { loadBrain } from '../src/brain/store.ts';
import type { ScanResult } from '../src/scan/scanner.ts';

const brain = loadBrain('v0');
const request = (id: string, url: string, phase: 'pre' | 'post', type = 'script') => ({ id, url, host: new URL(url).host, phase, type, t: 0 });
const scan = { host: 'shop.example', requests: [
  request('r1', 'https://www.googletagmanager.com/gtag/js?id=G-TEST', 'pre'),
  request('r2', 'https://www.google-analytics.com/g/collect?v=2', 'post', 'fetch'),
  request('r3', 'https://connect.facebook.net/en_US/fbevents.js', 'post'),
  request('r4', 'https://cdn.example.net/widget.js', 'pre'),
  request('r5', 'https://shop.example/app.js', 'pre'),
], policy: { url: null, text: null }, consent: { found: false, clicked: false }, assets: [], storeLinks: [], probeErrors: [], screenshots: {} } as unknown as ScanResult;

test('a missing privacy policy names every third party that loaded, with per-service evidence', () => {
  const finding = runChecks(scan, brain).findings.find((f) => f.type === 'missing_privacy_policy');
  assert.ok(finding);
  assert.equal(finding.title, 'No privacy policy found while third parties are loaded');
  assert.equal(finding.evidence[0].kind, 'note');
  assert.equal(finding.evidence[0].summary, '4 third-party requests to 3 services: Google Analytics, Meta Pixel, example.net (unrecognized). No privacy policy link was found or it could not be read.');
  assert.match(finding.rationale, /Google Analytics, Meta Pixel and example\.net \(unrecognized\)/);

  const services = finding.evidence.filter((e) => e.kind === 'service').map((e) => e.data as any);
  assert.deepEqual(services.map((s) => [s.name, s.recognized, s.requestCount, s.beforeConsent, s.afterConsent]), [
    ['Google Analytics', true, 2, 1, 1],
    ['Meta Pixel', true, 1, 0, 1],
    ['example.net', false, 1, 1, 0],
  ]);
  const ga = services[0];
  assert.equal(ga.firedBeforeConsent, true);
  assert.ok(ga.category && ga.collects.length > 0);
  assert.deepEqual(ga.requests.map((r: any) => [r.type, r.url, r.phase]), [
    ['script', 'https://www.googletagmanager.com/gtag/js?id=G-TEST', 'pre'],
    ['fetch', 'https://www.google-analytics.com/g/collect?v=2', 'post'],
  ]);
  assert.match(ga.requests[0].summary, /^\[before consent\] script https:\/\/www\.googletagmanager\.com/);
  assert.deepEqual(services[2].hosts, ['cdn.example.net']);
  assert.deepEqual(services[2].urls, ['https://cdn.example.net/widget.js']);
  assert.ok(!services.some((s) => s.name === 'shop.example'), 'first-party requests are not third parties');
});

test('the missing-policy fix prompt lists the services the policy must disclose', () => {
  const finding = runChecks(scan, brain).findings.find((f) => f.type === 'missing_privacy_policy')!;
  const prompt = templatePrompt(finding, brain);
  assert.match(prompt, /Services the policy must disclose:/);
  assert.match(prompt, /- Google Analytics \(/);
  assert.match(prompt, /- Meta Pixel \(/);
  assert.match(prompt, /- example\.net \(unrecognized/);
  for (const name of ['Google Analytics', 'Meta Pixel', 'example.net']) assert.match(prompt, new RegExp(`\\[ \\] The policy names ${name.replace('.', '\\.')}`));
});
