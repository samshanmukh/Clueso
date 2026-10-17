import fs from 'node:fs';
import path from 'node:path';
import { config } from '../settings.ts';
import { emit } from '../events.ts';
import { loadBrain, loadRegistry } from '../brain/store.ts';
import { fullEval, loadLabels, type Metrics } from './score.ts';

export interface TransferReport { at: string; split: 'heldout'; apps: string[]; before: { version: string; metrics: Metrics }; after: { version: string; metrics: Metrics }; llm: boolean }

/** Frozen before/after comparison on held-out apps the learner never saw. Same model, same budgets. */
export async function runTransfer(base: string, from = 'v0', to?: string, useLlm = true): Promise<TransferReport> {
  const apps = loadLabels().splits.heldout;
  const toV = to ?? loadRegistry().active;
  emit('eval', 'info', `Transfer eval on held-out apps ${apps.join(', ')}: ${from} vs ${toV}`);
  const before = await fullEval(loadBrain(from), apps, base, useLlm);
  const after = await fullEval(loadBrain(toV), apps, base, useLlm);
  const rep: TransferReport = { at: new Date().toISOString(), split: 'heldout', apps, before: { version: from, metrics: before }, after: { version: toV, metrics: after }, llm: useLlm };
  fs.mkdirSync(path.join(config.dataDir, 'eval'), { recursive: true });
  fs.writeFileSync(path.join(config.dataDir, 'eval', 'latest.json'), JSON.stringify(rep, null, 2));
  emit('eval', 'done', `${from}: recall ${pct(before.recall)}, precision ${pct(before.precision)}, unresolved ${before.unresolved}  →  ${toV}: recall ${pct(after.recall)}, precision ${pct(after.precision)}, unresolved ${after.unresolved}`, rep);
  return rep;
}
export const pct = (x: number) => `${Math.round(x * 100)}%`;

export function printTransfer(r: TransferReport) {
  const row = (label: string, a: string | number, b: string | number) => console.log(`  ${label.padEnd(26)} ${String(a).padStart(10)} ${String(b).padStart(10)}`);
  console.log(`\nHeld-out apps (never used for learning): ${r.apps.join(', ')}`);
  row('', r.before.version, r.after.version);
  const B = r.before.metrics, A = r.after.metrics;
  row('Real issues found', `${B.tp}/${B.tp + B.fn}`, `${A.tp}/${A.tp + A.fn}`);
  row('Recall', pct(B.recall), pct(A.recall));
  row('False findings', B.fp, A.fp);
  row('Precision', pct(B.precision), pct(A.precision));
  row('Unresolved items', B.unresolved, A.unresolved);
  row('Audit time (s)', (B.ms / 1000).toFixed(1), (A.ms / 1000).toFixed(1));
  if (r.llm) row('Model calls / tokens', `${B.llmCalls}/${B.tokens}`, `${A.llmCalls}/${A.tokens}`);
  for (const a of A.apps) { const b = B.apps.find((x) => x.app === a.app)!; console.log(`  ${a.app}: ${b.tp.length}→${a.tp.length} found; newly found: ${a.tp.filter((k) => !b.tp.includes(k)).join(', ') || '—'}; missed: ${a.fn.join(', ') || '—'}; false: ${a.fp.join(', ') || '—'}`); }
}
