import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentProgress, type LearningEvidence } from '../src/ui/agent-progress.ts';

export const progressEvidence: LearningEvidence = {
  from: 'v1', to: 'v2', unchanged: true, promoted: false, modelCallsDuringTransfer: 0,
  training: { unknownDomains: ['beacon.example'], probesBefore: 2, probesAfter: 2 },
  learnedVendors: [{ id: 'beacon', name: 'Beacon', domains: ['beacon.example'], sources: [{ url: 'https://beacon.example/docs' }] }],
  results: [
    { url: 'https://one.example/', independentRecheck: true, verifiedRecognitions: [{ vendorId: 'beacon', hosts: ['static.beacon.example'] }] },
    { url: 'https://two.example/', independentRecheck: false, verifiedRecognitions: [] },
    { url: 'https://three.example/', error: 'Unavailable' },
  ],
};

test('agent progress separates research coverage, reproduced reuse, and unmeasured roles', () => {
  const rows = agentProgress(progressEvidence);
  assert.deepEqual(rows[0].progress, { value: 1, total: 1, label: 'Observed domains researched' });
  assert.equal(rows[0].headline, '1 rule proposed');
  assert.match(rows[0].detail, /not yet added/);
  assert.deepEqual(rows[1].progress, { value: 1, total: 3, label: 'Test sites with reproduced reuse' });
  assert.match(rows[1].detail, /0 new executable probes/);
  assert.equal(rows.slice(2).length, 4);
  assert.ok(rows.slice(2).every(row => row.progress === null && row.headline === 'Not measured'));
  assert.ok(agentProgress(null).every(row => row.progress === null));
});

test('reuse bars require frozen, inference-free, independently reproduced evidence', () => {
  for (const change of [{ unchanged: false }, { modelCallsDuringTransfer: 1 }]) {
    const rows = agentProgress({ ...progressEvidence, ...change });
    assert.equal(rows[1].progress?.value, 0);
    assert.match(rows[1].detail, /gate not passed/);
  }
  const original = progressEvidence.results[0];
  for (const site of [
    { ...original, independentRecheck: false },
    { ...original, verifiedRecognitions: [{ vendorId: 'beacon', hosts: ['beacon.example.attacker.test'] }] },
    { ...original, verifiedRecognitions: [{ vendorId: 'different', hosts: ['static.beacon.example'] }] },
  ]) assert.equal(agentProgress({ ...progressEvidence, results: [site] })[1].progress?.value, 0);
});

test('missing sources, empty opportunities, and repeated sites never inflate progress', () => {
  const noSources = { ...progressEvidence, learnedVendors: [{ ...progressEvidence.learnedVendors[0], sources: [] }] };
  assert.equal(agentProgress(noSources)[0].progress?.value, 0);
  assert.equal(agentProgress(noSources)[1].progress?.value, 0);
  const empty = agentProgress({ ...progressEvidence, training: { ...progressEvidence.training, unknownDomains: [] }, results: [] });
  assert.equal(empty[0].progress, null);
  assert.equal(empty[1].progress, null);
  const duplicate = agentProgress({ ...progressEvidence, results: [...progressEvidence.results, progressEvidence.results[0]] });
  assert.equal(duplicate[1].progress?.total, 3);
});
