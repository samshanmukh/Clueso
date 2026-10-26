import fs from 'node:fs/promises';
import {scan,closeBrowser} from '../src/scan/scanner.ts';
import {runChecks} from '../src/checks/checks.ts';
import {loadBrain} from '../src/brain/store.ts';
import {setQuiet} from '../src/events.ts';setQuiet(true);
try{for(const url of ['https://www.stridesapp.com/','https://avocation.app/','https://prettyprogress.app/']){try{const dir='data/new-transfer-discovery/training-baselines/'+new URL(url).hostname;const snapshot=await scan(url,loadBrain(),dir);const checks=runChecks(snapshot,loadBrain());const unresolved=checks.unresolved.filter(u=>u.type==='uninspected_store_badge');await fs.writeFile(dir+'/checks.json',JSON.stringify(checks,null,2));console.log(JSON.stringify({url,unresolved:unresolved.map(u=>({summary:u.summary,data:u.data})),errors:snapshot.probeErrors}));}catch(e){console.log(JSON.stringify({url,error:String(e)}));}}}finally{await closeBrowser();}
