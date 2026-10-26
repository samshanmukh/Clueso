import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseProbeReply, guardProbeCode} from '../src/learn/learner.ts';
import {oracleSvgSize,developmentAdvice} from '../src/learn/real-checker.ts';
const raw={selector:'svg',href:'https://apps.apple.com/app/example',naturalW:120,naturalH:40,viewportW:200,viewportH:80,boxW:200,boxH:80,cssW:200,cssH:80,preserve:'xMidYMid meet',reference:null};
test('SVG oracle preserves intrinsic ratio for meet and slice, but detects stretching',()=>{
 assert.deepEqual(oracleSvgSize(raw),{naturalW:120,naturalH:40,drawnW:200,drawnH:200/3});
 assert.deepEqual(oracleSvgSize({...raw,preserve:'none'}),{naturalW:120,naturalH:40,drawnW:200,drawnH:80});
 assert.deepEqual(oracleSvgSize({...raw,preserve:'xMidYMid slice'}),{naturalW:120,naturalH:40,drawnW:240,drawnH:80});
 assert.deepEqual(oracleSvgSize({...raw,boxW:400}),{naturalW:120,naturalH:40,drawnW:400,drawnH:200/3});
});
test('SVG oracle rejects absent geometry instead of manufacturing an improvement',()=>{
 assert.equal(oracleSvgSize({...raw,naturalW:0}),null);
 assert.equal(oracleSvgSize({...raw,viewportH:NaN}),null);
});

test('model function envelopes execute as probe bodies instead of silently returning no measurements', async()=>{
 for(const code of ['async function() { return [1]; }','async function svgProbe() { return [1]; }','return [1];','(async () => { return [1]; })();','async function(document) { return [1]; }','async (document) => { return [1]; }']){
  const parsed=parseProbeReply('{"id":"svg"}\n```javascript\n'+code+'\n```');
  assert.ok(parsed);assert.equal(guardProbeCode(parsed.code,[]),null);
  assert.deepEqual(await new Function('return (async()=>{'+parsed.code+'})()')(),[1]);
 }
});

test('retention requires independent transfer, a frozen candidate and complete valid measurements',async()=>{
 const {transferRetentionErrors}=await import('../src/learn/retain-checker.ts');
 const good={executableCheckerTransferProven:true,unchanged:true,modelCallsDuringTransfer:0,development:{passed:true,cases:12},results:[{url:'https://other.example',transferred:true,reproducedMeasurements:1,first:{unverifiedMeasurements:0,baselineErrors:[],verifiedMeasurements:[{selector:"svg"}]},independent:{unverifiedMeasurements:0,baselineErrors:[],verifiedMeasurements:[{selector:"svg"}]}}]};
 assert.deepEqual(transferRetentionErrors(good),[]);
 assert.ok(transferRetentionErrors({...good,unchanged:false}).length);
 assert.ok(transferRetentionErrors({...good,modelCallsDuringTransfer:1}).length);
 assert.ok(transferRetentionErrors({...good,results:[{...good.results[0],error:'Unavailable'}]}).length);
 assert.ok(transferRetentionErrors({...good,development:{passed:false,cases:12}}).length);
});


test('development feedback explains SVG mode semantics without revealing holdout data',()=>{
 const feedback=developmentAdvice(['inline stretch: wrong geometry','CSS stretch: wrong geometry']);
 assert.match(feedback,/only ONE token/);
 assert.match(feedback,/CSS scale/);
 assert.doesNotMatch(feedback,/mojo|captions|ripl/i);
});

test('SVG learning distinguishes covered links, new gaps, and pages without SVG targets',async()=>{
 const {svgLearningOpportunity}=await import('../src/learn/real-checker.ts');
 const links=[{selector:'a.first',href:'https://apps.apple.com/app/x'},{selector:'a.second',href:'https://apps.apple.com/app/x'}] as any;
 const svgs=[{href:'https://apps.apple.com/app/x'}];
 const covered=[{selector:'a.first > svg'}] as any;
 const opportunity=svgLearningOpportunity(links,svgs,covered);
 assert.equal(opportunity.covered,1);assert.equal(opportunity.missing.length,1);assert.equal(opportunity.missing[0].selector,'a.second');
 assert.equal(svgLearningOpportunity(links,svgs,[...covered,{selector:'a.second > svg'}] as any).missing.length,0);
 assert.equal(svgLearningOpportunity(links,[],[]).eligible.length,0);
});
