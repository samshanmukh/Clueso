import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {config} from '../settings.ts';
import {loadBrain,loadRegistry,promote,saveCandidate,type BrainVersion,type PromotionDecision} from '../brain/store.ts';
import {registerFixtureOrigin} from '../scan/scanner.ts';
import {loadLabels,quickEval} from '../eval/score.ts';
import {guardProbeCode} from './learner.ts';
import {emit} from '../events.ts';
const fingerprint=(value:unknown)=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function transferRetentionErrors(result:any):string[]{
 const errors:string[]=[];
 const text=result.capability==='text-store-links',count=text?'reproducedClassifications':'reproducedMeasurements',verified=text?'verifiedClassifications':'verifiedMeasurements',invalid=text?'unverifiedClassifications':'unverifiedMeasurements';
 if(result.executableCheckerTransferProven!==true||result.unchanged!==true||result.modelCallsDuringTransfer!==0)errors.push('Frozen zero-inference transfer was not proven.');
 if(result.development?.passed!==true||(!Number.isInteger(result.development?.cases)||result.development.cases<12))errors.push('Development measurement contract did not pass.');
 if(!Array.isArray(result.results)||!result.results.some((r:any)=>r.transferred&&r[count]>0))errors.push('No independently reproduced improvement on another app.');
 for(const site of result.results??[]){if(site.transferred&&(!site.first?.[verified]?.length||!site.independent?.[verified]?.length))errors.push(`Independent measurement evidence missing on ${site.url}.`);if(site.error||site.first?.[invalid]||site.independent?.[invalid]||site.first?.baselineErrors?.length||site.independent?.baselineErrors?.length)errors.push(`Incomplete or invalid measurements on ${site.url}.`);}
 return errors;
}
/** Retain the exact frozen code only after transfer and independently rerun regressions. */
export async function retainRealChecker(job:string){
 if(!/^checker-[\w-]+$/.test(job))throw new Error('Invalid checker experiment id');
 const dir=path.join(config.dataDir,'real-checker',job);
 const result=JSON.parse(await fs.readFile(path.join(dir,'result.json'),'utf8'));
 if(result.promoted)return result;
 const candidate:BrainVersion=JSON.parse(await fs.readFile(path.join(dir,'candidate.json'),'utf8'));
 const parent=loadBrain(result.parent),current=loadBrain();
 const errors=transferRetentionErrors(result);
 if(fingerprint(candidate)!==result.candidateFingerprint)errors.push('Candidate no longer matches its frozen fingerprint.');
 if(fingerprint(parent)!==result.parentFingerprint||fingerprint(current)!==result.parentFingerprint)errors.push('Active parent changed; candidate must be revalidated.');
 if(loadRegistry().versions.includes(candidate.version))errors.push('Candidate version already exists.');
 const added=candidate.probes.filter(p=>!parent.probes.some(prior=>prior.id===p.id));
 if(JSON.stringify(candidate.probes.slice(0,parent.probes.length))!==JSON.stringify(parent.probes))errors.push('Existing checker code changed.');
 if(added.length!==1||added[0].id!==result.probe.id||added[0].code!==result.probe.code)errors.push('Candidate does not contain exactly the recorded new checker.');
 if(JSON.stringify(candidate.vendors)!==JSON.stringify(parent.vendors)||JSON.stringify(candidate.brands)!==JSON.stringify(parent.brands))errors.push('Candidate changed rules outside the learned checker.');
 for(const probe of added){const issue=guardProbeCode(probe.code,[]);if(issue)errors.push(issue);}
 if(errors.length)throw new Error(errors.join(' '));
 const origin=`http://localhost:${config.port}`;registerFixtureOrigin(origin);
 emit('gate','step','Real transfer passed. Independently rerunning existing checks before retention.',undefined,job);
 const apps=loadLabels().splits.dev;
 const before=await quickEval(parent,apps,origin+'/fixtures'),after=await quickEval(candidate,apps,origin+'/fixtures');
 for(const app of after.apps){const original=before.apps.find(a=>a.app===app.app)!;if(app.fp.some(k=>!original.fp.includes(k))||original.tp.some(k=>!app.tp.includes(k))||app.probeErrors>original.probeErrors)errors.push(`Regression on ${app.app}.`);}
 // Compare the parent again after async evaluation; do not overwrite concurrent work.
 if(fingerprint(loadBrain())!==result.parentFingerprint)errors.push('Active brain changed during regression evaluation.');
 const text=result.capability==='text-store-links',metric=text?'textLinksClassified':'svgMeasurements',unit=text?'text-only store-link classifications':'new SVG measurements';
 const measured=result.results.reduce((n:number,r:any)=>n+(r[text?'reproducedClassifications':'reproducedMeasurements']??0),0);
 const decision:PromotionDecision={parent:parent.version,candidate:candidate.version,at:new Date().toISOString(),kind:'probe',accepted:errors.length===0,summary:`${text?'Text-link':'SVG'} checker ${errors.length?'not retained':'retained'} after real-site transfer and regression checks.`,parentMetrics:{[metric]:0,tp:before.tp,fp:before.fp,unresolved:before.unresolved},candidateMetrics:{[metric]:measured,tp:after.tp,fp:after.fp,unresolved:after.unresolved},reasons:errors.length?errors:[`${measured} independently reproduced ${unit} on real held-out sites.`,`${result.development.cases} development ${text?'classification':'measurement'} cases passed; no new false findings or lost detections on development regression apps.`,`This measures inspection coverage, not real-world compliance accuracy.`]};
 saveCandidate(candidate);promote(candidate,decision);
 const updated={...result,promoted:decision.accepted,promotion:decision,regression:{before,after}};
 await fs.writeFile(path.join(dir,'promotion.json'),JSON.stringify(decision,null,2));
 await fs.writeFile(path.join(dir,'result.json'),JSON.stringify(updated,null,2));
 if(decision.accepted)await fs.writeFile(path.join(config.dataDir,'real-checker-retained.json'),JSON.stringify(updated,null,2));
 const latestPath=path.join(config.dataDir,'real-checker-latest.json');
 const latest=JSON.parse(await fs.readFile(latestPath,'utf8'));if(latest.job===job)await fs.writeFile(latestPath,JSON.stringify(updated,null,2));
 emit('gate',decision.accepted?'done':'warn',decision.summary,decision,job);
 return updated;
}
