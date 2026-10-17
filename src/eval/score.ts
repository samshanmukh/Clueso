// Evaluation oracle. This is the ONLY module that reads fixtures/labels.json.
// Agents (investigator, verifier, learner) never import it.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../settings.ts';
import type { BrainVersion } from '../brain/store.ts';
import { scan } from '../scan/scanner.ts';
import { runChecks } from '../checks/checks.ts';
import { runAudit } from '../agents/controller.ts';

export interface Labels { splits: { dev: string[]; heldout: string[] }; apps: Record<string, string[]> }
export function loadLabels(): Labels { return JSON.parse(fs.readFileSync(path.join(config.fixturesDir, 'labels.json'), 'utf8')); }

export interface AppScore { app: string; expected: string[]; found: string[]; tp: string[]; fp: string[]; fn: string[]; unresolved: number; probeErrors: number; ms: number; details?: Record<string, string> }
export interface Metrics { apps: AppScore[]; tp: number; fp: number; fn: number; precision: number; recall: number; unresolved: number; probeErrors: number; ms: number; llmCalls?: number; tokens?: number }

export function summarize(apps: AppScore[]): Metrics {
  const tp = apps.reduce((s, a) => s + a.tp.length, 0), fp = apps.reduce((s, a) => s + a.fp.length, 0), fn = apps.reduce((s, a) => s + a.fn.length, 0);
  return { apps, tp, fp, fn, precision: tp + fp ? tp / (tp + fp) : 1, recall: tp + fn ? tp / (tp + fn) : 1,
    unresolved: apps.reduce((s, a) => s + a.unresolved, 0), probeErrors: apps.reduce((s, a) => s + a.probeErrors, 0), ms: apps.reduce((s, a) => s + a.ms, 0) };
}

function score(app: string, found: string[], unresolved: number, probeErrors: number, ms: number, details?: Record<string, string>): AppScore {
  const expected = loadLabels().apps[app] ?? [];
  const f = [...new Set(found)];
  return { app, expected, found: f, tp: f.filter((k) => expected.includes(k)), fp: f.filter((k) => !expected.includes(k)), fn: expected.filter((k) => !f.includes(k)), unresolved, probeErrors, ms, details };
}

/** Fast path used by the promotion gate: scan + deterministic checks under one brain snapshot. */
export async function quickEval(brain: BrainVersion, apps: string[], base: string): Promise<Metrics> {
  const out: AppScore[] = [];
  for (const app of apps) {
    const t0 = Date.now();
    const s = await scan(`${base}/${app}/`, brain, path.join(config.dataDir, 'gate', brain.version, app));
    const { findings, unresolved } = runChecks(s, brain);
    out.push(score(app, findings.map((f) => f.key), unresolved.length, s.probeErrors.length, Date.now() - t0,
      Object.fromEntries(findings.map((f) => [f.key, f.evidence.slice(0, 3).map((e) => e.summary).join(' | ')]))));
  }
  return summarize(out);
}

/** Full pipeline (checks + investigator + verifier) used for the before/after transfer report. */
export async function fullEval(brain: BrainVersion, apps: string[], base: string, useLlm: boolean): Promise<Metrics> {
  const out: AppScore[] = [];
  let calls = 0, tokens = 0;
  for (const app of apps) {
    const r = await runAudit(`${base}/${app}/`, { brain, useLlm, prompts: false, job: `eval-${brain.version}-${app}-${Date.now()}` });
    calls += r.llm.calls; tokens += r.llm.tokens;
    out.push(score(app, r.findings.map((f) => f.key), r.unresolved.length, 0, r.ms));
  }
  return { ...summarize(out), llmCalls: calls, tokens };
}
