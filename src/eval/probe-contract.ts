import { getBrowser, installProbeHelpers, runProbe } from '../scan/scanner.ts';
import type { Probe } from '../brain/store.ts';

// Development-only measurement specification. No held-out app markup or labels are used.
const cases = [
  { name: 'anchor fill', tag: 'a', w: 240, h: 80, size: '100% 100%', expected: [240,80] },
  { name: 'nested span fill', tag: 'span', w: 320, h: 40, size: '100% 100%', expected: [320,40] },
  { name: 'nested div contain', tag: 'div', w: 200, h: 60, size: 'contain', expected: [180,60] },
  { name: 'nested span cover', tag: 'span', w: 200, h: 80, size: 'cover', expected: [240,80] },
  { name: 'one percentage', tag: 'div', w: 200, h: 80, size: '50%', expected: [100,100/3] },
  { name: 'automatic width', tag: 'span', w: 200, h: 80, size: 'auto 32px', expected: [96,32] },
  { name: 'automatic height', tag: 'div', w: 200, h: 80, size: '180px auto', expected: [180,60] },
  { name: 'content box padding and border', tag: 'span', w: 200, h: 80, size: 'contain', padding: 20, expected: [200,200/3] },
  { name: 'explicit distorted size', tag: 'div', w: 200, h: 80, size: '100px 20px', expected: [100,20] },
];
export const probeContractCases = cases.length;

export async function testProbeContract(probe: Probe): Promise<string[]> {
  const ctx = await (await getBrowser()).newContext({ serviceWorkers: 'block' });
  try {
    await ctx.route('**/*', (r) => r.abort());
    const page = await ctx.newPage();
    const image = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="black"/></svg>').toString('base64');
    const html = cases.map((c, i) => {
      const style = `display:block;width:${c.w}px;height:${c.h}px;background-image:url(${image});background-size:${c.size};background-repeat:no-repeat;${c.padding ? `padding:${c.padding}px;border:5px solid transparent;background-origin:content-box;` : ''}`;
      const element = `<${c.tag} data-case="${i}" ${c.tag === 'a' ? 'href="https://apps.apple.com/app/example"' : ''} style="${style}"></${c.tag}>`;
      return c.tag === 'a' ? element : `<a href="https://apps.apple.com/app/example"><section>${element}</section></a>`;
    }).join('');
    await page.setContent(html);
    await installProbeHelpers(page);
    const selectors: string[] = await page.locator('[data-case]').evaluateAll((els) => els.map((el) => (window as any).__lp.path(el)));
    const outputs = await runProbe(page, probe);
    return cases.flatMap((c, i) => {
      const found = outputs.find((a) => a.selector === selectors[i] && a.href?.includes('apps.apple.com'));
      if (!found) return [`${c.name}: no measurement. Inspect backgrounds on descendants of links, not only the anchor itself.`];
      if (![found.drawnW,found.drawnH,found.naturalW,found.naturalH].every((n) => Number.isFinite(n) && n > 0)) return [`${c.name}: invalid dimensions`];
      return Math.abs(found.drawnW - c.expected[0]) > 1 || Math.abs(found.drawnH - c.expected[1]) > 1 || found.naturalW !== 120 || found.naturalH !== 40
        ? [`${c.name}: expected painted ${c.expected[0].toFixed(2)}×${c.expected[1].toFixed(2)}, got ${found.drawnW.toFixed(2)}×${found.drawnH.toFixed(2)}. Use background positioning area, sizing and intrinsic ratio, not element bounds.`] : [];
    });
  } finally { await ctx.close(); }
}
