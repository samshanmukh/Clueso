import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../settings.ts';
import { YouClient } from '../providers/you.ts';
import { fetchAsset } from '../tools/assets.ts';
import { validatePublicUrl, assertAllowedHost } from '../tools/network.ts';
import { getBrowser } from '../scan/scanner.ts';

// Host-controlled trust roots. A model or search result cannot add asset hosts.
export const referenceCatalog: Record<string, { page: string; hosts: string[]; asset?: string }> = {
  'apple-app-store-badge': {
    page: 'https://developer.apple.com/app-store/marketing/guidelines/', hosts: ['developer.apple.com'],
    asset: 'https://developer.apple.com/assets/elements/badges/download-on-the-app-store.svg',
  },
  'google-play-badge': {
    page: 'https://partnermarketinghub.withgoogle.com/brands/google-play/google-play/lockups-icons-badges/',
    hosts: ['partnermarketinghub.withgoogle.com', 'storage.googleapis.com'],
  },
};
export interface OfficialReference {
  brand: string; pageUrl: string; assetUrl: string; sha256: string; retrievedAt: string;
  imagePath: string; width: number; height: number; provenance: 'linked_from_official_page';
  guidelineText: string; searchUrls: string[];
  referenceKind: 'downloadable_artwork' | 'official_page_example';
}

export async function officialPage(url: string, hosts: string[], json = false): Promise<{ text: string; url: string }> {
  for (let i = 0; i < 5; i++) {
    const parsed = await validatePublicUrl(url);
    assertAllowedHost(parsed, hosts);
    if (parsed.protocol !== 'https:') throw new Error('Official pages require HTTPS');
    const r = await fetch(parsed, { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
    if ([301,302,303,307,308].includes(r.status)) {
      const loc = r.headers.get('location'); await r.body?.cancel();
      if (!loc) throw new Error('Official page redirect has no location');
      url = new URL(loc, parsed).href; continue;
    }
    if (!r.ok || !(json ? /application\/json/i : /text\/html/i).test(r.headers.get('content-type') ?? '')) { await r.body?.cancel(); throw new Error(`Official page unavailable (${r.status})`); }
    const reader = r.body!.getReader(); const chunks: Uint8Array[] = []; let n = 0;
    try {
      while (true) { const { value, done } = await reader.read(); if (done) break; n += value.length; if (n > 2_000_000) throw new Error('Official page exceeds size limit'); chunks.push(value); }
    } finally { await reader.cancel(); }
    return { text: Buffer.concat(chunks).toString(), url: parsed.href };
  }
  throw new Error('Official page redirect limit');
}

export function linkedAssets(html: string, page: string, hosts: string[]): string[] {
  const urls: string[] = [];
  for (const match of html.matchAll(/(?:src|href|data-src)\s*=\s*["']([^"']+)["']/gi)) {
    try {
      const u = new URL(match[1].replaceAll('&amp;', '&'), page);
      if (u.protocol === 'https:' && hosts.includes(u.hostname) && /\.(png|svg|webp|jpe?g)$/i.test(u.pathname)) urls.push(u.href);
    } catch { /* invalid source link */ }
  }
  return [...new Set(urls)];
}

export async function rasterizeReference(bytes: Buffer, mime: string, destination: string) {
  const ctx = await (await getBrowser()).newContext({ serviceWorkers: 'block' });
  try {
    await ctx.route('**/*', (r) => r.abort());
    const page = await ctx.newPage();
    await page.setContent(`<body style="margin:0;background:white"><img id="ref" src="data:${mime};base64,${bytes.toString('base64')}" style="width:360px;height:auto">`);
    await page.locator('#ref').evaluate((el: HTMLImageElement) => el.decode());
    const dimensions = await page.locator('#ref').evaluate((el: HTMLImageElement) => ({ width: el.naturalWidth, height: el.naturalHeight }));
    if (!dimensions.width || !dimensions.height) throw new Error('Reference has no image dimensions');
    await page.locator('#ref').screenshot({ path: destination });
    return dimensions;
  } finally { await ctx.close(); }
}

export async function resolveOfficialReference(brand: string): Promise<OfficialReference> {
  const spec = referenceCatalog[brand];
  if (!spec) throw new Error('No approved official reference for this brand');
  const root = path.join(config.dataDir, 'official-references');
  await fs.mkdir(root, { recursive: true });
  const cache = path.join(root, `${brand}.json`);
  try {
    const prior: OfficialReference = JSON.parse(await fs.readFile(cache, 'utf8'));
    if (Date.now() - Date.parse(prior.retrievedAt) < 86_400_000 && Date.now() >= Date.parse(prior.retrievedAt)) {
      const bytes = await fs.readFile(prior.imagePath);
      if (bytes.length && prior.referenceKind) return prior;
    }
  } catch { /* missing or stale cache */ }
  const you = new YouClient(config);
  const search = await you.search(`${brand.replaceAll('-', ' ')} official artwork guidelines`, { count: 3, includeDomains: [new URL(spec.page).hostname] });
  const [page] = await you.contents([spec.page], { maxAge: 0 });
  if (!page?.markdown) throw new Error('Official guideline text could not be retrieved');
  const html = await officialPage(spec.page, spec.hosts);
  const links = linkedAssets(html.text, html.url, spec.hosts);
  if (brand === 'google-play-badge' && !links.some((u) => /badge/i.test(new URL(u).pathname))) {
    // Google currently resolves responsive badge images through a first-party JSON endpoint.
    const section = html.text.slice(html.text.indexOf('id="badges"'));
    const endpoint = section.match(/data-asset-endpoint="([^"]+)"/)?.[1];
    if (endpoint) {
      const resolved = await officialPage(new URL(endpoint.replaceAll('&amp;', '&'), html.url).href, spec.hosts, true);
      function collect(v: unknown) {
        if (typeof v === 'string') {
          try { const u = new URL(v); if (spec.hosts.includes(u.hostname) && u.protocol === 'https:' && /\.(png|svg|webp)$/i.test(u.pathname)) links.push(u.href); } catch { /* non-URL metadata */ }
        } else if (Array.isArray(v)) v.forEach(collect);
        else if (v && typeof v === 'object') Object.values(v).forEach(collect);
      }
      collect(JSON.parse(resolved.text));
    }
  }
  const assetUrl = spec.asset && links.includes(spec.asset) ? spec.asset
    : !spec.asset ? links.find((u) => /badge/i.test(new URL(u).pathname) && !/dont|avoid|pre.?register/i.test(new URL(u).pathname)) : undefined;
  if (!assetUrl) throw new Error('No supported badge image linked from the official page; reference remains unresolved');
  const asset = await fetchAsset(assetUrl, { allowedHosts: spec.hosts, artifactRoot: root });
  const imagePath = path.join(root, `${brand}.png`);
  const dims = await rasterizeReference(await fs.readFile(asset.path), asset.contentType, imagePath);
  const result: OfficialReference = { brand, pageUrl: html.url, assetUrl, sha256: asset.sha256, retrievedAt: asset.retrievedAt,
    imagePath, ...dims, provenance: 'linked_from_official_page', referenceKind: spec.asset ? 'downloadable_artwork' : 'official_page_example', guidelineText: page.markdown.slice(0, 30_000), searchUrls: search.results.map((r) => r.url) };
  await fs.writeFile(cache, JSON.stringify(result, null, 2));
  return result;
}
