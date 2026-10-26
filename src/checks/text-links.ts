import type {Page} from 'playwright';
import type {Probe} from '../brain/store.ts';
export interface StoreLinkObservation {probe:string;kind:'text-only';selector:string;href:string;text:string;verified:boolean}
/** Independent DOM witness; candidate code selects links, this checks its claims before suppressing uncertainty. */
export async function runStoreLinkClassifier(page:Page,probe:Probe,timeoutMs=5000):Promise<StoreLinkObservation[]>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 const raw=await Promise.race([page.evaluate(async code=>{const output=await new Function(`return (async()=>{${code}\n})()` )();if(!Array.isArray(output))throw Error('Classifier must return an array');return output;},probe.code),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Classifier timed out')),timeoutMs);})]).finally(()=>clearTimeout(timer));
 if(raw.length>500||raw.some(row=>row?.kind!=='text-only'||typeof row.selector!=='string'||typeof row.href!=='string'||typeof row.text!=='string'))throw Error('Invalid store-link observation schema');
 const verified=await page.evaluate(rows=>rows.map(row=>{
  try{
   const el=document.querySelector(row.selector);if(!(el instanceof HTMLAnchorElement)||el.children.length||el.shadowRoot)return false;
   const host=new URL(el.href).hostname;if(!['apps.apple.com','itunes.apple.com','play.google.com'].includes(host)||el.href!==row.href)return false;
   const text=el.textContent?.trim().replace(/\s+/g,' ')??'';if(!text||text!==row.text.trim().replace(/\s+/g,' '))return false;
   const r=el.getBoundingClientRect();if(r.width<4||r.height<4)return false;
   for(let node:Element|null=el;node;node=node.parentElement){const cs=getComputedStyle(node);if(cs.display==='none'||['hidden','collapse'].includes(cs.visibility)||Number(cs.opacity)===0)return false;}
   for(const pseudo of [null,'::before','::after']){const cs=getComputedStyle(el,pseudo);if(cs.backgroundImage!=='none'||cs.maskImage!=='none'||cs.borderImageSource!=='none')return false;const content=cs.content;if(content&&!['none','normal','""',"''"].includes(content))return false;}
   return true;
  }catch{return false;}
 }),raw);
 return raw.map((row,index)=>({probe:probe.id,kind:'text-only',selector:row.selector,href:row.href,text:row.text,verified:verified[index]}));
}
