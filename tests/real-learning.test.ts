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
