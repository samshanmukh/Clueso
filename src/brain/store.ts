import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../settings.ts';

export interface Source { url: string; quote?: string; retrievedAt?: string }
export interface Vendor {
  id: string; name: string; domains: string[]; category: string; collects: string[];
  policyKeywords: string[]; requiresConsent: boolean | null; consentRationale?: string; sources: Source[]; addedBy: string;
}
/** Category words do not establish that a policy names a particular vendor. */
export function vendorPolicyNames(v: Vendor): string[] {
  const generic = new Set(['analytics', 'tracking', 'session replay', 'heatmaps', 'user experience', 'digital experience analytics', 'cookies', 'advertising', 'third-party', 'third party', 'marketing']);
  return [...new Set([v.name.toLowerCase(), ...v.policyKeywords.map((k) => k.trim().toLowerCase()).filter((k) => k.length >= 3 && !generic.has(k))])];
}
export interface BrandRule {
  id: string; name: string; linkHosts: string[]; assetHints: string[];
  maxAspectDeviation: number; prohibitFilters: boolean; prohibitRotation: boolean;
  guidance: string; sources: Source[]; addedBy: string;
}
/** An inspection probe: async JS function body run inside the page. Returns AssetInstance[]. */
export interface Probe { id: string; name: string; description: string; code: string; addedBy: string; codeHash?: string }
export interface BrainVersion {
  version: string; parent: string | null; createdAt: string;
  vendors: Vendor[]; brands: BrandRule[]; probes: Probe[]; changelog: string[];
}
export interface PromotionDecision {
  candidate: string; parent: string; at: string; accepted: boolean; kind: 'vendor' | 'probe' | 'mixed';
  summary: string; parentMetrics: unknown; candidateMetrics: unknown; reasons: string[];
}
export interface Registry { active: string; versions: string[]; decisions: PromotionDecision[] }

const dir = () => config.brainDir;
const regPath = () => path.join(dir(), 'registry.json');
export function validateVersion(v: unknown): asserts v is string {
  if (typeof v !== 'string' || !/^v\d+$/.test(v)) throw new Error('Invalid brain version; expected v followed by digits');
}
const verPath = (v: string) => { validateVersion(v); return path.join(dir(), 'versions', `${v}.json`); };

export function hash(s: string) { return crypto.createHash('sha256').update(s).digest('hex').slice(0, 12); }

export function loadRegistry(): Registry {
  return JSON.parse(fs.readFileSync(regPath(), 'utf8'));
}
export function saveRegistry(r: Registry) { fs.writeFileSync(regPath(), JSON.stringify(r, null, 2)); }

export function loadBrain(version?: string): BrainVersion {
  const v = version ?? loadRegistry().active;
  return JSON.parse(fs.readFileSync(verPath(v), 'utf8'));
}

export function nextVersionName(): string {
  const r = loadRegistry();
  const used = [...r.versions, ...r.decisions.map((d) => d.candidate)];
  const n = Math.max(...used.map((v) => Number(v.replace(/\D/g, '')) || 0)) + 1;
  return `v${n}`;
}

/** Candidates are written under candidates/ and only become versions when promoted. */
export function saveCandidate(b: BrainVersion) {
  validateVersion(b.version);
  fs.mkdirSync(path.join(dir(), 'candidates'), { recursive: true });
  fs.writeFileSync(path.join(dir(), 'candidates', `${b.version}.json`), JSON.stringify(b, null, 2));
}

export function promote(b: BrainVersion, d: PromotionDecision) {
  validateVersion(b.version);
  const r = loadRegistry();
  if (d.accepted) {
    fs.writeFileSync(verPath(b.version), JSON.stringify(b, null, 2));
    r.versions.push(b.version);
    r.active = b.version; // new audits use it; running audits stay pinned to their snapshot
  } else {
    fs.mkdirSync(path.join(dir(), 'rejected'), { recursive: true });
    fs.writeFileSync(path.join(dir(), 'rejected', `${b.version}-${Date.now()}.json`), JSON.stringify(b, null, 2));
  }
  r.decisions.push(d);
  saveRegistry(r);
}

export function forkBrain(parent: BrainVersion, name: string): BrainVersion {
  const b: BrainVersion = JSON.parse(JSON.stringify(parent));
  b.version = name; b.parent = parent.version; b.createdAt = new Date().toISOString(); b.changelog = [];
  return b;
}

export function hostMatches(host: string, domain: string) {
  host = host.toLowerCase(); domain = domain.toLowerCase().replace(/^\*\./, '');
  return host === domain || host.endsWith('.' + domain);
}

export function classifyHost(host: string, brain: BrainVersion): Vendor | null {
  return brain.vendors.find((v) => v.domains.some((d) => hostMatches(host, d))) ?? null;
}

/** Reset brain to the seed (v0 only). Used before demos and evals. */
export function resetBrain() {
  const r: Registry = { active: 'v0', versions: ['v0'], decisions: [] };
  saveRegistry(r);
  for (const sub of ['candidates', 'rejected']) fs.rmSync(path.join(dir(), sub), { recursive: true, force: true });
  for (const f of fs.readdirSync(path.join(dir(), 'versions'))) if (f !== 'v0.json') fs.rmSync(path.join(dir(), 'versions', f));
}
