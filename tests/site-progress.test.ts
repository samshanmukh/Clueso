import assert from 'node:assert/strict';
import {test} from 'node:test';
import {siteRoleWork,workPercent,type SiteWork,type WorkProgress} from '../src/ui/site-progress.ts';
const report={job:'a',url:'https://a.example',state:'completed',findings:[{verification:{status:'confirmed'},repairPrompt:'Fix it'}],rejected:[],unresolved:[],scan:{screenshots:{pre:'pre.png'}},llm:{enabled:false}};
test('saved audits restore only role work evidenced on that site',()=>{
 const roles=siteRoleWork({job:'a',url:report.url,running:false,report});
 assert.equal(workPercent(roles.scanner),100);assert.equal(workPercent(roles.verifier),100);assert.equal(workPercent(roles.fixer),100);
 for(const role of ['vision','investigator','learner'] as const)assert.equal(workPercent(roles[role]),null);
 const other=siteRoleWork({job:'b',url:'https://b.example',running:true});
 assert.equal(workPercent(other.scanner),0);assert.equal(other.scanner.state,'waiting');
});
test('recorded checkpoints survive partial work, failures, and skipped roles without invented percentages',()=>{
 const work:WorkProgress={completed:1,total:4,state:'running',detail:'Captured page'};
 const site:SiteWork={job:'live',url:'https://live.example',running:true,progress:{scanner:work}};
 assert.equal(workPercent(siteRoleWork(site).scanner),25);
 assert.equal(workPercent({...work,state:'failed'}),25);
 assert.equal(workPercent({...work,completed:7}),100);
 assert.equal(workPercent({...work,total:0}),null);
 assert.equal(workPercent({...work,completed:NaN}),null);
 assert.equal(workPercent({...work,state:'skipped'}),null);
 assert.equal(workPercent(siteRoleWork({...site,report:{...report,roleWork:{scanner:{...work,completed:4,state:'completed'}}},progress:undefined}).scanner),100);
});
test('inconclusive checks can finish work without claiming a successful audit',()=>{
 const roles=siteRoleWork({job:'a',url:report.url,running:false,report:{...report,state:'completed_with_unknowns',visual:[{status:'unavailable'}],unresolved:[{summary:'Could not verify: Badge shape'}]}});
 assert.equal(workPercent(roles.vision),100);assert.match(roles.vision.detail,/1 unavailable/);
 assert.equal(roles.verifier.total,2);assert.equal(workPercent(roles.verifier),100);
});
