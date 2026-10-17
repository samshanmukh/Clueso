import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page, type Locator } from 'playwright';
import type { BrainVersion, Probe } from '../brain/store.ts';
import { emit } from '../events.ts';
import { measureBrandLayout, type LayoutAssessment } from '../checks/brand-layout.ts';
import { validatePublicUrl } from '../tools/network.ts';

export interface NetRequest { id: string; url: string; host: string; phase: 'pre' | 'post'; type: string; t: number }
export interface AssetInstance {
  probe: string; technique: string; selector: string; href: string | null; imageUrl: string;
  naturalW: number; naturalH: number; drawnW: number; drawnH: number; boxW?: number; boxH?: number;
  filter?: string; transform?: string; label?: string; shot?: string; contextShot?: string;
  bounds?: { x: number; y: number; width: number; height: number; viewportWidth: number; viewportHeight: number };
}
export interface StoreLink { selector: string; href: string; host: string; text: string; width: number; height: number; html: string; styles: Record<string, string>[]; shot?: string; contextShot?: string; bounds?: AssetInstance['bounds'] }
export interface ScanResult {
  url: string; host: string; startedAt: string; ms: number; artifactsDir: string;
  requests: NetRequest[];
  consent: { found: boolean; text?: string; selector?: string; clicked: boolean };
  policy: { url: string | null; text: string | null };
  assets: AssetInstance[]; probeErrors: { probe: string; error: string }[];
  storeLinks: StoreLink[];
  layouts?: LayoutAssessment[];
  screenshots: { pre?: string; post?: string };
  stubbedThirdParties: boolean;
}

/** Helpers available to every probe as window.__lp */
const HELPERS = `
window.__lp = {
  path(el) {
    if (!(el instanceof Element)) return '';
    const parts = [];
    while (el && el.nodeType === 1 && parts.length < 50) {
      let s = el.tagName.toLowerCase();
      if (el.id) { parts.unshift(s + '#' + CSS.escape(el.id)); break; }
      const p = el.parentElement;
      if (p) { const sib = [...p.children].filter(c => c.tagName === el.tagName); if (sib.length > 1) s += ':nth-of-type(' + (sib.indexOf(el) + 1) + ')'; }
      parts.unshift(s); el = p;
    }
    return parts.join(' > ');
  },
  linkOf(el) { const a = el.closest && el.closest('a[href]'); return a ? a.href : null; },
  abs(u) { try { return new URL(u, location.href).href; } catch { return u; } },
  cssUrl(v) { const m = /url\\(["']?([^"')]+)["']?\\)/.exec(v || ''); return m ? new URL(m[1], location.href).href : null; },
  naturalSize(u) { return new Promise((res) => { const i = new Image(); i.onload = () => res({ w: i.naturalWidth, h: i.naturalHeight }); i.onerror = () => res(null); i.src = u; }); },
};`;

export async function installProbeHelpers(page: Page) { await page.evaluate(HELPERS); }

/** Offline stubs for third-party scripts when auditing local fixture apps (no internet in the sandbox). */
const STUB_BEACONS: [RegExp, string[]][] = [
  [/connect\.facebook\.net/, ['https://www.facebook.com/tr?id=lp&ev=PageView']],
  [/googletagmanager\.com/, ['https://www.google-analytics.com/g/collect?v=2&en=page_view']],
  [/mxpnl\.com/, ['https://api-js.mixpanel.com/track/?ip=1']],
  [/segment\.com/, ['https://api.segment.io/v1/p']],
  [/static\.hotjar\.com/, ['https://script.hotjar.com/modules.8f3e5a1b.js', 'https://vc.hotjar.io/sessions/start']],
];
function stubScript(url: string) {
  const host = new URL(url).host;
  const beacons = STUB_BEACONS.find(([re]) => re.test(url))?.[1] ?? [`https://${host}/collect`];
  return beacons.map((b) => b.endsWith('.js')
    ? `(function(){var s=document.createElement('script');s.src=${JSON.stringify(b)};document.head.appendChild(s);})();`
    : `(function(){var i=new Image();i.src=${JSON.stringify(b)};})();`).join('\n');
}
const GIF = Buffer.from('R0lGODlhAQABAAAAACw=', 'base64');

let browserP: Promise<Browser> | null = null;
export function getBrowser() { return (browserP ??= chromium.launch({ headless: true })); }
export async function closeBrowser() { if (browserP) { const b = await browserP; browserP = null; await b.close(); } }

const fixtureOrigins = new Set<string>();
export function registerFixtureOrigin(base: string) {
  const u = new URL(base);
  fixtureOrigins.add(u.origin);
  for (const host of ['localhost', '127.0.0.1']) { u.hostname = host; fixtureOrigins.add(u.origin); }
}
export function isFixtureTarget(input: string) {
  const u = new URL(input);
  return fixtureOrigins.has(u.origin) && /^\/fixtures\/app-[a-z]\//.test(u.pathname);
}

export async function newAuditContext(targetUrl: string): Promise<{ ctx: BrowserContext; stubbed: boolean }> {
  const target = new URL(targetUrl);
  const stubbed = isFixtureTarget(targetUrl);
  if (!stubbed) await validatePublicUrl(targetUrl);
  const browser = await getBrowser();
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 800 }, userAgent: 'Mozilla/5.0 CluesoAuditor/0.1 Chrome/140 Safari/537.36' });
  ctx.setDefaultNavigationTimeout(30_000);
  await ctx.routeWebSocket('**/*', (socket) => socket.close());
  if (stubbed) {
    await ctx.route('**/*', (route) => {
      const u = new URL(route.request().url());
      if (u.origin === target.origin && /^\/fixtures\/app-[a-z]\//.test(u.pathname)) return route.continue();
      if (u.protocol === 'data:') return route.continue();
      const t = route.request().resourceType();
      if (t === 'script') return route.fulfill({ status: 200, contentType: 'text/javascript', body: stubScript(u.href) });
      return route.fulfill({ status: 200, contentType: 'image/gif', body: GIF });
    });
  } else {
    await ctx.route('**/*', async (route) => {
      try { await validatePublicUrl(route.request().url()); await route.continue(); }
      catch { await route.abort('blockedbyclient'); }
    });
  }
  await ctx.addInitScript(HELPERS);
  return { ctx, stubbed };
}

export async function runProbe(page: Page, probe: Probe, timeoutMs = 5000): Promise<AssetInstance[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    page.evaluate(async (code) => {
      // eslint-disable-next-line no-new-func
      const fn = new Function(`return (async () => {\n${code}\n})();`);
      const r = await fn();
      return Array.isArray(r) ? r : [];
    }, probe.code),
    new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`probe timed out after ${timeoutMs} ms`)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
  return (result as any[]).filter((a) => a && typeof a === 'object').map((a) => ({
    probe: probe.id, technique: String(a.technique ?? probe.id), selector: String(a.selector ?? ''), href: a.href ?? null,
    imageUrl: String(a.imageUrl ?? ''), naturalW: Number(a.naturalW), naturalH: Number(a.naturalH), drawnW: Number(a.drawnW), drawnH: Number(a.drawnH),
    boxW: a.boxW, boxH: a.boxH, filter: a.filter ?? 'none', transform: a.transform ?? 'none', label: a.label ?? '',
  }));
}

export async function settle(page: Page, ms = 4000) {
  await page.waitForLoadState('networkidle', { timeout: ms }).catch(() => {});
  await page.waitForTimeout(300);
}

/** Capture from a fresh scroll position; scroll-responsive headers may hide after earlier crops. */
export async function captureEvidence(page: Page, element: Locator, destination: string) {
  const position = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
  try {
    await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
    await element.scrollIntoViewIfNeeded({ timeout: 3000 });
    await element.evaluate(async (el) => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const images = el instanceof HTMLImageElement ? [el] : [...el.querySelectorAll('img')];
      await Promise.race([
        Promise.all(images.map((img) => img.decode().catch(() => {}))),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
    });
    await page.waitForFunction((el) => {
      if (!el?.isConnected) return false;
      for (let node: Element | null = el; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.99) return false;
      }
      const images = el instanceof HTMLImageElement ? [el] : [...el.querySelectorAll('img')];
      return images.every((img) => img.complete && img.naturalWidth > 0);
    }, await element.elementHandle(), { timeout: 2500 });
    await element.screenshot({ path: destination, timeout: 3000, animations: 'disabled' });
  } finally {
    await page.evaluate(({ x, y }) => window.scrollTo({ left: x, top: y, behavior: 'instant' }), position);
  }
}

/** Save a viewport and its element coordinates together; restore the audit scroll position. */
async function captureLocation(page: Page, selector: string, destination: string) {
  const position=await page.evaluate(()=>({x:scrollX,y:scrollY}));
  try {
    const element=page.locator(selector).first();
    await element.scrollIntoViewIfNeeded({timeout:2000});
    const box=await element.boundingBox(),vp=page.viewportSize();
    if(!box||!vp||box.width<=0||box.height<=0)return;
    await page.screenshot({path:destination,timeout:3000});
    return {...box,viewportWidth:vp.width,viewportHeight:vp.height};
  } finally {await page.evaluate(({x,y})=>scrollTo({left:x,top:y,behavior:'instant'}),position);}
}

/** Preview coordinates refer to the same viewport as the captured image. */
async function publishPreview(page: Page, url: string, file: string, job?: string) {
  const viewport = page.viewportSize();
  if (!viewport) return;
  const targets = await page.evaluate(() => {
    const targets: { selector: string; label: string; x: number; y: number; width: number; height: number }[] = [];
    const seen = new Set<Element>();
    for (const element of document.querySelectorAll('a[href], button, [role="button"], input, img, svg')) {
      const el = element.closest('a[href], button, [role="button"]') ?? element;
      if (seen.has(el)) continue;
      seen.add(el);
      const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
      if (rect.width < 8 || rect.height < 8 || rect.right <= 0 || rect.bottom <= 0 || rect.left >= innerWidth || rect.top >= innerHeight || style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
      const x = Math.max(0, rect.x), y = Math.max(0, rect.y);
      const name = el.getAttribute('aria-label') || el.getAttribute('alt') || (el as HTMLElement).innerText || el.tagName.toLowerCase();
      targets.push({ selector: (window as any).__lp.path(el), label: name.trim().replace(/\s+/g, ' ').slice(0, 70), x, y, width: Math.min(innerWidth, rect.right) - x, height: Math.min(innerHeight, rect.bottom) - y });
      if (targets.length >= 24) break;
    }
    return targets;
  });
  emit('scanner', 'step', 'Website preview captured; reviewing visible components', { preview: { url, file, width: viewport.width, height: viewport.height, targets } }, job);
}

export async function scan(url: string, brain: BrainVersion, artifactsDir: string, job?: string): Promise<ScanResult> {
  const t0 = Date.now();
  fs.mkdirSync(artifactsDir, { recursive: true });
  const { ctx, stubbed } = await newAuditContext(url);
  try {
  const page = await ctx.newPage();
  const requests: NetRequest[] = [];
  let phase: 'pre' | 'post' = 'pre';
  page.on('request', (r) => {
    try { const u = new URL(r.url()); if (u.protocol.startsWith('http')) requests.push({ id: `r${requests.length + 1}`, url: r.url(), host: u.host, phase, type: r.resourceType(), t: Date.now() - t0 }); } catch { /* ignore */ }
  });

  emit('scanner', 'step', `Opening ${url}${stubbed ? ' (local fixture: third-party scripts stubbed offline)' : ''}`, undefined, job);
  // Media-heavy public sites can keep the load event pending indefinitely.
  // Inspect the DOM after a bounded settling period instead.
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  // Show the new site before slow analytics/media and the final report finish.
  try {
    await page.screenshot({ path: path.join(artifactsDir, 'opening.png'), timeout: 3000 });
    await publishPreview(page, url, 'opening.png', job);
  } catch { /* A loading preview must never make the audit fail. */ }
  await settle(page);
  const shots: ScanResult['screenshots'] = {};
  shots.pre = 'pre.png'; await page.screenshot({ path: path.join(artifactsDir, shots.pre) });
  await publishPreview(page, url, shots.pre, job).catch(() => {});

  // Capture/decode store artwork before measuring it. Lazy-loaded images may still
  // have naturalWidth=0 immediately after DOM readiness.
  const linkHosts = brain.brands.flatMap((b) => b.linkHosts);
  const storeLinks: StoreLink[] = await page.evaluate((hosts) => {
    const out: any[] = [];
    for (const a of Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[]) {
      let host = ''; try { host = new URL(a.href).host; } catch { continue; }
      if (!hosts.some((h: string) => host === h || host.endsWith('.' + h))) continue;
      const r = a.getBoundingClientRect();
      const els = [a, ...Array.from(a.querySelectorAll('*'))].slice(0, 6);
      const styles = els.map((el) => {
        const cs = getComputedStyle(el); const b = getComputedStyle(el, '::before'); const af = getComputedStyle(el, '::after');
        return { selector: (window as any).__lp.path(el), tag: el.tagName.toLowerCase(), display: cs.display, width: cs.width, height: cs.height,
          backgroundImage: cs.backgroundImage, backgroundSize: cs.backgroundSize, backgroundPosition: cs.backgroundPosition, backgroundRepeat: cs.backgroundRepeat,
          maskImage: (cs as any).maskImage || (cs as any).webkitMaskImage || 'none', filter: cs.filter, transform: cs.transform,
          beforeBackground: b.backgroundImage, afterBackground: af.backgroundImage };
      });
      out.push({ selector: (window as any).__lp.path(a), href: a.href, host, text: (a.innerText || '').trim().slice(0, 80), width: r.width, height: r.height,
        html: a.outerHTML.slice(0, 1200), styles });
    }
    return out;
  }, linkHosts);
  for (const [i, link] of storeLinks.slice(0, 6).entries()) {
    try {
      const file = `store-link-${i + 1}.png`;
      await captureEvidence(page, page.locator(link.selector).first(), path.join(artifactsDir, file));
      link.shot = file;
      const contextShot=`store-context-${i+1}.png`;
      const bounds=await captureLocation(page,link.selector,path.join(artifactsDir,contextShot));
      if(bounds){link.bounds=bounds;link.contextShot=contextShot;}
    } catch { /* visible crops only; missing evidence stays unresolved */ }
  }

  // Inspection probes (registry snapshot pinned to this brain version)
  const assets: AssetInstance[] = []; const probeErrors: ScanResult['probeErrors'] = [];
  for (const p of brain.probes) {
    try { const a = await runProbe(page, p); assets.push(...a); emit('scanner', 'step', `Probe ${p.id}: ${a.length} asset instance(s)`, undefined, job); }
    catch (e: any) { probeErrors.push({ probe: p.id, error: String(e?.message ?? e) }); emit('scanner', 'warn', `Probe ${p.id} failed: ${e?.message ?? e}`, undefined, job); }
  }
  // Element screenshots of measured assets that sit inside store links (evidence crops)
  for (const a of assets.filter((a) => a.href).slice(0, 8)) {
    try {
      const file=`asset-context-${assets.indexOf(a)+1}.png`;
      const bounds=await captureLocation(page,a.selector,path.join(artifactsDir,file));
      if(bounds){a.bounds=bounds;a.contextShot=file;}
    } catch { /* measurements may not have a resolvable selector */ }
  }
  let k = 0;
  for (const a of assets) {
    if (!a.href || k >= 8) continue;
    try {
      const element = page.locator(a.selector).first();
      const f = `asset-${++k}.png`; await captureEvidence(page, element, path.join(artifactsDir, f)); a.shot = f;
    } catch { /* best effort */ }
  }

  const layouts=await measureBrandLayout(page,assets);

  // Consent: find an accept-style control and click it
  const consent: ScanResult['consent'] = { found: false, clicked: false };
  const marked = await page.evaluate(() => {
    const re = /^\s*(accept( all)?( cookies)?|i agree|agree|allow( all)?|ok(ay)?|got it|yes,? i agree)\s*$/i;
    const els = Array.from(document.querySelectorAll('button, [role=button], a, input[type=button], input[type=submit]')) as HTMLElement[];
    for (const el of els) {
      const txt = (el as HTMLInputElement).value || el.innerText || '';
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && re.test(txt)) { el.setAttribute('data-lp-consent', '1'); return { text: txt.trim(), selector: (window as any).__lp.path(el) }; }
    }
    return null;
  });
  if (marked) {
    consent.found = true; consent.text = marked.text; consent.selector = marked.selector;
    phase = 'post';
    await page.click('[data-lp-consent="1"]', { timeout: 3000 }).then(() => { consent.clicked = true; }).catch(() => {});
    await settle(page);
    shots.post = 'post.png'; await page.screenshot({ path: path.join(artifactsDir, shots.post) });
    await publishPreview(page, url, shots.post, job).catch(() => {});
    emit('scanner', 'step', `Consent control "${marked.text}" clicked`, undefined, job);
  } else {
    emit('scanner', 'step', 'No consent control found', undefined, job);
  }

  // Privacy policy text
  const policy: ScanResult['policy'] = { url: null, text: null };
  const policyHref = await page.evaluate(() => {
    const a = (Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[]).find((x) => /privacy/i.test(x.innerText) || /privacy/i.test(x.getAttribute('href') || ''));
    return a ? a.href : null;
  });
  if (policyHref) {
    const pp = await ctx.newPage();
    try { await pp.goto(policyHref, { waitUntil: 'domcontentloaded', timeout: 20_000 }); await settle(pp); policy.url = policyHref; policy.text = (await pp.innerText('body')).slice(0, 40_000); }
    catch (e: any) { emit('scanner', 'warn', `Could not read privacy policy: ${e?.message ?? e}`, undefined, job); }
    await pp.close();
  }
  emit('scanner', 'step', `Captured ${requests.length} requests, ${assets.length} assets, ${storeLinks.length} store link(s), policy ${policy.url ? 'found' : 'missing'}`, undefined, job);

  const result: ScanResult = { url, host: new URL(url).host, startedAt: new Date(t0).toISOString(), ms: Date.now() - t0, artifactsDir,
    requests, consent, policy, assets, probeErrors, storeLinks, layouts, screenshots: shots, stubbedThirdParties: stubbed };
  fs.writeFileSync(path.join(artifactsDir, 'scan.json'), JSON.stringify(result, null, 2));
  return result;
  } finally { await ctx.close(); }
}
