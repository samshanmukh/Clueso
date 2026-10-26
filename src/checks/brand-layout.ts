import type { Page } from 'playwright';
import type { AssetInstance } from '../scan/scanner.ts';

/** Reviewed engineering rules, not agent-learned knowledge or a legal verdict. */
export const appleBadgeLayout = {
  brand:'apple-app-store-badge', minimumHeight:40, clearSpaceRatio:.25, limitedSpaceRatio:.1,
  source:'https://developer.apple.com/app-store/marketing/guidelines/', reviewedAt:'2026-10-17',
  scope:'On-screen App Store marketing badges. Constrained advertising has an explicit exception; placement context requires review.',
};
export interface LayoutAssessment {
  selector:string; asset:AssetInstance; brand:string; measuredHeight:number;
  minimumHeight:number; standardClearSpace:number; limitedClearSpace:number;
  nearestGap:number|null; neighbor:string|null; spacingSupported:boolean; reasons:string[];
  source:string; status:'measured_review'|'within_measured_limits'|'inconclusive';
}
export function assessLayout(asset:AssetInstance, geometry:{gap:number|null;neighbor:string|null;supported:boolean}):LayoutAssessment {
  const rule=appleBadgeLayout, height=asset.drawnH;
  const reasons:string[]=[];
  if(Number.isFinite(height)&&height>0&&height<rule.minimumHeight-.5)reasons.push(`Painted height ${height.toFixed(1)}px is below the standard ${rule.minimumHeight}px on-screen minimum; review the constrained-advertising exception.`);
  if(geometry.supported&&geometry.gap!==null&&geometry.gap<height*rule.clearSpaceRatio-.5)reasons.push(`Nearest measured content is ${geometry.gap.toFixed(1)}px away; standard clear space is ${(height*rule.clearSpaceRatio).toFixed(1)}px. The limited-space alternative is ${(height*rule.limitedSpaceRatio).toFixed(1)}px.`);
  return {selector:asset.selector,asset,brand:rule.brand,measuredHeight:height,minimumHeight:rule.minimumHeight,standardClearSpace:height*rule.clearSpaceRatio,limitedClearSpace:height*rule.limitedSpaceRatio,nearestGap:geometry.gap,neighbor:geometry.neighbor,spacingSupported:geometry.supported,reasons,source:rule.source,status:reasons.length?'measured_review':geometry.supported?'within_measured_limits':'inconclusive'};
}
/** DOM geometry estimates spacing; transparent pixels, masks and complex transforms need review. */
export async function measureBrandLayout(page:Page,assets:AssetInstance[]):Promise<LayoutAssessment[]> {
  const results:LayoutAssessment[]=[];
  for(const asset of assets){
    if(results.length>=30)break;
    let host='';try{host=new URL(asset.href??'').hostname;}catch{continue;}
    if(!['apps.apple.com','itunes.apple.com'].includes(host)||!Number.isFinite(asset.drawnH)||asset.drawnH<=0)continue;
    // Store links can also contain square Apple marks, app icons or QR codes; do not apply full-badge layout rules to them.
    const sourceRatio=asset.naturalW/asset.naturalH;
    if(!Number.isFinite(sourceRatio)||sourceRatio<2||sourceRatio>4)continue;
    if(/qr.code|qrcode|(?:^|[^a-z])qr(?:[^a-z]|$)/i.test(`${asset.label??''} ${asset.imageUrl}`))continue;
    try{
      const geometry=await page.evaluate(({selector,w,h})=>{
        const element=document.querySelector(selector);if(!element)return {gap:null,neighbor:null,supported:false};
        const box=element.getBoundingClientRect();
        const style=getComputedStyle(element);
        if(Math.abs(box.width-w)>1||Math.abs(box.height-h)>1||style.clipPath!=='none'||style.maskImage!=='none')return {gap:null,neighbor:null,supported:false};
        const visible=(el:Element)=>{for(let p:Element|null=el;p;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0||s.clip!=='auto'||s.clipPath!=='none')return false;}return true;};
        let nearest=Infinity,neighbor:string|null=null;
        const consider=(r:DOMRect,el:Element,label:string)=>{
          if(el===element||element.contains(el)||el.contains(element)||r.width<=0||r.height<=0||!visible(el))return;
          // A larger media layer behind an overlaid badge is a background, not neighboring foreground content.
          if(/^(IMG|VIDEO|CANVAS|svg)$/.test(el.tagName)&&r.left<=box.left&&r.top<=box.top&&r.right>=box.right&&r.bottom>=box.bottom)return;
          // Measure only the portion that can paint through ancestor overflow clips.
          // Offscreen animation canvases may have boxes that extend into another section.
          let left=r.left,right=r.right,top=r.top,bottom=r.bottom;
          for(let p=el.parentElement;p&&p!==document.body&&p!==document.documentElement;p=p.parentElement){
            const css=getComputedStyle(p),clipX=/^(hidden|clip|auto|scroll)$/.test(css.overflowX),clipY=/^(hidden|clip|auto|scroll)$/.test(css.overflowY);
            if(!clipX&&!clipY)continue;
            const bounds=p.getBoundingClientRect();
            if(clipX){left=Math.max(left,bounds.left);right=Math.min(right,bounds.right);}
            if(clipY){top=Math.max(top,bounds.top);bottom=Math.min(bottom,bounds.bottom);}
          }
          if(right<=left||bottom<=top)return;
          const dx=Math.max(box.left-right,left-box.right,0),dy=Math.max(box.top-bottom,top-box.bottom,0);
          const gap=Math.max(dx,dy);if(gap<nearest){nearest=gap;neighbor=label.slice(0,120);}
        };
        const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let node:Node|null,count=0;
        while((node=walker.nextNode())&&count++<1500){if(!node.textContent?.trim()||!node.parentElement||node.parentElement.closest('script,style,svg,video,canvas,object'))continue;const range=document.createRange();range.selectNodeContents(node);for(const r of range.getClientRects())consider(r,node.parentElement,node.textContent.trim());}
        for(const el of Array.from(document.querySelectorAll('img,svg,video,canvas,input')).slice(0,500))consider(el.getBoundingClientRect(),el,el.getAttribute('alt')||el.getAttribute('aria-label')||el.tagName.toLowerCase());
        return {gap:Number.isFinite(nearest)?nearest:null,neighbor,supported:true};
      },{selector:asset.selector,w:asset.drawnW,h:asset.drawnH});
      results.push(assessLayout(asset,geometry));
    }catch{results.push(assessLayout(asset,{gap:null,neighbor:null,supported:false}));}
  }
  return results;
}
