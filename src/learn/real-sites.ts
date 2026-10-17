import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { config } from '../settings.ts';
import { loadBrain, forkBrain, nextVersionName, classifyHost, type BrainVersion, type Vendor } from '../brain/store.ts';
import { scan, closeBrowser, type ScanResult } from '../scan/scanner.ts';
import { runChecks } from '../checks/checks.ts';
import { proposeVendor } from './learner.ts';
import { usage, llmAvailable } from '../llm.ts';
import { emit } from '../events.ts';
import { validatePublicUrl } from '../tools/network.ts';

const digest=(value:unknown)=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const DEFAULT_HOLDOUTS=['https://mojo-app.com/','https://captions.ai/','https://www.ripl.com/'];

export function compareRealSiteSnapshot(snapshot:ScanResult,parent:BrainVersion,candidate:BrainVersion,learnedVendors:Vendor[]) {
    const base=runChecks({...snapshot,assets:snapshot.assets.filter(a=>parent.probes.some(p=>p.id===a.probe)),probeErrors:snapshot.probeErrors.filter(e=>parent.probes.some(p=>p.id===e.probe))},parent),next=runChecks(snapshot,candidate);
    const recognitions=learnedVendors.flatMap(vendor=>{
      const hits=snapshot.requests.filter(request=>classifyHost(request.host,candidate)?.id===vendor.id&&!classifyHost(request.host,parent));
      return hits.length?[{vendor:vendor.name,vendorId:vendor.id,hosts:[...new Set(hits.map(hit=>hit.host))],requests:hits.length,urls:[...new Set(hits.map(hit=>hit.url))].slice(0,3)}]:[];
    });
    return {beforeUnknown:base.unresolved.filter(u=>u.type==='unknown_third_party').length,afterUnknown:next.unresolved.filter(u=>u.type==='unknown_third_party').length,recognitions,unverifiedBaselineFindingKeys:base.findings.map(f=>f.key),unverifiedCandidateFindingKeys:next.findings.map(f=>f.key),probeErrors:snapshot.probeErrors};
}

/** Real-site experiment: no fixture oracle, invented labels, or automatic production promotion. */
export async function learnOnRealSites(trainingUrl='https://zupapps.com/', holdouts=DEFAULT_HOLDOUTS) {
  await validatePublicUrl(trainingUrl);
  for(const url of holdouts){await validatePublicUrl(url);if(new URL(url).hostname===new URL(trainingUrl).hostname)throw new Error('Training and transfer hosts must differ');}
  if(!llmAvailable())throw new Error('Real-site learning requires live inference');
  const job=`real-${new Date().toISOString().replace(/[:.]/g,'-')}`;
  const dir=path.join(config.dataDir,'real-learning',job);
  await fs.mkdir(dir,{recursive:true});
  const parent=loadBrain(), parentFingerprint=digest(parent), candidate=forkBrain(parent,nextVersionName());
  const startedAt=new Date().toISOString(), errors:{stage:string;error:string}[]=[];
  const write=async(name:string,value:unknown)=>fs.writeFile(path.join(dir,name),JSON.stringify(value,null,2));
  emit('learner','info',`Real-site learning on ${trainingUrl}; transfer hosts withheld from the learner`,undefined,job);
  const training=await scan(trainingUrl,parent,path.join(dir,'training'),job);
  const before=runChecks(training,parent);
  const learnedVendors:Vendor[]=[];
  for(const observation of before.unresolved.filter(u=>u.type==='unknown_third_party').slice(0,2)){
    try{
      const data=observation.data as {hosts:string[];urls:string[];phases:string[]};
      const proposed=await proposeVendor(observation.subject,data,parent,job);
      // Limit the learned rule to hosts actually observed on the training site.
      proposed.domains=proposed.domains.filter(domain=>data.hosts.some(host=>host===domain||host.endsWith('.'+domain)));
      if(!proposed.domains.length||!proposed.sources.length)throw new Error('No observed domain or research provenance');
      candidate.vendors.push(proposed);learnedVendors.push(proposed);
      candidate.changelog.push(`Learned ${proposed.name} classification from ${trainingUrl}; not a new executable probe.`);
    }catch(error){errors.push({stage:'vendor proposal',error:error instanceof Error?error.message:String(error)});}
  }
  const unmeasured=before.unresolved.filter(u=>u.type==='uninspected_store_badge');
  // Do not manufacture a missing capability or alter the real site to force a code-learning demo.
  const newExecutableCheckerLearned=false;
  const frozenAt=new Date().toISOString(),fingerprint=digest(candidate);
  await write('candidate.json',candidate);
  await write('freeze.json',{startedAt,trainingUrl,holdouts,from:parent.version,candidate:candidate.version,parentFingerprint,fingerprint,frozenAt,unmeasuredStoreLinks:unmeasured.length,probeDecision:unmeasured.length?'Probe gaps require a separately validated synthesis experiment.':'No unmeasured store-badge gap on the real training page; no probe synthesized.'});
  const modelCallsBeforeTransfer=usage.calls;
  const observations=(snapshot:ScanResult)=>compareRealSiteSnapshot(snapshot,parent,candidate,learnedVendors);
  const results=[];
  for(const [index,url] of holdouts.entries()){
    const targetDir=path.join(dir,`holdout-${index+1}`);
    emit('eval','step',`Frozen candidate: inspecting real holdout ${url} without inference`,undefined,job);
    try{
      const first=await scan(url,candidate,path.join(targetDir,'first'),job);
      const comparison=observations(first);
      // A separate browser context must reproduce any new recognition before counting transfer.
      const second=comparison.recognitions.length?await scan(url,candidate,path.join(targetDir,'independent'),job):null;
      const reproduced=second?observations(second).recognitions:[];
      const verifiedRecognitions=comparison.recognitions.filter(r=>reproduced.some(other=>other.vendorId===r.vendorId&&other.hosts.some(host=>r.hosts.includes(host))));
      results.push({url,observedAt:first.startedAt,comparison,independentRecheck:!!second,verifiedRecognitions,knowledgeTransferred:verifiedRecognitions.length>0,scanFile:path.join(targetDir,'first','scan.json')});
    }catch(error){results.push({url,error:error instanceof Error?error.message:String(error),knowledgeTransferred:false});}
    await write('progress.json',{trainingUrl,frozenAt,results});
  }
  const candidateOnDisk=JSON.parse(await fs.readFile(path.join(dir,'candidate.json'),'utf8')) as BrainVersion;
  const unchanged=digest(candidateOnDisk)===fingerprint&&digest(candidate)===fingerprint;
  const modelCallsDuringTransfer=usage.calls-modelCallsBeforeTransfer;
  const result={job,startedAt,completedAt:new Date().toISOString(),trainingUrl,from:parent.version,to:candidate.version,candidateFile:path.join(dir,'candidate.json'),parentFingerprint,fingerprint,frozenAt,unchanged,training:{unknownDomains:before.unresolved.filter(u=>u.type==='unknown_third_party').map(u=>u.subject),unmeasuredStoreLinks:unmeasured.length,probesBefore:parent.probes.length,probesAfter:candidate.probes.length},learnedVendors:learnedVendors.map(v=>({id:v.id,name:v.name,domains:v.domains,sources:v.sources,requiresConsent:v.requiresConsent})),policyJudgmentsValidated:false,newExecutableCheckerLearned,executableCheckerTransferProven:false,knowledgeTransferred:unchanged&&modelCallsDuringTransfer===0&&results.some(r=>r.knowledgeTransferred),modelCallsDuringTransfer,modelCallsDuringLearning:modelCallsBeforeTransfer,results,errors,promoted:false,scope:'Public real sites, no planted defects or ground-truth labels. Measures independently reproduced vendor recognition only; no accuracy, recall, or new executable checker claim. Consent and disclosure findings are not validated by this experiment.'};
  await write('result.json',result);
  await fs.writeFile(path.join(config.dataDir,'real-learning-latest.json'),JSON.stringify(result,null,2));
  emit('learner','done',`Real experiment finished: ${learnedVendors.length} vendor rule(s), ${result.knowledgeTransferred?'recognition transferred':'recognition not proven to transfer'}, no new executable checker`,undefined,job);
  return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  learnOnRealSites(process.argv[2]).then(result=>console.log(JSON.stringify({job:result.job,learnedVendors:result.learnedVendors.map(v=>v.name),knowledgeTransferred:result.knowledgeTransferred,newExecutableCheckerLearned:result.newExecutableCheckerLearned,results:result.results.map(r=>({url:r.url,knowledgeTransferred:r.knowledgeTransferred,error:'error'in r?r.error:undefined})),report:'data/real-learning-latest.json'},null,2))).catch(error=>{console.error(error.message);process.exitCode=1;}).finally(closeBrowser);
}
