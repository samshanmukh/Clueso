import {getBrowser,installProbeHelpers} from '../scan/scanner.ts';
import {runStoreLinkClassifier} from '../checks/text-links.ts';
import type {Probe} from '../brain/store.ts';
// Frozen development controls. No held-out website is used to repair generated code.
const cases=[
 {id:'plain',html:'<a href="https://apps.apple.com/app/development">Read more on the App Store</a>',yes:true},
 {id:'large',html:'<a style="display:block;padding:30px;border:2px solid green" href="https://apps.apple.com/app/another">Download this application</a>',yes:true},
 {id:'editorial',html:'<a href="https://apps.apple.com/us/story/id-development">Read the editorial story</a>',yes:true},
 {id:'play',html:'<a href="https://play.google.com/store/apps/details?id=development">Get the Android application</a>',yes:true},
 {id:'itunes',html:'<a href="https://itunes.apple.com/app/development">Get the iOS application</a>',yes:true},
 {id:'image',html:'<a href="https://apps.apple.com/app/development"><img width="120" height="40" src="data:image/png;base64,iVBORw0KGgo=">Download</a>',yes:false},
 {id:'svg',html:'<a href="https://apps.apple.com/app/development"><svg width="120" height="40"><rect width="120" height="40"/></svg>Download</a>',yes:false},
 {id:'background',html:'<a style="background-image:linear-gradient(red,blue)" href="https://apps.apple.com/app/development">Download</a>',yes:false},
 {id:'mask',html:'<a style="mask-image:linear-gradient(black,black)" href="https://apps.apple.com/app/development">Download</a>',yes:false},
 {id:'pseudo',html:'<a class="pseudo-icon" href="https://apps.apple.com/app/development">Download</a>',yes:false},
 {id:'nested',html:'<a href="https://apps.apple.com/app/development"><span>Download</span></a>',yes:false},
 {id:'empty',html:'<a style="display:block;width:120px;height:40px" href="https://apps.apple.com/app/development"></a>',yes:false},
 {id:'nonstore',html:'<a href="https://not-a-store.example">Read more on the App Store</a>',yes:false},
 {id:'hidden',html:'<div style="display:none"><a href="https://apps.apple.com/app/development">Download</a></div>',yes:false},
 {id:'transparent',html:'<div style="opacity:0"><a href="https://apps.apple.com/app/development">Download</a></div>',yes:false},
 {id:'canvas',html:'<a href="https://apps.apple.com/app/development"><canvas width="120" height="40"></canvas>Download</a>',yes:false},
];
export const textLinkContractCases=cases.length;
export async function testTextLinkContract(probe:Probe){
 const ctx=await(await getBrowser()).newContext({serviceWorkers:'block'});try{await ctx.route('**/*',route=>route.abort());await ctx.setOffline(true);const page=await ctx.newPage();await page.setContent('<style>a{font:16px Arial}.pseudo-icon::before{content:"★"}</style>'+cases.map(c=>`<section data-case="${c.id}">${c.html}</section>`).join(''));await installProbeHelpers(page);
 const expected=await page.evaluate(()=>[...document.querySelectorAll<HTMLElement>('section[data-case]')].map(section=>({id:section.dataset.case,selector:(window as any).__lp.path(section.querySelector('a'))})));
 const output=await runStoreLinkClassifier(page,probe);const failures:string[]=[];
 for(const c of cases){const selector=expected.find(e=>e.id===c.id)!.selector;const hits=output.filter(o=>o.selector===selector);if(c.yes?(hits.length!==1||!hits[0].verified):hits.length>0)failures.push(`${c.id}: expected ${c.yes?'one independently valid text classification':'no classification'}, got ${hits.length}${hits.some(h=>!h.verified)?' (invalid claim)':''}`);}
 if(output.some(o=>!expected.some(e=>e.selector===o.selector)))failures.push('Out-of-scope selector emitted');return failures;
 }finally{await ctx.close();}
}
