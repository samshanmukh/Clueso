import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseProbeReply, guardProbeCode} from '../src/learn/learner.ts';
import {oracleSvgSize} from '../src/learn/real-checker.ts';
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
 for(const code of ['async function() { return [1]; }','async function svgProbe() { return [1]; }','return [1];']){
  const parsed=parseProbeReply('{"id":"svg"}\n```javascript\n'+code+'\n```');
  assert.ok(parsed);assert.equal(guardProbeCode(parsed.code,[]),null);
  assert.deepEqual(await new Function('return (async()=>{'+parsed.code+'})()')(),[1]);
 }
});
