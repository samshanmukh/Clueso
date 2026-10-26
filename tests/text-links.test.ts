import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {getBrowser,closeBrowser} from '../src/scan/scanner.ts';
import {runStoreLinkClassifier} from '../src/checks/text-links.ts';
import {uninspectedStoreLinks} from '../src/checks/checks.ts';
import {loadBrain,type Probe} from '../src/brain/store.ts';
import {transferRetentionErrors} from '../src/learn/retain-checker.ts';
after(closeBrowser);
test('independent witness rejects false text claims on artwork, hidden links and non-store links',async()=>{
 const ctx=await(await getBrowser()).newContext();try{const page=await ctx.newPage();await page.setContent(`<a id="valid" href="https://apps.apple.com/app/test">A store story</a><a id="artwork" href="https://apps.apple.com/app/test"><svg width="120" height="40"></svg>Download</a><a id="hidden" style="opacity:0" href="https://apps.apple.com/app/test">Download</a><a id="other" href="https://example.com">Download</a><style>#pseudo::before{content:'★'}</style><a id="pseudo" href="https://apps.apple.com/app/test">Download</a>`);
 const claims={id:'claims',code:`return [...document.querySelectorAll('a')].map(a=>({kind:'text-only',selector:'#'+a.id,href:a.href,text:a.textContent.trim()}));`} as Probe;
 const observations=await runStoreLinkClassifier(page,claims);assert.deepEqual(observations.map(o=>[o.selector,o.verified]),[['#valid',true],['#artwork',false],['#hidden',false],['#other',false],['#pseudo',false]]);
 }finally{await ctx.close();}
});
test('coverage requires an exact independently verified link and does not create artwork assets',()=>{
 const link={selector:'#story',href:'https://apps.apple.com/story/test',host:'apps.apple.com',text:'Read the story',width:365,height:28,html:'<a>Read the story</a>',styles:[]};
 const observation={probe:'learned',kind:'text-only' as const,selector:link.selector,href:link.href,text:link.text,verified:true};const brain=loadBrain('v0');
 assert.equal(uninspectedStoreLinks([link],[],brain).length,1);assert.equal(uninspectedStoreLinks([link],[],brain,[observation]).length,0);
 for(const change of [{verified:false},{selector:'#other'},{href:'https://apps.apple.com/story/other'}])assert.equal(uninspectedStoreLinks([link],[],brain,[{...observation,...change}]).length,1);
});
test('text retention requires independently reproduced classifications and rejects unavailable controls',()=>{
 const evidence={verifiedClassifications:[{selector:'#story'}],unverifiedClassifications:0,baselineErrors:[]};
 const site={url:'https://other.example',transferred:true,reproducedClassifications:1,first:evidence,independent:evidence};
 const good={capability:'text-store-links',executableCheckerTransferProven:true,unchanged:true,modelCallsDuringTransfer:0,development:{passed:true,cases:16},results:[site]};
 assert.deepEqual(transferRetentionErrors(good),[]);
 for(const broken of [{...site,independent:null},{...site,independent:{...evidence,unverifiedClassifications:1}},{...site,error:'Unavailable'},{...site,reproducedClassifications:0}])assert.ok(transferRetentionErrors({...good,results:[broken]}).length);
});
