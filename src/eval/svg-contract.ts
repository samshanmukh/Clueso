import { getBrowser, installProbeHelpers, runProbe } from '../scan/scanner.ts';
import type { Probe } from '../brain/store.ts';

// Development-only specifications, fixed before synthesis; never derived from holdout sites.
const cases = [
  { name: 'inline meet', markup: '<svg viewBox="0 0 120 40" width="200" height="80"><rect width="120" height="40"/></svg>', expected: [200,200/3] },
  { name: 'inline stretch', markup: '<svg viewBox="0 0 120 40" preserveAspectRatio="none" width="240" height="50"><rect width="120" height="40"/></svg>', expected: [240,50] },
  { name: 'inline slice', markup: '<svg viewBox="0 0 120 40" preserveAspectRatio="xMidYMid slice" width="200" height="80"><rect width="120" height="40"/></svg>', expected: [240,80] },
  { name: 'referenced svg', markup: '<svg width="200" height="80"><use href="#dev-svg"/></svg>', expected: [200,200/3] },
  { name: 'referenced symbol', markup: '<svg width="210" height="80"><use href="#dev-symbol"/></svg>', expected: [210,70] },
  { name: 'xlink symbol', markup: '<svg width="180" height="80"><use xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="#dev-symbol"/></svg>', expected: [180,60] },
  { name: 'explicit use viewport', markup: '<svg width="300" height="100"><use href="#dev-symbol" width="150" height="60"/></svg>', expected: [150,50] },
  { name: 'referenced stretch', markup: '<svg width="200" height="80"><use href="#dev-stretch"/></svg>', expected: [200,80] },
  { name: 'CSS stretch', markup: '<svg viewBox="0 0 120 40" width="120" height="40" style="transform:scale(2,1);transform-origin:0 0"><rect width="120" height="40"/></svg>', expected: [240,40] },
  { name: 'plain text control', markup: 'Download the app', expected: null },
  { name: 'broken reference control', markup: '<svg width="120" height="40"><use href="#not-present"/></svg>', expected: null },
  { name: 'external reference control', markup: '<svg width="120" height="40"><use href="https://never-contact.example/icons.svg#logo"/></svg>', expected: null },
];
export const svgContractCases=cases.length;
export async function testSvgProbeContract(probe: Probe): Promise<string[]> {
  const ctx=await (await getBrowser()).newContext({serviceWorkers:'block'});
  try {
    await ctx.route('**/*',route=>route.abort());
    const page=await ctx.newPage();
    await page.setContent('<div style="display:none"><svg id="dev-svg" viewBox="0 0 120 40"><rect width="120" height="40"/></svg><svg><defs><symbol id="dev-symbol" viewBox="0 0 120 40"><rect width="120" height="40"/></symbol><symbol id="dev-stretch" viewBox="0 0 120 40" preserveAspectRatio="none"><rect width="120" height="40"/></symbol></defs></svg></div>'+cases.map((c,i)=>`<a data-case="${i}" style="display:block;margin:10px" href="https://apps.apple.com/app/development">${c.markup}</a>`).join('')+'<a href="https://nonstore.example/"><svg viewBox="0 0 120 40" width="120" height="40"><rect width="120" height="40"/></svg></a><svg viewBox="0 0 120 40" width="120" height="40"><rect width="120" height="40"/></svg>');
    await installProbeHelpers(page);
    const expected=await page.locator('[data-case]').evaluateAll(links=>links.map(link=>{
      const svg=link.querySelector('svg'),use=svg?.querySelector('use');
      const href=use?.getAttribute('href')||use?.getAttributeNS('http://www.w3.org/1999/xlink','href');
      const referenced=href?.startsWith('#')?document.getElementById(href.slice(1)):null;
      const source=svg?.viewBox.baseVal.width?svg:referenced;
      return {link:(window as any).__lp.path(link),svg:svg?(window as any).__lp.path(svg):null,source:{tag:source?.tagName,viewBox:source?.getAttribute('viewBox'),preserveAspectRatio:source?.getAttribute('preserveAspectRatio')||'xMidYMid meet'},use:{preserveAspectRatio:use?.getAttribute('preserveAspectRatio'),width:use?.getAttribute('width'),height:use?.getAttribute('height')}};
    }));
    const outputs=await runProbe(page,probe);
    const rendered=await page.evaluate(async urls=>Promise.all(urls.map(async url=>{
      try{const image=new Image();image.src=url;await image.decode();const canvas=document.createElement('canvas');canvas.width=12;canvas.height=4;const context=canvas.getContext('2d')!;context.drawImage(image,0,0,12,4);const pixels=context.getImageData(0,0,12,4).data;return Array.from(pixels).some((value,index)=>index%4===3&&value>0);}catch{return false;}
    })),outputs.map(asset=>asset.imageUrl));
    const failures=cases.flatMap((c,i)=>{
      const found=outputs.filter(asset=>asset.selector===expected[i].svg);
      if(!c.expected)return found.length?[`${c.name}: returned a measurement for unsupported or missing artwork`]:[];
      if(found.length!==1)return [`${c.name}: expected one measured SVG, got ${found.length}`];
      const a=found[0];
      if(a.naturalW!==120||a.naturalH!==40||Math.abs(a.drawnW-c.expected[0])>.8||Math.abs(a.drawnH-c.expected[1])>.8)return [`${c.name}: expected intrinsic 120×40, painted ${c.expected.join('×')}; got intrinsic ${a.naturalW}×${a.naturalH}, painted ${a.drawnW}×${a.drawnH}. DOM witness: effective source=${JSON.stringify(expected[i].source)}; use reference=${JSON.stringify(expected[i].use)}. Read the effective source mode, not the use reference mode.`];
      if(!a.imageUrl.startsWith('data:image/svg+xml')||!a.href?.startsWith('https://apps.apple.com/'))return [`${c.name}: missing standalone SVG image or enclosing store link`];
      if(!rendered[outputs.indexOf(a)])return [`${c.name}: the returned standalone SVG does not paint any artwork (resolve referenced definitions into the data image)`];
      return [];
    });
    const validSelectors=expected.filter((_,i)=>cases[i].expected).map(item=>item.svg);
    if(outputs.some(asset=>!validSelectors.includes(asset.selector)))failures.push('Scope controls: emitted artwork outside supported rendered store SVGs. Skip non-store links, unlinked artwork, hidden definitions and unsupported references.');
    return failures;
  } finally {await ctx.close();}
}
