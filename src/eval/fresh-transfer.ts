import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { config } from '../settings.ts';
import { loadBrain } from '../brain/store.ts';
import { startFixtureServer } from '../fixtures/server.ts';
import { closeBrowser } from '../scan/scanner.ts';
import { runAudit } from '../agents/controller.ts';

/** Generates evaluation-only apps AFTER loading/fingerprinting the frozen candidate. Never used by the learner. */
export async function evaluateFreshTransfer(from = 'v0', to?: string) {
  const before = loadBrain(from), after = loadBrain(to);
  const frozenAt = new Date().toISOString();
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(after)).digest('hex');
  const seed = crypto.randomBytes(8).toString('hex');
  const root = path.join(config.dataDir, 'fresh-holdout', seed);
  const art = await fs.readFile(path.join(config.fixturesDir, 'shared/app-store.svg'));
  const specs = [
    { app: 'app-e', title: 'Field Notes', tag: 'em', width: 193 + parseInt(seed.slice(0,2),16) % 40, height: 31 + parseInt(seed.slice(2,4),16) % 9, size: '100% 100%', expected: ['badge_misuse:apple-app-store-badge'] },
    { app: 'app-f', title: 'Quiet Maps', tag: 'strong', width: 277 + parseInt(seed.slice(4,6),16) % 40, height: 63 + parseInt(seed.slice(6,8),16) % 12, size: 'contain', expected: [] },
  ];
  const fixturesCreatedAt = new Date().toISOString();
  for (const s of specs) {
    await fs.mkdir(path.join(root, s.app), { recursive: true });
    await fs.writeFile(path.join(root, s.app, 'badge.svg'), art);
    await fs.writeFile(path.join(root, s.app, 'privacy.html'), '<h1>Privacy</h1><p>No third-party services are loaded.</p>');
    await fs.writeFile(path.join(root, s.app, 'index.html'), `<!doctype html><html lang="en"><title>${s.title}</title><body style="font-family:system-ui;padding:40px"><main><h1>${s.title}</h1><p>A private place for your next adventure.</p><article data-layout="${seed}"><nav><a href="https://apps.apple.com/app/${seed}" aria-label="Download ${s.title}"><aside><${s.tag} class="art-${seed}" style="display:block;box-sizing:content-box;width:${s.width}px;height:${s.height}px;padding:13px;border:3px solid transparent;background-origin:content-box;background-image:url(badge.svg);background-size:${s.size};background-repeat:no-repeat"></${s.tag}></aside></a></nav></article></main><footer><a href="privacy.html">Privacy</a></footer></body></html>`);
  }
  const server = await startFixtureServer(0, root);
  try {
    const results = [];
    for (const brain of [before, after]) {
      for (const spec of specs) {
        const report = await runAudit(`${server.base}/${spec.app}/`, { brain, useLlm: false, prompts: false, job: `fresh-${seed}-${brain.version}-${spec.app}` });
        const found = report.findings.map((f) => f.key);
        results.push({ version: brain.version, app: spec.app, expected: spec.expected, found,
          missed: spec.expected.filter((k) => !found.includes(k)), falseFindings: found.filter((k) => !spec.expected.includes(k)),
          modelCalls: report.llm.calls, evidence: report.findings.flatMap((f) => f.evidence.filter((e) => e.kind === 'asset').map((e) => e.data)), reportJob: report.job });
      }
    }
    const learnedIds = after.probes.filter((p) => !before.probes.some((b) => b.id === p.id)).map((p) => p.id);
    const unchanged = crypto.createHash('sha256').update(JSON.stringify(loadBrain(after.version))).digest('hex') === fingerprint;
    const result = { frozenAt, fingerprint, fixturesCreatedAt, seed, from: before.version, to: after.version, learnedIds,
      scope: 'Two generated synthetic sites with stand-in artwork; candidate frozen before site generation. Development contract cases are separate.', results,
      unchanged,
      transferred: unchanged && results.some((r) => r.version === before.version && r.app === 'app-e' && r.missed.length > 0) && results.some((r) => r.version === after.version && r.app === 'app-e' && r.missed.length === 0 && r.evidence.some((a: any) => learnedIds.includes(a.probe))) && results.filter((r) => r.version === after.version).every((r) => r.falseFindings.length === 0) };
    await fs.writeFile(path.join(config.dataDir, 'fresh-transfer.json'), JSON.stringify(result, null, 2));
    return result;
  } finally { server.close(); await closeBrowser(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  evaluateFreshTransfer(process.argv[2] ?? 'v0', process.argv[3]).then((r) => {
    console.log(JSON.stringify(r, null, 2)); if (!r.transferred) process.exitCode = 1;
  }).catch(async (e) => { console.error(e.message); await closeBrowser(); process.exitCode = 1; });
}
