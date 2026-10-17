import type { BrainVersion } from '../brain/store.ts';
import type { Finding } from '../checks/checks.ts';
import { emit } from '../events.ts';
import { chatJson, llmAvailable } from '../llm.ts';
import type { AssetInstance } from '../scan/scanner.ts';

/** Deterministic repair prompt — always available, and the floor the model must beat. */
export function templatePrompt(f: Finding, brain: BrainVersion): string {
  const ev = f.evidence.filter((e) => e.kind !== 'screenshot').slice(0, 5).map((e) => `- ${e.summary}`).join('\n');
  const v = brain.vendors.find((x) => x.id === f.subject);
  const b = brain.brands.find((x) => x.id === f.subject);
  const accept = (lines: string[]) => lines.map((l) => `- [ ] ${l}`).join('\n');
  switch (f.type) {
    case 'pre_consent_tracking':
      return `Fix: ${v?.name ?? f.subjectName} loads before the visitor consents.

Evidence (Clueso audit):
${ev}

Change:
1. Find where ${v?.name} is loaded (look for ${v?.domains.join(' / ')} in the HTML head, layout component, tag manager or analytics init file).
2. Do not inject the script or fire any ${v?.name} call on page load. Load it only from the consent "accept" handler, and on later visits only if stored consent is "granted".
3. If the visitor declines or ignores the banner, no request to ${v?.domains.join(' or ')} may happen.

Do not change: page layout, copy, the consent banner's design, or other vendors that already wait for consent.

Acceptance checks:
${accept([`Fresh browser, no clicks: zero network requests to ${v?.domains.join(', ')}`, 'After clicking accept: the vendor loads as before', 'After clicking decline (if present): still zero requests'])}`;
    case 'undisclosed_vendor':
      return `Fix: the privacy policy does not name ${v?.name}, which the site uses.

Evidence (Clueso audit):
${ev}

Change:
1. In the privacy policy page, add ${v?.name} to the section that lists third-party services (create a "Third-party services" section if none exists).
2. Say what it is for (${v?.category}), what it collects (${v?.collects.join(', ')}), and link to ${v?.name}'s own privacy information.
3. Keep the existing wording; only add.

Draft paragraph to adapt (review with whoever owns legal text):
"We use ${v?.name} for ${v?.category}. It may collect ${v?.collects.join(', ')}. ${v?.requiresConsent ? 'It is only enabled after you consent to analytics/advertising cookies.' : ''}"

Acceptance checks:
${accept([`The policy text contains "${v?.name}"`, 'No other policy sections were removed or reworded'])}

Note: this flags a disclosure gap with evidence; it is not legal advice.`;
    case 'missing_privacy_policy':
      return `Fix: the site loads third-party services but has no reachable privacy policy.

Evidence:
${ev}

Change: add a /privacy page linked from the footer of every page, listing each third-party service the site loads and what it collects.

Acceptance checks:
${accept(['A footer link containing "Privacy" opens the policy', 'Every third-party service on the site is named in it'])}`;
    case 'badge_misuse': {
      const a = f.evidence.find((e) => e.kind === 'asset')?.data as AssetInstance | undefined;
      const official = f.evidence.find((e) => e.kind === 'verification' && (e.data as any)?.provenance === 'linked_from_official_page')?.data as { pageUrl: string; assetUrl: string; referenceKind: string } | undefined;
      const h = a ? Math.round(a.drawnH) : 40; const w = a ? Math.round(h * (a.naturalW / a.naturalH)) : 0;
      return `Fix: the ${b?.name ?? f.subjectName} is visually altered.

Evidence (Clueso audit):
${ev}

Change:
1. Locate the element \`${a?.selector}\` (rendered via ${a?.technique}).
2. Render the official artwork at its own aspect ratio: for a height of ${h}px use a width of ${w}px, or set only one dimension (img: height only; CSS background: background-size: contain).
3. Remove any CSS filter, rotation or color change applied to the badge or its parents.
4. Use the unmodified official badge file from the brand's page: ${official?.pageUrl ?? b?.sources[0]?.url ?? ''}${official?.referenceKind === 'downloadable_artwork' ? `\n   Verified artwork URL: ${official.assetUrl}` : ''}

Do not change: the link target, surrounding layout spacing (adjust the container, not the artwork).

Acceptance checks:
${accept([`Drawn aspect ratio within ${Math.round((b?.maxAspectDeviation ?? 0.06) * 100)}% of the artwork (${a ? (a.naturalW / a.naturalH).toFixed(2) : '?'})`, 'Computed filter is "none" and no rotation', 'Badge still links to the same store page'])}`;
    }
  }
}

export async function writeRepairPrompt(f: Finding, brain: BrainVersion, job?: string): Promise<string> {
  const base = templatePrompt(f, brain);
  if (!llmAvailable()) return base;
  try {
    const r = await chatJson<{ prompt: string }>({
      role: 'fixer', maxTokens: 3000,
      messages: [
        { role: 'system', content: 'You write repair prompts that a coding agent (Cursor, Claude Code, Codex, Lovable) will execute on a website codebase. Keep every factual detail from the draft (selectors, domains, numbers, acceptance checks). Make it specific and short. Do not invent file paths. Reply JSON: {"prompt":"..."}' },
        { role: 'user', content: `Finding: ${f.title}\nVerifier notes: ${f.verification?.notes.join(' | ')}\n\nDraft prompt:\n${base}` },
      ],
    }, (j) => (typeof j?.prompt === 'string' && j.prompt.length > 80 ? null : 'prompt missing or too short'));
    // Guard: the model must keep the acceptance checks.
    if (!r.prompt.includes('[ ]')) return base;
    return r.prompt;
  } catch (e: any) {
    emit('fixer', 'warn', `Model prompt failed, using template: ${e?.message ?? e}`, undefined, job);
    return base;
  }
}
