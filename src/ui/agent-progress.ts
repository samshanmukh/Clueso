/** Role contributions from one saved real-site experiment, never a model intelligence score. */
export type LearningEvidence = {
  from: string;
  to: string;
  unchanged: boolean;
  promoted: boolean;
  modelCallsDuringTransfer: number;
  training: { unknownDomains: string[]; probesBefore: number; probesAfter: number };
  learnedVendors: { id: string; name: string; domains: string[]; sources: { url: string }[] }[];
  results: {
    url: string;
    error?: string;
    independentRecheck?: boolean;
    verifiedRecognitions?: { vendorId: string; hosts: string[] }[];
  }[];
};
export type RoleProgress = {
  role: string;
  headline: string;
  detail: string;
  progress: { value: number; total: number; label: string } | null;
};
const matchesDomain = (host: string, domain: string) => host === domain || host.endsWith('.' + domain);
const unique = (values: string[]) => [...new Set(values)];

export function agentProgress(evidence: LearningEvidence | null): RoleProgress[] {
  const vendors = evidence ? evidence.learnedVendors.filter(v => v.domains.length && v.sources.some(s => /^https?:\/\//.test(s.url))) : [];
  const ruleCount = unique(vendors.map(v => v.id)).length;
  const observed = unique(evidence?.training.unknownDomains ?? []);
  const researched = observed.filter(domain => vendors.some(v => v.domains.some(rule => matchesDomain(domain, rule) || matchesDomain(rule, domain))));
  const sites = evidence ? [...new Map(evidence.results.map(site => [new URL(site.url).hostname, site])).values()] : [];
  const transferEligible = evidence?.unchanged === true && evidence.modelCallsDuringTransfer === 0;
  const reused = sites.filter(site => transferEligible && !site.error && site.independentRecheck && site.verifiedRecognitions?.some(recognition => vendors.some(v => v.id === recognition.vendorId && recognition.hosts.some(host => v.domains.some(domain => matchesDomain(host, domain))))));
  const newProbes = evidence ? Math.max(0, evidence.training.probesAfter - evidence.training.probesBefore) : 0;
  const untested = (role: string, detail: string): RoleProgress => ({ role, headline: 'Not measured', detail: evidence ? detail : 'Run a real-site learning cycle to collect evidence.', progress: null });
  return [
    evidence ? {
      role: 'learner',
      headline: `${ruleCount} ${ruleCount === 1 ? 'rule' : 'rules'} proposed`,
      detail: evidence.promoted ? 'Rules promoted to the shared brain.' : 'Candidate rules; not yet added to the active brain.',
      progress: observed.length ? { value: researched.length, total: observed.length, label: 'Observed domains researched' } : null,
    } : untested('learner', ''),
    evidence ? {
      role: 'scanner',
      headline: `Reused on ${reused.length} ${reused.length === 1 ? 'site' : 'sites'}`,
      detail: `${newProbes} new executable probes. ${transferEligible ? 'Reuse required a separate browser recheck.' : 'Transfer evidence gate not passed.'}`,
      progress: sites.length ? { value: reused.length, total: sites.length, label: 'Test sites with reproduced reuse' } : null,
    } : untested('scanner', ''),
    untested('vision', 'Vision was not evaluated in this experiment.'),
    untested('investigator', 'Investigation quality was not evaluated.'),
    untested('verifier', 'Rechecks were automated; verifier-agent learning was not measured.'),
    untested('fixer', 'Fix prompts were not evaluated in this experiment.'),
  ];
}
