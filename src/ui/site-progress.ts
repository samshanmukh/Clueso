/** Completion of recorded work on one site; never a learning or accuracy score. */
export const siteRoles = ['scanner','vision','investigator','verifier','fixer','learner'] as const;
export type SiteRole = typeof siteRoles[number];
export type WorkProgress = { completed: number; total: number; state: 'waiting'|'running'|'completed'|'skipped'|'failed'; detail: string };
export type SiteWork = { job: string|null; url: string; running: boolean; eventCount?:number; activeRole?:string|null; message?:string; progress?: Partial<Record<SiteRole,WorkProgress>>; report?: SiteReport|null };
type Finding = { verification?: {status?:string}; repairPrompt?:string };
export type SiteReport = { job:string; url:string; state:string; roleWork?:Partial<Record<SiteRole,WorkProgress>>; investigatorSummary?:string; llm?:{enabled:boolean}; findings:Finding[]; rejected?:Finding[]; unresolved?:{summary?:string}[]; visual?:{status:string}[]; scan:{screenshots?:{pre?:string}} };
export function workPercent(work:WorkProgress):number|null {
 if(work.state==='skipped'||!Number.isFinite(work.total)||work.total<=0||!Number.isFinite(work.completed))return null;
 return Math.round(Math.max(0,Math.min(work.completed,work.total))/work.total*100);
}
export function siteRoleWork(site:SiteWork|null):Record<SiteRole,WorkProgress> {
 const skipped=(detail:string):WorkProgress=>({completed:0,total:0,state:'skipped',detail});
 const waiting=(detail:string):WorkProgress=>({completed:0,total:1,state:'waiting',detail});
 const finished=(completed:number,total:number,detail:string):WorkProgress=>({completed,total,state:'completed',detail});
 const r=site?.report;
 const rows=Object.fromEntries(siteRoles.map(role=>[role,site?.running?waiting('Waiting for this agent’s work on this site.'):skipped(site?'No work recorded for this role.':'Choose a site or saved audit.')] )) as Record<SiteRole,WorkProgress>;
 if(r){
  rows.scanner=r.scan.screenshots?.pre?finished(1,1,'Browser inspection saved.'):skipped('No browser capture recorded.');
  rows.vision=r.visual?.length?finished(r.visual.length,r.visual.length,`${r.visual.length} comparison attempts finished; ${r.visual.filter(v=>v.status==='unavailable').length} unavailable.`):skipped('No visual comparison tasks recorded.');
  rows.investigator=r.investigatorSummary?.trim()?finished(1,1,'Investigation summary saved.'):skipped(r.llm?.enabled?'Investigation completion was not recorded.':'Model investigation was disabled.');
  const candidates=[...r.findings,...(r.rejected??[])];
  const uncertain=r.unresolved?.filter(item=>item.summary?.startsWith('Could not verify:')).length??0;
  const verified=candidates.filter(f=>f.verification?.status).length+uncertain;
  rows.verifier=candidates.length+uncertain?finished(verified,candidates.length+uncertain,'Candidate rechecks recorded, including inconclusive outcomes.'):skipped('No candidate findings required rechecking.');
  rows.fixer=r.findings.length?finished(r.findings.filter(f=>f.repairPrompt?.trim()).length,r.findings.length,'Fix prompts saved for confirmed findings.'):skipped('No confirmed findings required fix prompts.');
  rows.learner=skipped('Learning is a separate step; this audit did not run it.');
 }
 for(const role of siteRoles){const saved=site?.progress?.[role]??r?.roleWork?.[role];if(saved)rows[role]=saved;}
 return rows;
}
