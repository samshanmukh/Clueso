import type { BrainVersion, BrandRule, Vendor } from '../brain/store.ts';
import { classifyHost, hostMatches, vendorPolicyNames } from '../brain/store.ts';
import type { AssetInstance, ScanResult, StoreLink } from '../scan/scanner.ts';

export type FindingType = 'pre_consent_tracking' | 'undisclosed_vendor' | 'missing_privacy_policy' | 'badge_misuse';
export type Status = 'candidate' | 'confirmed' | 'rejected' | 'unresolved';

export interface Evidence { kind: 'request' | 'policy' | 'asset' | 'consent' | 'screenshot' | 'verification' | 'note' | 'service'; summary: string; data?: unknown; file?: string }
export interface Finding {
  id: string; key: string; type: FindingType; subject: string; subjectName: string; title: string; severity: 'high' | 'medium' | 'low';
  status: Status; source: 'check' | 'investigator'; evidence: Evidence[]; rationale: string;
  verification?: { status: Status; method: string; notes: string[] };
  repairPrompt?: string; repairStatus: 'untested';
}
export interface Unresolved { id: string; type: 'unknown_third_party' | 'uninspected_store_badge' | 'probe_error' | 'no_consent_control' | 'visual_review' | 'brand_layout_review' | 'vendor_rule_review'; subject: string; summary: string; data: unknown }

export function registrable(host: string) {
  const h = host.replace(/:\d+$/, '');
  if (/^(localhost|127\.0\.0\.1)$/.test(h)) return h;
  const p = h.split('.');
  return p.length > 2 && p[p.length - 2].length <= 3 && p[p.length - 1].length === 2 ? p.slice(-3).join('.') : p.slice(-2).join('.');
}

function assetName(a: AssetInstance): string {
  try { return decodeURIComponent(new URL(a.imageUrl).pathname.split('/').pop() ?? ''); }
  catch { return a.imageUrl.split('/').pop() ?? ''; }
}

export function isQrAsset(a: AssetInstance): boolean {
  return /(?:^|[^a-z])qr(?:[^a-z]|$)|qrcode|qr.code|scan to download/i.test(`${assetName(a)} ${a.label ?? ''}`);
}

export function assetsForStoreLink(link: StoreLink, assets: AssetInstance[]): AssetInstance[] {
  return assets.filter((a) => typeof a.selector === 'string' && (a.selector === link.selector || a.selector.startsWith(`${link.selector} > `)));
}
/** Shared coverage rule used by audits and paired transfer observations. */
export function uninspectedStoreLinks(links:StoreLink[],assets:AssetInstance[],brain:BrainVersion,observations:import('./text-links.ts').StoreLinkObservation[]=[]){
 const covered=new Set(assets.filter(a=>brandForAsset(a,brain)).map(a=>a.href));
 return links.filter(link=>{const matched=assetsForStoreLink(link,assets);if(matched.length&&matched.every(isQrAsset))return false;if(covered.has(link.href))return false;if(link.text&&link.width*link.height<1500)return false;if(observations.some(o=>o.verified&&o.kind==='text-only'&&o.selector===link.selector&&o.href===link.href))return false;return true;});
}


export function brandForAsset(a: AssetInstance, brain: BrainVersion): BrandRule | null {
  if (isQrAsset(a)) return null;
  if (a.href) {
    try { const h = new URL(a.href).host; const b = brain.brands.find((x) => x.linkHosts.some((d) => hostMatches(h, d))); if (b) return b; } catch { /* */ }
  }
  // An App Store screenshot directory is not evidence that the image is a badge.
  const hay = `${assetName(a)} ${a.label ?? ''}`.toLowerCase();
  return brain.brands.find((b) => b.assetHints.some((k) => hay.includes(k))) ?? null;
}

export function measureAsset(a: AssetInstance, b: BrandRule) {
  const natural = a.naturalW / a.naturalH, drawn = a.drawnW / a.drawnH;
  const deviation = drawn / natural - 1;
  const problems: string[] = [];
  if (Number.isFinite(deviation) && Math.abs(deviation) > b.maxAspectDeviation)
    problems.push(`${deviation > 0 ? 'stretched horizontally' : 'squashed horizontally'}: drawn aspect ${drawn.toFixed(2)} vs artwork ${natural.toFixed(2)} (${(deviation * 100).toFixed(0)}%)`);
  if (b.prohibitFilters && a.filter && a.filter !== 'none') problems.push(`CSS filter applied (${a.filter}) — recolors the artwork`);
  if (b.prohibitRotation && a.transform && a.transform !== 'none') {
    const m = a.transform.match(/matrix\(([^)]+)\)/);
    const v = m ? m[1].split(',').map(Number) : [];
    if (v.length === 6 && (Math.abs(v[1]) > 1e-3 || Math.abs(v[2]) > 1e-3)) problems.push(`rotated or skewed (${a.transform})`);
    else if (v.length === 6 && Math.abs(Math.abs(v[0]) / Math.abs(v[3]) - 1) > b.maxAspectDeviation) problems.push(`non-uniform scale transform (${a.transform})`);
  }
  return { natural, drawn, deviation, problems };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

type ThirdPartyRequest = ScanResult['requests'][number];
const phaseLabel = (r: ThirdPartyRequest) => r.phase === 'pre' ? 'before consent' : 'after consent';
const requestEvidence = (r: ThirdPartyRequest) => ({ summary: `[${phaseLabel(r)}] ${r.type} ${r.url.slice(0, 140)}`, type: r.type, url: r.url, phase: r.phase, host: r.host });
const timing = (rs: ThirdPartyRequest[]) => ({ beforeConsent: rs.filter((r) => r.phase === 'pre').length, afterConsent: rs.filter((r) => r.phase === 'post').length });

/** Human-readable list of the services behind third-party traffic, recognized vendors first. */
export function serviceList(byVendor: Map<string, { v: Vendor; reqs: ThirdPartyRequest[] }>, unknown: Map<string, ThirdPartyRequest[]>): string {
  const names = [...[...byVendor.values()].map(({ v }) => v.name), ...[...unknown.keys()].map((d) => `${d} (unrecognized)`)];
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** Evidence naming every third party that loaded: one summary note, then one item per vendor or unrecognized domain. */
export function thirdPartyServiceEvidence(byVendor: Map<string, { v: Vendor; reqs: ThirdPartyRequest[] }>, unknown: Map<string, ThirdPartyRequest[]>): Evidence[] {
  const total = [...byVendor.values()].reduce((n, e) => n + e.reqs.length, 0) + [...unknown.values()].reduce((n, rs) => n + rs.length, 0);
  const services = byVendor.size + unknown.size;
  const names = [...[...byVendor.values()].map(({ v }) => v.name), ...[...unknown.keys()].map((d) => `${d} (unrecognized)`)];
  const summary: Evidence = { kind: 'note', summary: `${total} third-party request${total === 1 ? '' : 's'} to ${services} service${services === 1 ? '' : 's'}: ${names.join(', ')}. No privacy policy link was found or it could not be read.`, data: { requestCount: total, serviceCount: services, services: names } };
  const vendors: Evidence[] = [...byVendor.values()].map(({ v, reqs }) => {
    const t = timing(reqs);
    return { kind: 'service', summary: `${v.name} (${v.category}): ${reqs.length} request${reqs.length === 1 ? '' : 's'}${t.beforeConsent ? `, ${t.beforeConsent} before consent` : ', none before consent'}. Collects ${v.collects.join(', ')}.`,
      data: { recognized: true, vendorId: v.id, name: v.name, category: v.category, collects: v.collects, requestCount: reqs.length, ...timing(reqs), firedBeforeConsent: t.beforeConsent > 0, hosts: [...new Set(reqs.map((r) => r.host))], requests: reqs.slice(0, 8).map(requestEvidence) } };
  });
  const domains: Evidence[] = [...unknown].map(([dom, reqs]) => {
    const t = timing(reqs);
    return { kind: 'service', summary: `${dom} (unrecognized): ${reqs.length} request${reqs.length === 1 ? '' : 's'}${t.beforeConsent ? `, ${t.beforeConsent} before consent` : ', none before consent'}. The vendor is not in the shared brain, so what it collects is unknown.`,
      data: { recognized: false, name: dom, requestCount: reqs.length, ...t, firedBeforeConsent: t.beforeConsent > 0, hosts: [...new Set(reqs.map((r) => r.host))], urls: reqs.slice(0, 5).map((r) => r.url), requests: reqs.slice(0, 8).map(requestEvidence) } };
  });
  return [summary, ...vendors, ...domains];
}

export function runChecks(scan: ScanResult, brain: BrainVersion): { findings: Finding[]; unresolved: Unresolved[] } {
  const findings: Finding[] = []; const unresolved: Unresolved[] = [];
  const first = registrable(scan.host);
  const third = scan.requests.filter((r) => registrable(r.host) !== first);

  // Group third-party requests by vendor
  const byVendor = new Map<string, { v: Vendor; reqs: typeof third }>();
  const unknown = new Map<string, typeof third>();
  for (const r of third) {
    const v = classifyHost(r.host, brain);
    if (v) { const e = byVendor.get(v.id) ?? { v, reqs: [] }; e.reqs.push(r); byVendor.set(v.id, e); }
    else { const k = registrable(r.host); unknown.set(k, [...(unknown.get(k) ?? []), r]); }
  }

  const policy = (scan.policy.text ?? '').toLowerCase();
  if (third.length && !scan.policy.text) {
    findings.push(mk('missing_privacy_policy', 'site', 'Site', 'No privacy policy found while third parties are loaded', 'high', thirdPartyServiceEvidence(byVendor, unknown),
      `Third-party data collection without any reachable privacy policy. The site loads ${serviceList(byVendor, unknown)}, and none of them is disclosed to visitors.`));
  }

  for (const { v, reqs } of byVendor.values()) {
    const pre = reqs.filter((r) => r.phase === 'pre');
    const reqEv = (rs: typeof reqs) => rs.slice(0, 4).map((r) => ({ kind: 'request' as const, summary: `[${r.phase === 'pre' ? 'before consent' : 'after consent'}] ${r.type} ${r.url.slice(0, 140)}`, data: r }));
    if (v.requiresConsent && pre.length) {
      findings.push(mk('pre_consent_tracking', v.id, v.name, `${v.name} loads before the visitor gives consent`, 'high', [
        ...reqEv(pre),
        { kind: 'consent', summary: scan.consent.found ? `Consent control "${scan.consent.text}" existed but had not been clicked yet` : 'No consent control was found on the page' },
        { kind: 'screenshot', summary: 'Page state before any interaction', file: scan.screenshots.pre },
      ], `${v.name} (${v.category}) collects ${v.collects.join(', ')}. It requested ${pre.length} resource(s) before any consent interaction.`));
    }
    if (scan.policy.text) {
      const names = vendorPolicyNames(v);
      const hit = names.find((k) => policy.includes(k));
      if (!hit) {
        findings.push(mk('undisclosed_vendor', v.id, v.name, `${v.name} is used but not named in the privacy policy`, 'medium', [
          ...reqEv(reqs),
          { kind: 'policy', summary: `Policy at ${scan.policy.url} does not mention any of: ${names.join(', ')}`, data: { url: scan.policy.url, searched: names } },
          ...(v.consentRationale ? [{ kind: 'note' as const, summary: v.consentRationale }] : []),
        ], `${v.name} (${v.category}) collects ${v.collects.join(', ')} and is not disclosed by name.`));
      }
    }
  }

  for (const [dom, reqs] of unknown) {
    unresolved.push({ id: `u-${slug(dom)}`, type: 'unknown_third_party', subject: dom,
      summary: `${reqs.length} request(s) to ${dom} (${[...new Set(reqs.map((r) => r.host))].join(', ')}) — vendor not in the shared brain${reqs.some((r) => r.phase === 'pre') ? '; fired before consent' : ''}`,
      data: { requestCount:reqs.length, beforeConsent:reqs.filter(r=>r.phase==='pre').length, afterConsent:reqs.filter(r=>r.phase==='post').length, hosts: [...new Set(reqs.map((r) => r.host))], urls: reqs.slice(0, 5).map((r) => r.url), phases: [...new Set(reqs.map((r) => r.phase))] } });
  }

  // Brand assets
  for (const a of scan.assets) {
    const b = brandForAsset(a, brain); if (!b) continue;
    const m = measureAsset(a, b);
    if (!m.problems.length) continue;
    findings.push(mk('badge_misuse', b.id, b.name, `${b.name} artwork is altered (${m.problems.length} problem${m.problems.length > 1 ? 's' : ''})`, 'medium', [
      { kind: 'asset', summary: `${a.selector} via ${a.technique} probe: artwork ${a.naturalW}×${a.naturalH}, drawn ${a.drawnW.toFixed(0)}×${a.drawnH.toFixed(0)}`, data: a, file: a.shot },
      ...m.problems.map((p) => ({ kind: 'note' as const, summary: p })),
      { kind: 'note', summary: b.guidance, data: b.sources },
    ], m.problems.join('; ')));
  }
  for (const l of uninspectedStoreLinks(scan.storeLinks,scan.assets,brain,scan.storeLinkObservations)) {
    unresolved.push({ id: `s-${slug(l.selector)}`, type: 'uninspected_store_badge', subject: l.host,
      summary: `Store link ${l.selector} (${l.width.toFixed(0)}×${l.height.toFixed(0)}) shows something, but no probe could measure its artwork`, data: l satisfies StoreLink });
  }
  for (const e of scan.probeErrors) unresolved.push({ id: `p-${e.probe}`, type: 'probe_error', subject: e.probe, summary: e.error, data: e });
  if (!scan.consent.found && third.some((r) => classifyHost(r.host, brain)?.requiresConsent))
    unresolved.push({ id: 'no-consent', type: 'no_consent_control', subject: 'consent', summary: 'Consent-requiring vendors present but no consent control found', data: null });

  for(const layout of scan.layouts??[])if(layout.status==='measured_review')unresolved.push({id:`layout-${slug(layout.selector)}`,type:'brand_layout_review',subject:layout.brand,summary:`App Store badge ${layout.measuredHeight<layout.minimumHeight-.5?'size and spacing':'clear space'} needs review`,data:layout});
  return { findings: dedupe(findings), unresolved };
}

function mk(type: FindingType, subject: string, subjectName: string, title: string, severity: Finding['severity'], evidence: Evidence[], rationale: string): Finding {
  const key = `${type}:${subject}`;
  return { id: `f-${slug(key)}`, key, type, subject, subjectName, title, severity, status: 'candidate', source: 'check', evidence, rationale, repairStatus: 'untested' };
}

function dedupe(fs: Finding[]) {
  const m = new Map<string, Finding>();
  for (const f of fs) { const e = m.get(f.key); if (e) e.evidence.push(...f.evidence); else m.set(f.key, f); }
  return [...m.values()];
}
