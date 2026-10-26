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
import type { SiteRole, WorkProgress } from '../ui/site-progress.ts';

export interface CandidateAudit {job:string;parent:string;scope:string}
export interface AuditReport {
  learningCandidate?:CandidateAudit;
  job: string; url: string; brainVersion: string; startedAt: string; ms: number;
  state: 'completed' | 'completed_with_unknowns' | 'failed';
  verdict: string; investigatorSummary: string; investigatorSummaryOriginal?:string;
  findings: Finding[]; rejected: Finding[]; unresolved: Unresolved[];
  scan: Pick<ScanResult, 'consent' | 'policy' | 'screenshots' | 'stubbedThirdParties' | 'storeLinkObservations'> & { requests: number; assets: number; locations?: {selector:string; bounds?: import('../scan/scanner.ts').AssetInstance['bounds']; contextShot?:string}[] };
  llm: { enabled: boolean; calls: number; tokens: number };
  visual?: BrandAssessment[];
  roleWork?: Partial<Record<SiteRole,WorkProgress>>;
}

export interface AuditOpts { learningCandidate?:CandidateAudit; version?: string; brain?: BrainVersion; job?: string; useLlm?: boolean; verify?: boolean; prompts?: boolean }

export function deferExperimentalVendorFinding(finding:Finding,experimentalVendorIds:Set<string>):Finding{
  if(finding.status!=='confirmed'||!experimentalVendorIds.has(finding.subject))return finding;
  return {...finding,status:'unresolved',verification:{status:'unresolved',method:finding.verification?.method??'Candidate rule check',notes:[...(finding.verification?.notes??[]),'The browser observation was rechecked, but this vendor rule is experimental. Consent and disclosure conclusions still need rule review.']}};
}

export async function runAudit(url: string, o: AuditOpts = {}): Promise<AuditReport> {
  const t0 = Date.now();
  const job = o.job ?? `job-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const brain = o.brain ?? loadBrain(o.version); // pinned snapshot for the whole audit
  const reviewed=o.learningCandidate?loadBrain(o.learningCandidate.parent):brain;
  const experimentalVendorIds=new Set(brain.vendors.filter(v=>!reviewed.vendors.some(prior=>prior.id===v.id)).map(v=>v.id));
  const useLlm = (o.useLlm ?? true) && llmAvailable();
  const dir = path.join(config.dataDir, 'runs', job);
  const calls0 = usage.calls, tok0 = usage.prompt + usage.completion;
  emit('controller', 'info', `Audit ${job} started on ${url} with shared brain ${brain.version} (model ${useLlm ? 'on' : 'off'})`, { job, url, brain: brain.version }, job);

  const roleWork: Partial<Record<SiteRole,WorkProgress>> = {};
  const progress=(role:SiteRole,completed:number,total:number,state:WorkProgress['state'],detail:string)=>{
    const value={completed,total,state,detail};roleWork[role]=value;
    emit(role,'step',detail,{workProgress:{url,...value}},job);
  };
  progress('learner',0,0,'skipped','Learning runs separately from an inspection.');
  progress('scanner',0,4,'running','Opening the site.');
  const s = await scan(url, brain, dir, job);
  progress('scanner',4,4,'completed','Page capture, probes, consent review and policy review finished.');
  const { findings: candidates, unresolved } = runChecks(s, brain);
  progress('vision',0,useLlm&&config.visionEnabled?1:0,useLlm&&config.visionEnabled?'running':'skipped','Comparing available brand artwork.');
  const visual = useLlm ? await auditVisuals(s, brain, candidates, job) : { assessments: [], unresolved: [] };
  progress('vision',visual.assessments.length,visual.assessments.length,visual.assessments.length?'completed':'skipped',visual.assessments.length?`${visual.assessments.length} visual comparison attempts finished; ${visual.assessments.filter(a=>a.status==='unavailable').length} unavailable.`:'No visual comparison tasks were available.');
  unresolved.push(...visual.unresolved);
  emit('controller', 'step', `Checks: ${candidates.length} candidate finding(s), ${unresolved.length} unresolved`, undefined, job);
  for (const u of unresolved) emit('controller', 'warn', `Unresolved: ${u.summary}`, undefined, job);

  let summary = '',originalSummary:string|undefined;
  progress('investigator',0,useLlm?1:0,useLlm?'running':'skipped',useLlm?'Reviewing scan and candidate findings.':'Model investigation is disabled.');
  if (useLlm) {
    try {
      const inv = await investigate(s, brain, candidates, unresolved, job);
      summary = inv.summary;originalSummary=inv.originalSummary;
      progress('investigator',1,1,'completed','Investigation finished.');
      candidates.push(...inv.proposed);
      for (const c of inv.concerns) { const f = candidates.find((x) => x.id === c.findingId); if (f) f.evidence.push({ kind: 'note', summary: `Investigator concern: ${c.concern}` }); }
    } catch (e: any) { progress('investigator',0,1,'failed','Investigation stopped before completion.');emit('investigator', 'error', `Investigator failed: ${e?.message ?? e}`, undefined, job); }
  }

  const verified: Finding[] = [];
  progress('verifier',0,(o.verify??true)?candidates.length:0,(o.verify??true)&&candidates.length?'running':'skipped',(o.verify??true)?`${candidates.length} candidate rechecks planned.`:'Independent verification was disabled.');
  if (o.verify ?? true) {
    emit('verifier', 'step', `Independently reproducing ${candidates.length} candidate(s) in fresh browser contexts`, undefined, job);
    for (const f of candidates) {
      verified.push(deferExperimentalVendorFinding(await verifyFinding(f, url, brain, job, useLlm),experimentalVendorIds));
      progress('verifier',verified.length,candidates.length,verified.length===candidates.length?'completed':'running',`${verified.length} of ${candidates.length} candidate rechecks finished, including inconclusive outcomes.`);
    }
  } else verified.push(...candidates.map((f) => deferExperimentalVendorFinding({ ...f, status: 'confirmed' as const },experimentalVendorIds)));

  const confirmed = verified.filter((f) => f.status === 'confirmed');
  const rejected = verified.filter((f) => f.status === 'rejected');
  const unsure = verified.filter((f) => f.status === 'unresolved');
  let promptsFinished=0;
  progress('fixer',0,(o.prompts??true)?confirmed.length:0,(o.prompts??true)&&confirmed.length?'running':'skipped',(o.prompts??true)?`${confirmed.length} fix prompts planned.`:'Fix prompt generation was disabled.');
  if (o.prompts ?? true) {
    for (const f of confirmed) {
      f.repairPrompt = useLlm ? await writeRepairPrompt(f, brain, job) : templatePrompt(f, brain);
      promptsFinished++;progress('fixer',promptsFinished,confirmed.length,promptsFinished===confirmed.length?'completed':'running',`${promptsFinished} of ${confirmed.length} fix prompts saved.`);
      emit('fixer', 'step', `Repair prompt ready: ${f.title}`, undefined, job);
    }
  }
  const allUnresolved = [...unresolved, ...unsure.map((f) => experimentalVendorIds.has(f.subject)?{id:f.id,type:'vendor_rule_review' as const,subject:f.subject,summary:`${f.subjectName}: proposed vendor rule needs review — ${f.title}`,data:{finding:f,vendor:brain.vendors.find(v=>v.id===f.subject)}}:({ id: f.id, type: 'probe_error' as const, subject: f.subject, summary: `Could not verify: ${f.title} — ${f.verification?.notes.join('; ')}`, data: null }))];
  const state = allUnresolved.length ? 'completed_with_unknowns' : 'completed';
  const verdict = confirmed.length
    ? `${confirmed.length} confirmed issue(s) to fix before launch${allUnresolved.length ? `; ${allUnresolved.length} item(s) could not be decided` : ''}.`
    : allUnresolved.length ? `No confirmed issues, but ${allUnresolved.length} item(s) could not be decided — not a clean bill of health.`
    : 'No issues found within the audited scope (trackers & consent, policy disclosure, store badges).';

  const report: AuditReport = {
    ...(o.learningCandidate?{learningCandidate:o.learningCandidate}:{}),job, url, brainVersion: brain.version, startedAt: new Date(t0).toISOString(), ms: Date.now() - t0, state, verdict,
    investigatorSummary: summary,...(originalSummary?{investigatorSummaryOriginal:originalSummary}:{}), findings: confirmed, rejected, unresolved: allUnresolved, visual: visual.assessments,
    scan: { storeLinkObservations:s.storeLinkObservations, consent: s.consent, policy: { url: s.policy.url, text: s.policy.text ? s.policy.text.slice(0, 2000) : null }, screenshots: s.screenshots, stubbedThirdParties: s.stubbedThirdParties, requests: s.requests.length, assets: s.assets.length, locations: [...s.assets,...s.storeLinks].filter(item=>item.contextShot).map(item=>({selector:item.selector,bounds:item.bounds,contextShot:item.contextShot})) },
    roleWork,
    llm: { enabled: useLlm, calls: usage.calls - calls0, tokens: usage.prompt + usage.completion - tok0 },
  };
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  emit('controller', 'done', `Done in ${(report.ms / 1000).toFixed(1)}s — ${verdict}`, { job, report: `runs/${job}/report.json` }, job);
  return report;
}
