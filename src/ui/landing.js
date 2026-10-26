'use strict';
const steps={
 inspect:{title:'Inspect what actually happens.',description:'Scout opens the page in Chromium with no cookies, records every network request before and after the consent banner, captures the policy text and finds every store badge on the page.',caption:'The captured page beside the findings it produced.',alt:'The Clueso workspace: four findings beside the captured page of a test app, with the altered App Store badge selected'},
 verify:{title:'Give every claim a second look.',description:'Vera reruns each candidate finding in a fresh browser. A finding is verified only when it reproduces; anything inconclusive stays visible as a review item.',caption:'An independent reproduction beside the requests it recorded.',alt:'Evidence pane of the Clueso workspace with an independent verification of a finding'},
 fix:{title:'Turn the evidence into a next step.',description:'Patch writes a repair prompt with acceptance checks for your coding agent. Nothing is changed on your site; you decide what to apply.',caption:'A fix prompt with acceptance checks, ready to paste.',alt:'A Clueso fix prompt with acceptance checks'},
 learn:{title:'Make the next inspection more capable.',description:'Nova proposes new vendor knowledge or inspection code from what the team could not check, then tests the frozen candidate on other sites before it joins the shared brain.',caption:'What changed, how it was tested and what was kept.',alt:'The Clueso learning lab explaining a retained checker'}
};
const shots=Object.fromEntries([...document.querySelectorAll('img[data-shot]')].map(img=>[img.dataset.shot,img.getAttribute('src')]));
const tabs=[...document.querySelectorAll('[data-step]')];
function selectStep(tab,focus=false){
 const key=tab.dataset.step,step=steps[key];
 for(const item of tabs){const selected=item===tab;item.setAttribute('aria-selected',String(selected));item.tabIndex=selected?0:-1;}
 document.getElementById('demo-title').textContent=step.title;
 document.getElementById('demo-description').textContent=step.description;
 document.getElementById('demo-caption').textContent=step.caption;
 const img=document.getElementById('demo-shot');if(shots[key]&&img.dataset.showing!==key){img.src=shots[key];img.alt=step.alt;img.dataset.showing=key;}
 const panel=document.getElementById('demo-workflow');panel.setAttribute('aria-labelledby',tab.id);panel.dataset.activeStep=key;
 if(focus)tab.focus();
}
for(const tab of tabs){
 tab.addEventListener('click',()=>selectStep(tab));
 tab.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const index=tabs.indexOf(tab);selectStep(tabs[event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length],true);});
}

// Every launch form hands a checked URL to the workspace; nothing runs until the user starts the audit there.
function normalise(value){
 value=value.trim();if(!value)return '';
 if(!/^[a-z][a-z0-9+.-]*:/i.test(value))value='https://'+value;
 const url=new URL(value);
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||(!url.hostname.includes('.')&&url.hostname!=='localhost'))throw Error('invalid');
 url.hash='';return url.href;
}
for(const form of document.querySelectorAll('form[data-launch]')){
 const field=form.querySelector('input[name=url]'),error=form.querySelector('.form-error')||document.getElementById('launch-error');
 form.addEventListener('submit',event=>{
  event.preventDefault();
  let target;
  try{target=normalise(field.value);}catch{
   error.textContent='Enter a website URL, such as https://example.com.';error.hidden=false;
   if(!error.id)error.id=field.id+'-error';
   field.setAttribute('aria-invalid','true');field.setAttribute('aria-describedby',error.id);field.focus();return;
  }
  location.assign(target?'/app?url='+encodeURIComponent(target):'/app');
 });
 field.addEventListener('input',()=>{error.hidden=true;field.removeAttribute('aria-invalid');});
}

// The plan under the typed line follows the address the visitor types.
const site=document.getElementById('site-url'),planHost=document.getElementById('plan-host'),planPolicy=document.getElementById('plan-policy');
function syncPlan(){
 let host='';try{host=new URL(normalise(site.value)||'x:').hostname;}catch{host='';}
 planHost.textContent=host?'open '+host:'open your site';
 planPolicy.textContent=host?'the privacy policy '+host+' links to':'your privacy policy';
}
site.addEventListener('input',syncPlan);
for(const button of document.querySelectorAll('[data-fill]'))button.addEventListener('click',()=>{site.value=button.dataset.fill;syncPlan();site.dispatchEvent(new Event('input'));site.focus();});

// One lit name at a time in the credits sentence.
const names=[...document.querySelectorAll('.names .name')];let lit=0;
const reduce=matchMedia('(prefers-reduced-motion: reduce)');
if(names.length){names[0].classList.add('lit');if(!reduce.matches)setInterval(()=>{if(document.hidden)return;names[lit].classList.remove('lit');lit=(lit+1)%names.length;names[lit].classList.add('lit');},2000);}

// Section entrances: parts rise in order as each section arrives, once. Content is visible without script.
const io='IntersectionObserver' in window?new IntersectionObserver(entries=>{for(const entry of entries){if(!entry.isIntersecting)continue;entry.target.classList.add('is-in');io.unobserve(entry.target);}},{rootMargin:'0px 0px -12% 0px'}):null;
document.querySelectorAll('main > section:not(.hero) > *, .field > *, .site-footer .footer-top > *').forEach(el=>{el.classList.add('reveal');el.style.setProperty('--i',String([...el.parentElement.children].indexOf(el)));});
for(const el of document.querySelectorAll('.reveal,.shutter')){if(io&&!reduce.matches)io.observe(el);else el.classList.add('is-in');}
