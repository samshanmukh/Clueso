import fs from 'node:fs';
import path from 'node:path';
import type {BrainVersion} from '../brain/store.ts';
/** Latest attempt and last retained evidence are distinct: a failed proposal must not erase a learned skill. */
export function loadCheckerEvidence(dataDir:string,brain:BrainVersion){
 const read=(name:string)=>{try{return JSON.parse(fs.readFileSync(path.join(dataDir,name),'utf8'));}catch{return null;}};
 const active=(record:any)=>record?.promoted===true&&brain.probes.some(p=>p.id===record.probe?.id&&p.code===record.probe?.code);
 const raw=read('real-checker-latest.json'),retained=read('real-checker-retained.json');
 // Older runs recorded this normal terminal outcome as an exception. Preserve its provenance.
 const latest=raw?.status==='failed'&&raw.error==='The real training page has no unmeasured SVG badge gap; no artificial gap will be created.'?{...raw,status:'no_change',recordedStatus:'failed',reason:'no_svg_gap',message:'No unsupported SVG badge artwork was found on this site. Existing checks remain available.'}:raw;
 if(!latest)return active(retained)?{...retained,activeInBrain:true}:null;
 return {...latest,activeInBrain:active(latest),...(active(retained)&&retained.job!==latest.job?{retainedResult:{...retained,activeInBrain:true}}:{})};
}
