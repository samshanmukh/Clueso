import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assessLayout,measureBrandLayout} from '../src/checks/brand-layout.ts';
import {getBrowser,closeBrowser,type AssetInstance} from '../src/scan/scanner.ts';
const asset:AssetInstance={probe:'img-elements',technique:'img',selector:'#badge',href:'https://apps.apple.com/app/example',imageUrl:'https://example.com/badge.svg',naturalW:120,naturalH:40,drawnW:120,drawnH:40};
test('brand rules distinguish normal clear space, the advertising exception, and measured size',()=>{
 assert.equal(assessLayout(asset,{gap:12,neighbor:'other content',supported:true}).status,'within_measured_limits');
 const tight=assessLayout(asset,{gap:5,neighbor:'other content',supported:true});
 assert.equal(tight.status,'measured_review');assert.equal(tight.standardClearSpace,10);assert.equal(tight.limitedClearSpace,4);
 assert.match(tight.reasons[0],/limited-space alternative/);
 assert.equal(assessLayout({...asset,drawnH:30},{gap:20,neighbor:null,supported:true}).status,'measured_review');
 assert.equal(assessLayout(asset,{gap:null,neighbor:null,supported:false}).status,'inconclusive');
});
test('spacing measures neighboring text and ignores the badge link and page containers',async()=>{
 const ctx=await (await getBrowser()).newContext();
 try{
  const page=await ctx.newPage();
  const markup=(gap:number,width=120)=>`<a style="position:absolute;left:100px;top:100px" href="${asset.href}"><img id="badge" width="${width}" height="40" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='40'%3E%3Crect width='120' height='40'/%3E%3C/svg%3E"></a><span style="position:absolute;left:${100+width+gap}px;top:100px">Neighbor text</span>`;
  await page.setContent(markup(5));
  const [tight]=await measureBrandLayout(page,[asset]);assert.equal(tight.nearestGap,5);assert.equal(tight.neighbor,'Neighbor text');assert.equal(tight.status,'measured_review');
  await page.setContent(markup(12));assert.equal((await measureBrandLayout(page,[asset]))[0].status,'within_measured_limits');
  await page.setContent(markup(5,200));assert.equal((await measureBrandLayout(page,[asset]))[0].spacingSupported,false);
 }finally{await ctx.close();await closeBrowser();}
});
