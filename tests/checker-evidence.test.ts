import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {loadCheckerEvidence} from '../src/learn/checker-evidence.ts';
import {loadBrain} from '../src/brain/store.ts';
test('a failed proposal preserves independent evidence for the exact retained active tool',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'clueso-retained-evidence-'));
 try{
  const probe={id:'svg-artwork',name:'SVG artwork',description:'Test only',code:'return [];',codeHash:'test',addedBy:'test-only'};
  const brain={...loadBrain('v0'),probes:[probe]};
  const retained={job:'retained',promoted:true,probe,executableCheckerTransferProven:true};
  fs.writeFileSync(path.join(dir,'real-checker-retained.json'),JSON.stringify(retained));
  fs.writeFileSync(path.join(dir,'real-checker-latest.json'),JSON.stringify({job:'failed',status:'failed',promoted:false}));
  const result=loadCheckerEvidence(dir,brain);
  assert.equal(result.status,'failed');assert.equal(result.retainedResult.job,'retained');assert.equal(result.retainedResult.activeInBrain,true);
  assert.equal(loadCheckerEvidence(dir,{...brain,probes:[]}).retainedResult,undefined);
  assert.equal(loadCheckerEvidence(dir,{...brain,probes:[{...probe,code:'return [1];'}]}).retainedResult,undefined);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('a legacy no-gap result is presented as no-change without losing retained evidence',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'clueso-no-gap-'));
 try{
  const probe={id:'svg-artwork',name:'SVG artwork',description:'Test',code:'return [];',addedBy:'test'};
  const brain={...loadBrain('v0'),probes:[probe]};
  fs.writeFileSync(path.join(dir,'real-checker-retained.json'),JSON.stringify({job:'retained',promoted:true,probe}));
  fs.writeFileSync(path.join(dir,'real-checker-latest.json'),JSON.stringify({job:'latest',status:'failed',promoted:false,error:'The real training page has no unmeasured SVG badge gap; no artificial gap will be created.'}));
  const result=loadCheckerEvidence(dir,brain);
  assert.equal(result.status,'no_change');assert.equal(result.recordedStatus,'failed');
  assert.equal(result.retainedResult.job,'retained');assert.equal(result.retainedResult.activeInBrain,true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'real-checker-latest.json'),'utf8')).status,'failed');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
