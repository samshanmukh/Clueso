import fs from 'node:fs';
import path from 'node:path';
import { loadBrain, type BrainVersion } from '../brain/store.ts';
import { runChecks, type Finding, type Unresolved } from '../checks/checks.ts';
import { scan, type ScanResult } from '../scan/scanner.ts';
import { investigate } from './investigator.ts';
import { verifyFinding } from './verifier.ts';
import { writeRepairPrompt, templatePrompt } from './fixer.ts';
import { emit } from '../events.ts';
import { config } from '../settings.ts';
import { usage, llmAvailable } from '../llm.ts';
import { auditVisuals, type BrandAssessment } from './vision.ts';

export interface AuditReport {
  job: string; url: string; brainVersion: string; startedAt: string; ms: number;
  state: 'completed' | 'completed_with_unknowns' | 'failed';
  verdict: string; investigatorSummary: string;
  findings: Finding[]; rejected: Finding[]; unresolved: Unresolved[];
  scan: Pick<ScanResult, 'consent' | 'policy' | 'screenshots' | 'stubbedThirdParties'> & { requests: number; assets: number; locations?: {selector:string; bounds?: import('../scan/scanner.ts').AssetInstance['bounds']; contextShot?:string}[] };
  llm: { enabled: boolean; calls: number; tokens: number };
  visual?: BrandAssessment[];
}

export interface AuditOpts { version?: string; brain?: BrainVersion; job?: string; useLlm?: boolean; verify?: boolean; prompts?: boolean }

export async function runAudit(url: string, o: AuditOpts = {}): Promise<AuditReport> {
  const t0 = Date.now();
  const job = o.job ?? `job-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const brain = o.brain ?? loadBrain(o.version); // pinned snapshot for the whole audit
  const useLlm = (o.useLlm ?? true) && llmAvailable();
  const dir = path.join(config.dataDir, 'runs', job);
  const calls0 = usage.calls, tok0 = usage.prompt + usage.completion;
  emit('controller', 'info', `Audit ${job} started on ${url} with shared brain ${brain.version} (model ${useLlm ? 'on' : 'off'})`, { job, url, brain: brain.version }, job);

  const s = await scan(url, brain, dir, job);
  const { findings: candidates, unresolved } = runChecks(s, brain);
  const visual = useLlm ? await auditVisuals(s, brain, candidates, job) : { assessments: [], unresolved: [] };
  unresolved.push(...visual.unresolved);
  emit('controller', 'step', `Checks: ${candidates.length} candidate finding(s), ${unresolved.length} unresolved`, undefined, job);
  for (const u of unresolved) emit('controller', 'warn', `Unresolved: ${u.summary}`, undefined, job);

  let summary = '';
  if (useLlm) {
    try {
      const inv = await investigate(s, brain, candidates, unresolved, job);
      summary = inv.summary;
      candidates.push(...inv.proposed);
      for (const c of inv.concerns) { const f = candidates.find((x) => x.id === c.findingId); if (f) f.evidence.push({ kind: 'note', summary: `Investigator concern: ${c.concern}` }); }
    } catch (e: any) { emit('investigator', 'error', `Investigator failed: ${e?.message ?? e}`, undefined, job); }
  }

  const verified: Finding[] = [];
  if (o.verify ?? true) {
    emit('verifier', 'step', `Independently reproducing ${candidates.length} candidate(s) in fresh browser contexts`, undefined, job);
    for (const f of candidates) verified.push(await verifyFinding(f, url, brain, job, useLlm));
  } else verified.push(...candidates.map((f) => ({ ...f, status: 'confirmed' as const })));

  const confirmed = verified.filter((f) => f.status === 'confirmed');
  const rejected = verified.filter((f) => f.status === 'rejected');
  const unsure = verified.filter((f) => f.status === 'unresolved');
  if (o.prompts ?? true) {
    for (const f of confirmed) {
      f.repairPrompt = useLlm ? await writeRepairPrompt(f, brain, job) : templatePrompt(f, brain);
      emit('fixer', 'step', `Repair prompt ready: ${f.title}`, undefined, job);
    }
  }
  const allUnresolved = [...unresolved, ...unsure.map((f) => ({ id: f.id, type: 'probe_error' as const, subject: f.subject, summary: `Could not verify: ${f.title} — ${f.verification?.notes.join('; ')}`, data: null }))];
  const state = allUnresolved.length ? 'completed_with_unknowns' : 'completed';
  const verdict = confirmed.length
    ? `${confirmed.length} confirmed issue(s) to fix before launch${allUnresolved.length ? `; ${allUnresolved.length} item(s) could not be decided` : ''}.`
    : allUnresolved.length ? `No confirmed issues, but ${allUnresolved.length} item(s) could not be decided — not a clean bill of health.`
    : 'No issues found within the audited scope (trackers & consent, policy disclosure, store badges).';

  const report: AuditReport = {
    job, url, brainVersion: brain.version, startedAt: new Date(t0).toISOString(), ms: Date.now() - t0, state, verdict,
    investigatorSummary: summary, findings: confirmed, rejected, unresolved: allUnresolved, visual: visual.assessments,
    scan: { consent: s.consent, policy: { url: s.policy.url, text: s.policy.text ? s.policy.text.slice(0, 2000) : null }, screenshots: s.screenshots, stubbedThirdParties: s.stubbedThirdParties, requests: s.requests.length, assets: s.assets.length, locations: [...s.assets,...s.storeLinks].filter(item=>item.contextShot).map(item=>({selector:item.selector,bounds:item.bounds,contextShot:item.contextShot})) },
    llm: { enabled: useLlm, calls: usage.calls - calls0, tokens: usage.prompt + usage.completion - tok0 },
  };
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  emit('controller', 'done', `Done in ${(report.ms / 1000).toFixed(1)}s — ${verdict}`, { job, report: `runs/${job}/report.json` }, job);
  return report;
}
