// Offline end-to-end self-test. Uses SCRIPTED model + search responses (no network) to exercise
// every code path: audit, verifier, investigator tool loop, learner, promotion gate (incl. a
// rejection), and the held-out transfer eval. Live runs use Crusoe + You.com instead.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'clueso-selftest-'));
process.env.LLM_MODE = 'mock';
process.env.LP_DATA_DIR = path.join(sandbox, 'data');
process.env.LP_BRAIN_DIR = path.join(sandbox, 'brain');
fs.mkdirSync(path.join(process.env.LP_BRAIN_DIR, 'versions'), { recursive: true });
fs.copyFileSync(path.resolve('brain/versions/v0.json'), path.join(process.env.LP_BRAIN_DIR, 'versions/v0.json'));
fs.writeFileSync(path.join(process.env.LP_BRAIN_DIR, 'registry.json'), JSON.stringify({ active: 'v0', versions: ['v0'], decisions: [] }));

const { setMock } = await import('./llm.ts');
const { setSearchMock } = await import('./learn/research.ts');
const { setQuiet } = await import('./events.ts');
const { startFixtureServer } = await import('./fixtures/server.ts');
const { closeBrowser } = await import('./scan/scanner.ts');
const { resetBrain, loadRegistry } = await import('./brain/store.ts');
const { runAudit } = await import('./agents/controller.ts');
const { learnCycle } = await import('./learn/learner.ts');
const { runTransfer, printTransfer } = await import('./eval/transfer.ts');
const { loadLabels } = await import('./eval/score.ts');

const NAIVE_PROBE = `const out = [];
for (const el of document.querySelectorAll('body *')) {
  if (el.tagName === 'IMG') continue;
  const cs = getComputedStyle(el); const url = __lp.cssUrl(cs.backgroundImage); if (!url) continue;
  const r = el.getBoundingClientRect(); if (r.width < 4 || r.height < 4) continue;
  const nat = await __lp.naturalSize(url); if (!nat) continue;
  out.push({ technique: 'css-background', selector: __lp.path(el), href: __lp.linkOf(el), imageUrl: url, naturalW: nat.w, naturalH: nat.h, drawnW: r.width, drawnH: r.height, filter: cs.filter, transform: cs.transform });
}
return out;`;

const GOOD_PROBE = `const out = [];
const px = (cs, k) => parseFloat(cs[k]) || 0;
for (const el of document.querySelectorAll('body *')) {
  if (el.tagName === 'IMG') continue;
  const cs = getComputedStyle(el); const url = __lp.cssUrl(cs.backgroundImage); if (!url) continue;
  const r = el.getBoundingClientRect(); if (r.width < 4 || r.height < 4) continue;
  const nat = await __lp.naturalSize(url); if (!nat || !nat.w || !nat.h) continue;
  let areaW = r.width - px(cs, 'borderLeftWidth') - px(cs, 'borderRightWidth');
  let areaH = r.height - px(cs, 'borderTopWidth') - px(cs, 'borderBottomWidth');
  if (cs.backgroundOrigin === 'content-box') { areaW -= px(cs, 'paddingLeft') + px(cs, 'paddingRight'); areaH -= px(cs, 'paddingTop') + px(cs, 'paddingBottom'); }
  const size = cs.backgroundSize.split(',')[0].trim();
  const len = (v, ref) => v.endsWith('%') ? parseFloat(v) / 100 * ref : parseFloat(v);
  let dW, dH;
  if (size === 'contain' || size === 'cover') {
    const s = size === 'contain' ? Math.min(areaW / nat.w, areaH / nat.h) : Math.max(areaW / nat.w, areaH / nat.h);
    dW = nat.w * s; dH = nat.h * s;
  } else {
    const [a, b = 'auto'] = size.split(/\\s+/);
    if (a === 'auto' && b === 'auto') { dW = nat.w; dH = nat.h; }
    else if (b === 'auto') { dW = len(a, areaW); dH = dW * nat.h / nat.w; }
    else if (a === 'auto') { dH = len(b, areaH); dW = dH * nat.w / nat.h; }
    else { dW = len(a, areaW); dH = len(b, areaH); }
  }
  out.push({ technique: 'css-background', selector: __lp.path(el), href: __lp.linkOf(el), imageUrl: url, naturalW: nat.w, naturalH: nat.h,
    drawnW: dW, drawnH: dH, boxW: areaW, boxH: areaH, filter: cs.filter, transform: cs.transform, label: el.getAttribute('aria-label') || '' });
}
return out;`;

let probeAttempts = 0;
const reply = (content: string, toolCalls: any[] = []) => ({ content, toolCalls, usage: { prompt: 100, completion: 50 }, ms: 1 });
setMock((o) => {
  const sys = String(o.messages[0]?.content ?? '');
  if (o.role === 'investigator') {
    const n = o.messages.filter((m) => m.role === 'tool').length;
    return n === 0 ? reply('', [{ id: 'c1', type: 'function', function: { name: 'list_third_parties', arguments: '{}' } }])
      : reply('', [{ id: 'c2', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ summary: 'Scripted investigator summary (self-test).' }) } }]);
  }
  if (o.role === 'verifier') return reply('{"disclosed":"no","quote":"","reason":"vendor not named (scripted)"}');
  if (o.role === 'fixer') return reply(JSON.stringify({ prompt: String(o.messages[1].content).split('Draft prompt:\n')[1] }));
  if (o.role === 'learner' && sys.includes('shared knowledge base')) {
    return reply(JSON.stringify({ id: 'hotjar', name: 'Hotjar', domains: ['hotjar.com', 'hotjar.io'], category: 'session recording & heatmaps',
      collects: ['mouse movement', 'clicks', 'session recordings', 'device data'], policyKeywords: ['hotjar'], requiresConsent: true,
      sources: [{ url: 'https://www.hotjar.com/', quote: 'behavior analytics' }] }));
  }
  if (o.role === 'learner' && sys.includes('INSPECTION PROBES')) {
    probeAttempts++;
    const meta = JSON.stringify({ id: 'css-background-art', name: 'CSS background artwork', description: 'Measures images painted with background-image.' });
    return reply(`${meta}\n\`\`\`javascript\n${probeAttempts === 1 ? NAIVE_PROBE : GOOD_PROBE}\n\`\`\``);
  }
  throw new Error(`no mock for role ${o.role}`);
});
setSearchMock(() => [
  { url: 'https://www.hotjar.com/', title: 'Hotjar: Website Heatmaps & Behavior Analytics Tools', description: 'Hotjar is a product experience insights tool with behavior analytics, heatmaps and session recordings.', snippets: ['behavior analytics'] },
  { url: 'https://help.hotjar.com/', title: 'Hotjar Help Center', description: 'The Hotjar tracking code loads from static.hotjar.com and script.hotjar.com.', snippets: [] },
]);

setQuiet(!process.argv.includes('--verbose'));
const fails: string[] = [];
const expect = (ok: boolean, msg: string) => { console.log(`${ok ? '✔' : '✘'} ${msg}`); if (!ok) fails.push(msg); };

resetBrain();
const s = await startFixtureServer();
try {
  const a = await runAudit(`${s.base}/app-a/`, { version: 'v0' });
  const keys = a.findings.map((f) => f.key).sort();
  expect(keys.join() === ['badge_misuse:apple-app-store-badge', 'pre_consent_tracking:meta-pixel', 'undisclosed_vendor:mixpanel'].join(), `v0 audit of app-a confirms 3 issues (${keys.join(', ')})`);
  expect(a.unresolved.length >= 2, `v0 leaves ${a.unresolved.length} unresolved items (Hotjar, CSS badge)`);
  expect(a.findings.every((f) => (f.repairPrompt ?? '').includes('[ ]')), 'every confirmed finding has a repair prompt with acceptance checks');

  const c = await runAudit(`${s.base}/app-c/`, { version: 'v0' });
  expect(c.findings.length === 0, `clean app-c has no findings (${c.findings.map((f) => f.key).join(', ') || 'none'})`);

  const l = await learnCycle(s.base, loadLabels().splits.dev);
  const acc = l.decisions.filter((d) => d.accepted), rej = l.decisions.filter((d) => !d.accepted);
  expect(acc.some((d) => d.kind === 'vendor'), 'gate accepted the researched Hotjar vendor');
  expect(rej.some((d) => d.kind === 'probe' && /false/i.test(d.reasons.join())), 'gate REJECTED the naive probe (false finding on clean app-c)');
  expect(acc.some((d) => d.kind === 'probe'), 'gate accepted the corrected probe on retry');
  for (const d of l.decisions) console.log(`   ${d.accepted ? 'accepted' : 'rejected'} ${d.candidate}: ${d.reasons[0]}`);

  const t = await runTransfer(s.base, 'v0', loadRegistry().active, true);
  printTransfer(t);
  expect(t.after.metrics.recall > t.before.metrics.recall, `held-out recall improves ${t.before.metrics.recall.toFixed(2)} → ${t.after.metrics.recall.toFixed(2)}`);
  expect(t.after.metrics.fp === 0, 'no false findings on held-out apps after learning');
} finally { s.close(); await closeBrowser(); fs.rmSync(sandbox, { recursive: true, force: true }); }

console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASSED');
process.exit(fails.length ? 1 : 0);
export {};
