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
  await page.setContent(markup(5)+'<video style="position:absolute;inset:0;width:1000px;height:1000px">Hidden video fallback text</video><span style="position:absolute;left:100px;top:100px;clip:rect(0,0,0,0)">Screen reader description</span>');
  const unrelated=Array.from({length:40},(_,i)=>({...asset,selector:'#unrelated-'+i,href:'https://example.com/'}));
  const [tight]=await measureBrandLayout(page,[...unrelated,asset]);assert.equal(tight.nearestGap,5);assert.equal(tight.neighbor,'Neighbor text');assert.equal(tight.status,'measured_review');
  assert.deepEqual(await measureBrandLayout(page,[{...asset,naturalW:40,naturalH:40}]),[]);
  await page.setContent(markup(12));assert.equal((await measureBrandLayout(page,[asset]))[0].status,'within_measured_limits');
  await page.setContent(markup(5,200));assert.equal((await measureBrandLayout(page,[asset]))[0].spacingSupported,false);
 }finally{await ctx.close();await closeBrowser();}
});

test('spacing respects ancestor overflow clipping without hiding real intrusions',async()=>{
 const ctx=await (await getBrowser()).newContext();
 try{
  const page=await ctx.newPage();
  for(const [overflow,top,expected] of [['clip',200,12],['hidden',145,5],['visible',200,0]] as const){
   await page.setContent(`<img id="badge" width="120" height="40" style="position:absolute;left:100px;top:100px"><span style="position:absolute;left:232px;top:100px">Neighbor text</span><div style="position:absolute;left:90px;top:${top}px;width:200px;height:100px;overflow:${overflow}"><canvas style="position:absolute;left:20px;top:-100px;width:80px;height:180px"></canvas></div>`);
   const [result]=await measureBrandLayout(page,[asset]);
   assert.equal(result.nearestGap,expected,`${overflow} at ${top}`);
   assert.equal(result.status,expected>=10?'within_measured_limits':'measured_review');
  }
 }finally{await ctx.close();await closeBrowser();}
});
