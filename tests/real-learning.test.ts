import assert from 'node:assert/strict';
import {test} from 'node:test';
import {compareRealSiteSnapshot} from '../src/learn/real-sites.ts';
import type {BrainVersion,Vendor} from '../src/brain/store.ts';
import type {ScanResult} from '../src/scan/scanner.ts';
const parent:BrainVersion={version:'v0',parent:null,createdAt:'2026-01-01',vendors:[],brands:[],probes:[],changelog:[]};
const vendor:Vendor={id:'example-service',name:'Example Service',domains:['service.example'],category:'analytics',collects:[],policyKeywords:['example service'],requiresConsent:false,sources:[{url:'https://service.example/docs'}],addedBy:'learner'};
const candidate:BrainVersion={...parent,version:'v1',parent:'v0',vendors:[vendor]};
function snapshot(hosts:string[]):ScanResult{return {url:'https://public.example/',host:'public.example',startedAt:'2026-01-01',ms:1,artifactsDir:'unused',requests:hosts.map((host,i)=>({id:String(i),url:`https://${host}/beacon.js`,host,phase:'pre',type:'script',t:0})),consent:{found:false,clicked:false},policy:{url:null,text:null},assets:[],probeErrors:[],storeLinks:[],screenshots:{},stubbedThirdParties:false};}
test('real transfer comparison attributes recognition only to new observed vendor domains',()=>{
 const actual=compareRealSiteSnapshot(snapshot(['cdn.service.example']),parent,candidate,[vendor]);
 assert.equal(actual.beforeUnknown,1);assert.equal(actual.afterUnknown,0);
 assert.equal(actual.recognitions.length,1);assert.equal(actual.recognitions[0].vendorId,vendor.id);
 const unrelated=compareRealSiteSnapshot(snapshot(['service.example.attacker.example']),parent,candidate,[vendor]);
 assert.equal(unrelated.recognitions.length,0);assert.equal(unrelated.afterUnknown,1);
});
test('already known services and absent services do not count as learned transfer',()=>{
 assert.equal(compareRealSiteSnapshot(snapshot(['cdn.service.example']),candidate,candidate,[vendor]).recognitions.length,0);
 assert.equal(compareRealSiteSnapshot(snapshot([]),parent,candidate,[vendor]).recognitions.length,0);
});

test('candidate audits reject tampered or stale research snapshots and preserve the active brain',async()=>{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path'),crypto=await import('node:crypto');
 const {config}=await import('../src/settings.ts');const {loadFrozenVendorCandidate}=await import('../src/learn/real-sites.ts');
 const old={dataDir:config.dataDir,brainDir:config.brainDir},root=await fs.mkdtemp(path.join(os.tmpdir(),'clueso-vendor-candidate-'));const fingerprint=(value:unknown)=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
 try{config.dataDir=path.join(root,'data');config.brainDir=path.join(root,'brain');const dir=path.join(config.dataDir,'real-learning/real-test');await fs.mkdir(dir,{recursive:true});await fs.mkdir(path.join(config.brainDir,'versions'),{recursive:true});await fs.writeFile(path.join(config.brainDir,'versions/v0.json'),JSON.stringify(parent));await fs.writeFile(path.join(config.brainDir,'registry.json'),JSON.stringify({active:'v0',versions:['v0'],decisions:[]}));
 const freeze={parentFingerprint:fingerprint(parent),fingerprint:fingerprint(candidate)};await fs.writeFile(path.join(dir,'freeze.json'),JSON.stringify(freeze));await fs.writeFile(path.join(dir,'candidate.json'),JSON.stringify(candidate));const loaded=await loadFrozenVendorCandidate('real-test');assert.equal(loaded.brain.version,'v1');assert.equal(loaded.learningCandidate.parent,'v0');assert.match(loaded.learningCandidate.scope,/not retained/);
 await assert.rejects(loadFrozenVendorCandidate('../real-test'),/Invalid/);
 await fs.writeFile(path.join(dir,'candidate.json'),JSON.stringify({...candidate,changelog:['tampered']}));await assert.rejects(loadFrozenVendorCandidate('real-test'),/changed after freezing/);
 await fs.writeFile(path.join(dir,'candidate.json'),JSON.stringify(candidate));await fs.writeFile(path.join(config.brainDir,'versions/v0.json'),JSON.stringify({...parent,changelog:['concurrent change']}));await assert.rejects(loadFrozenVendorCandidate('real-test'),/parent changed/);
 assert.equal(JSON.parse(await fs.readFile(path.join(config.brainDir,'registry.json'),'utf8')).active,'v0');
 }finally{config.dataDir=old.dataDir;config.brainDir=old.brainDir;await fs.rm(root,{recursive:true,force:true});}
});

test('new vendor rules cannot turn provisional policy conclusions into verified findings',async()=>{
 const {deferExperimentalVendorFinding}=await import('../src/agents/controller.ts');
 const finding={id:'candidate',subject:'new-vendor',status:'confirmed',verification:{status:'confirmed',method:'Fresh browser request check',notes:['Request reproduced.']}} as any;
 const deferred=deferExperimentalVendorFinding(finding,new Set(['new-vendor']));assert.equal(deferred.status,'unresolved');assert.equal(deferred.verification?.status,'unresolved');assert.match(deferred.verification?.notes.join(' ')??'',/vendor rule is experimental/);
 assert.equal(deferExperimentalVendorFinding(finding,new Set()),finding);
 const rejected={...finding,status:'rejected'} as any;assert.equal(deferExperimentalVendorFinding(rejected,new Set(['new-vendor'])),rejected);
});
