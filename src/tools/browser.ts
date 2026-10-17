import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validatePublicUrl } from './network.ts';

export async function inspectPage(input: string, options: {
  artifactRoot: string;
  width?: number;
  height?: number;
  allowLocalhost?: boolean;
  timeoutMs?: number;
}) {
  const target = await validatePublicUrl(input, { allowLocalhost: options.allowLocalhost });
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const width = options.width ?? 1440;
    const height = options.height ?? 900;
    if (!Number.isInteger(width) || width < 320 || width > 2560 || !Number.isInteger(height) || height < 320 || height > 1600) throw new Error('Viewport must be 320–2560 pixels wide and 320–1600 pixels high.');
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block', acceptDownloads: false });
    const blockedRequests = new Set<string>();
    const blockedSockets = new Set<string>();
    await context.routeWebSocket(/.*/, (socket) => { blockedSockets.add(new URL(socket.url()).origin); socket.close(); });
    await context.route('**/*', async (route) => {
      const request = route.request();
      try {
        await validatePublicUrl(request.url(), { allowLocalhost: options.allowLocalhost });
        if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) throw new Error('State-changing browser requests are disabled for baseline inspection.');
        await route.continue();
      } catch {
        try { blockedRequests.add(new URL(request.url()).origin); } catch { blockedRequests.add('invalid-url'); }
        await route.abort('blockedbyclient');
      }
    });
    const page = await context.newPage();
    page.setDefaultTimeout(options.timeoutMs ?? 15_000);
    const response = await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs ?? 30_000 });
    await page.waitForTimeout(200);
    const evidence = await page.evaluate(() => {
      const rect = (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
      const selector = (el: Element): string => {
        const segments: string[] = [];
        for (let node: Element | null = el; node && segments.length < 8; node = node.parentElement) {
          if (node.id) { segments.unshift(`#${CSS.escape(node.id)}`); break; }
          const index = node.parentElement ? Array.from(node.parentElement.children).filter((s) => s.tagName === node!.tagName).indexOf(node) + 1 : 1;
          segments.unshift(`${node.localName}:nth-of-type(${index})`);
        }
        return segments.join(' > ');
      };
      const styles = (el: Element) => {
        const s = getComputedStyle(el);
        return { display: s.display, visibility: s.visibility, opacity: s.opacity, transform: s.transform, filter: s.filter, color: s.color, fontFamily: s.fontFamily, fontSize: s.fontSize, backgroundImage: s.backgroundImage, maskImage: s.maskImage, objectFit: s.objectFit, overflow: s.overflow };
      };
      const assets = Array.from(document.querySelectorAll('img, svg, [style]')).slice(0, 250).map((el) => ({
        selector: selector(el), tag: el.localName, rect: rect(el), styles: styles(el),
        source: el instanceof HTMLImageElement ? el.currentSrc || el.src : null,
        naturalSize: el instanceof HTMLImageElement ? { width: el.naturalWidth, height: el.naturalHeight } : null,
        svgUses: Array.from(el.querySelectorAll('use')).map((use) => use.getAttribute('href') || use.getAttribute('xlink:href')),
        ancestors: Array.from((function* () { let parent = el.parentElement; for (let i = 0; parent && i < 5; i++, parent = parent.parentElement) yield parent; })()).map((ancestor) => ({ selector: selector(ancestor), rect: rect(ancestor), styles: styles(ancestor) })),
      }));
      // Also inspect elements styled by stylesheets; masks/backgrounds need not have inline styles.
      const styledAssets = Array.from(document.querySelectorAll('*')).slice(0, 1500).filter((el) => { const s = getComputedStyle(el); return s.maskImage !== 'none' || s.backgroundImage.includes('url('); }).slice(0, 150).map((el) => ({ selector: selector(el), rect: rect(el), styles: styles(el) }));
      const links = Array.from(document.querySelectorAll('a')).slice(0, 150).map((el) => ({ selector: selector(el), href: el.getAttribute('href'), resolvedHref: el.href, text: (el.textContent ?? '').trim().slice(0, 200), ariaLabel: el.getAttribute('aria-label'), rect: rect(el) }));
      const controls = Array.from(document.querySelectorAll('button,input,select,textarea,[role="button"]')).slice(0, 150).map((el) => ({ selector: selector(el), tag: el.localName, text: (el.textContent ?? '').trim().slice(0, 100), ariaLabel: el.getAttribute('aria-label'), tabIndex: (el as HTMLElement).tabIndex, rect: rect(el) }));
      return { title: document.title, url: location.href, viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth, assets, styledAssets, links, controls, limits: { assets: 250, styledScanElements: 1500, styledAssets: 150, links: 150, controls: 150 } };
    });
    const keyboardTrace: { tag: string; id: string; ariaLabel: string | null; text: string }[] = [];
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab');
      keyboardTrace.push(await page.evaluate(() => { const el = document.activeElement; return { tag: el?.localName ?? '', id: el?.id ?? '', ariaLabel: el?.getAttribute('aria-label') ?? null, text: (el?.textContent ?? '').trim().slice(0, 100) }; }));
    }
    const directory = join(options.artifactRoot, 'inspections', randomUUID());
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const screenshotPath = join(directory, 'viewport.png');
    await page.screenshot({ path: screenshotPath, fullPage: false, timeout: 15_000 });
    const result = { ...evidence, status: response?.status(), inspectedAt: new Date().toISOString(), keyboardTrace, blockedOrigins: [...blockedRequests], blockedWebSocketOrigins: [...blockedSockets], screenshotPath, evidencePath: join(directory, 'evidence.json'), limitations: ['Observations are not confirmed compliance findings.', 'Baseline inspection blocks non-read HTTP methods and WebSockets; some apps may require these to render.', 'Element scans and keyboard trace are bounded; coverage is not exhaustive.', 'No source mapping or learned adapters are implemented yet.'] };
    await writeFile(result.evidencePath, JSON.stringify(result, null, 2), { mode: 0o600 });
    return result;
  } finally { await browser.close(); }
}
