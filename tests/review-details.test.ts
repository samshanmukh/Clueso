import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildReviewDetails,enrichReviewReport,evidenceUrl} from '../src/reviews/details.ts';
import type {AuditReport} from '../src/agents/controller.ts';
import type {ScanResult} from '../src/scan/scanner.ts';
import type {Unresolved} from '../src/checks/checks.ts';
const review:Unresolved={id:'unknown',type:'unknown_third_party',subject:'service.example',summary:'3 request(s) to service.example — vendor not in the shared brain',data:{hosts:['cdn.service.example'],urls:['https://cdn.service.example/script.js?token=private-value'],phases:['pre','post']}};
const report={job:'job-review',url:'https://site.example/',brainVersion:'v4',startedAt:'2026-10-18T03:00:00Z',findings:[],unresolved:[review],scan:{policy:{url:'https://site.example/privacy',text:'Excerpt'},consent:{found:true,clicked:true,text:'Accept'}}} as unknown as AuditReport;
const scan={requests:[{id:'r1',host:'cdn.service.example',url:'https://cdn.service.example/script.js?token=private-value',phase:'pre',type:'script',t:50},{id:'r2',host:'events.service.example',url:'https://events.service.example/collect',phase:'post',type:'fetch',t:800},{id:'r3',host:'service.example.attacker.example',url:'https://service.example.attacker.example/',phase:'pre',type:'script',t:10}],policy:{url:'https://site.example/privacy',text:'We use Service for a specific purpose.'}} as ScanResult;
test('review evidence uses complete matching capture counts, timing and literal policy context',()=>{
 const result=buildReviewDetails(review,report,scan);assert.equal(result.network?.total,2);assert.equal(result.network?.before,1);assert.equal(result.network?.after,1);assert.deepEqual(result.network?.types,['script','fetch']);assert.equal(result.network?.samples[0].elapsedMs,50);assert.ok(result.policy.matches.length);assert.match(result.policy.conclusion,/still need review/);assert.doesNotMatch(result.prompt,/private-value/);assert.match(result.prompt,/CHECK FIRST/);assert.match(result.prompt,/FIX ONLY IF/);assert.match(result.prompt,/- \[ \]/);assert.match(result.prompt,/make no website change/);
});
test('legacy report-only evidence preserves unknown phase counts rather than inventing zeros',()=>{
 const result=buildReviewDetails(review,report);assert.equal(result.network?.total,3);assert.equal(result.network?.before,null);assert.equal(result.network?.after,null);assert.equal(result.network?.samples[0].elapsedMs,null);assert.match(result.context.source,/full scan unavailable/);assert.ok(result.missing.some(s=>s.includes('full browser scan')));
});
test('policy absence, clipped captures and incomplete investigations remain explicit',()=>{
 const incomplete={...report,roleWork:{investigator:{completed:0,total:1,state:'failed',detail:'Budget exhausted'}}} as AuditReport;
 const result=buildReviewDetails(review,incomplete,{...scan,policy:{url:'https://site.example/privacy',text:'x'.repeat(40000)}});assert.equal(result.policy.possiblyTruncated,true);assert.match(result.policy.conclusion,/does not establish/);assert.ok(result.missing.some(s=>s.includes('investigator did not finish')));
 assert.match(buildReviewDetails(review,report,{...scan,policy:{url:null,text:null}}).policy.conclusion,/No policy text/);
});
test('URL evidence omits credentials, query values and opaque path identifiers',()=>{
 const result=evidenceUrl('https://name:password@cdn.example/eval/abcdefghijklmnopqrstuvwxyz0123456789?email=person@example.com#private');assert.ok(result.includes('[captured-id]'));for(const secret of ['password','person@example.com','abcdefghijklmnopqrstuvwxyz0123456789','#private'])assert.ok(!result.includes(secret));assert.ok(result.includes('query keys: email'));assert.equal(evidenceUrl('javascript:alert(1)'), '');
});
test('all review types receive conditional check-and-fix prompts without mutating the saved report',()=>{
 const types:Unresolved['type'][]=['unknown_third_party','vendor_rule_review','uninspected_store_badge','probe_error','no_consent_control','visual_review','brand_layout_review'];
 for(const type of types){const item={...review,type,...(type==='brand_layout_review'?{data:{selector:'#badge',asset:{selector:'#badge',naturalW:120,naturalH:40,drawnW:90,drawnH:30,technique:'img'},measuredHeight:30,minimumHeight:40}}:{})};const original={...report,unresolved:[item]};const result=enrichReviewReport(original,scan);assert.equal((item as any).reviewDetails,undefined);assert.ok(result.unresolved[0].reviewDetails.prompt.includes('Verify it before changing code'));assert.ok(result.unresolved[0].reviewDetails.acceptanceChecks.length);if(type==='brand_layout_review'){assert.equal(result.unresolved[0].reviewDetails.element?.intrinsicWidth,120);assert.equal(result.unresolved[0].reviewDetails.element?.paintedHeight,30);assert.match(result.unresolved[0].reviewDetails.prompt,/standardMinimumHeight/);}}
});
