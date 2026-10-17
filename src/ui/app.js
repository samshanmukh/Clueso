'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const hasMetric = value => typeof value === 'number' && Number.isFinite(value);
const metricValue = value => hasMetric(value) ? value : 'Not measured';
const metricFixed = (value, digits = 1) => hasMetric(value) ? value.toFixed(digits) : 'Not measured';
const metricRatio = (width, height) => hasMetric(width) && hasMetric(height) && height > 0 ? (width / height).toFixed(2) : 'Not measured';
const NAMES = {'app-a':'Glowfit','app-b':'Pawtrail','app-c':'Brightbank','app-d':'Leafnote'};
// Public examples, verified against their official landing pages on 2026-10-17.
// Inclusion is for exploration; it makes no claim about an app's audit outcome.
const EXAMPLE_SITES = [
  {name:'Zup',url:'https://zupapps.com/',description:'Photo captions and social posting',primary:true},
  {name:'Mojo',url:'https://mojo-app.com/',description:'Social videos and animated content'},
  {name:'Captions',url:'https://captions.ai/',description:'AI video editing and captions'},
  {name:'Ripl',url:'https://www.ripl.com/',description:'Social content creation and scheduling'}
];
function syncExampleSelection(){const value=$('url').value.trim().replace(/\/$/,'');document.querySelectorAll('[data-example]').forEach(button=>{const selected=button.dataset.example.replace(/\/$/,'')===value;button.classList.toggle('chosen',selected);button.setAttribute('aria-pressed',String(selected));});}

let status = {}, currentReport = null, records = [], selectedKey = null, filter = 'all', phase = 'pre', events = 0, followLive = false, loadSerial = 0;
let busyState = false, activeAgentRole = null;
let focusFinding = true;
const LAB_ACTIONS = {
  'learn-checker': { label: 'Learn a real checker', busy: 'real checker learning', target: 'real-checker-learning', detail: 'Nemotron writes an SVG checker from Biuty, validates it, freezes the code, and tests it on preselected real websites.' },
  'learn-real': { label: 'Learn on Zup', busy: 'real-site learning', target: 'real-learning', detail: 'Researching Zup and testing vendor recognition on other real sites. This can take several minutes.' },
  eval: { label: 'Benchmark comparison', busy: 'held-out eval', target: 'evalbox', detail: 'Comparing the original and current brains on reserved synthetic apps.' },
  fresh: { label: 'Benchmark transfer', busy: 'fresh-app transfer', target: 'freshbox', detail: 'Generating fresh synthetic apps and testing whether learned checkers transfer.' },
};
let labOperation = null;
const learningState={brain:null,benchmark:null,transfer:null,checker:null};
function updateLabOperation(id, state, message) {
  const action = LAB_ACTIONS[id];
  const previous = labOperation?.id === id && ['starting','running'].includes(labOperation.state) ? labOperation : null;
  labOperation = { ...(previous ?? { role: null, workedRoles: [], phases: [], sites: [], eventCount: 0 }), id, state, startedAt: previous?.startedAt ?? Date.now() };
  const panel = $('lab-operation'); panel.hidden = false; panel.dataset.state = state;
  panel.setAttribute('aria-busy', String(['starting','running'].includes(state)));
  $('lab-operation-title').textContent = action.label;
  $('lab-operation-state').textContent = ({ starting:'Starting…', running:'Running…', completed:'Completed', error:'Could not complete' })[state];
  $('lab-operation-message').textContent = message;
  $('lab-view-result').hidden = state !== 'completed';
  for (const [key, item] of Object.entries(LAB_ACTIONS)) $(key).textContent = key === id && ['starting','running'].includes(state) ? item.label + ' · Running…' : item.label;
  broadcastLabActivity();
}
async function runLabAction(id, url) {
  if (busyState) return;
  showView('learning');
  openLearningEvidence(LAB_ACTIONS[id].target);
  $('lab-operation-log').replaceChildren();
  updateLabOperation(id, 'starting', 'Sending the request…');
  requestAnimationFrame(() => $('lab-operation').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }));
  const response = await post(url);
  if (response) {
    // A very fast job can finish before its accepted response reaches the browser.
    if (labOperation?.state === 'starting') updateLabOperation(id, 'running', LAB_ACTIONS[id].detail);
  } else updateLabOperation(id, 'error', $('notice').textContent || 'The operation could not be started. Please try again.');
}
function broadcastLabActivity() {
  const detail = labOperation ? { ...labOperation, message: $('lab-operation-message').textContent } : null;
  window.cluesoLab = detail;
  window.dispatchEvent(new CustomEvent('clueso:lab-state', { detail }));
}
function updateLabProgress(event) {
  if (!labOperation || !['starting','running'].includes(labOperation.state) || event.t < labOperation.startedAt) return;
  const role = ['research','gate'].includes(event.role) ? 'learner' : event.role;
  const phases = { scanner:'Inspecting websites', vision:'Comparing visuals', investigator:'Investigating findings', verifier:'Verifying evidence', fixer:'Preparing findings', learner:'Learning from evidence', eval:labOperation.id === 'eval' ? 'Comparing versions' : 'Testing transfer' };
  if (phases[role]) {
    labOperation.role = role;
    labOperation.phase = phases[role];
    labOperation.workedRoles = [...new Set([...labOperation.workedRoles, role])];
    labOperation.phases = [...new Set([...labOperation.phases, phases[role]])];
  }
  const site = event.data?.preview?.url || ((event.role === 'scanner' || event.role === 'eval') && event.msg.match(/https?:\/\/[^\s)]+/)?.[0]);
  if (site) { labOperation.site = site; labOperation.sites = [...new Set([...labOperation.sites, site])]; }
  labOperation.eventCount++;
  const row = document.createElement('div'); row.textContent = `${event.role}: ${event.msg}`;
  const log = $('lab-operation-log'); log.append(row); if (log.childElementCount > 12) log.firstElementChild.remove(); log.scrollTop = log.scrollHeight;
  if (event.role === 'controller' && event.kind === 'error') updateLabOperation(labOperation.id, 'error', event.msg);
  else $('lab-operation-message').textContent = event.msg;
  broadcastLabActivity();
}

let pendingAudit = null;
const workedAgentRoles = new Set();
function broadcastActivity() { const detail = {busy:busyState,role:activeAgentRole,workedRoles:[...workedAgentRoles],message:$('activity-last').textContent}; window.cluesoState = detail; document.body.dataset.busy = String(busyState); window.dispatchEvent(new CustomEvent('clueso:state',{detail})); }
document.addEventListener('visibilitychange',()=>{document.body.dataset.hidden=String(document.hidden);});
const label = (s) => String(s ?? '').replaceAll('_',' ');
function safeLink(s) { try { const u = new URL(s); return ['http:','https:'].includes(u.protocol) && !u.username && !u.password ? u.href : ''; } catch { return ''; } }
function artifact(file) { return currentReport && /^[\w.-]+\.png$/.test(file || '') ? `/artifacts/${encodeURIComponent(currentReport.job)}/${encodeURIComponent(file)}` : ''; }
function imageTile(file, alt) { const url = artifact(file); return url ? `<button class="image-tile" data-image="${esc(url)}" data-title="${esc(alt)}" aria-label="Expand ${esc(alt)}"><img src="${esc(url)}" alt="${esc(alt)}" loading="lazy"></button>` : '<div class="image-tile missing">No image captured</div>'; }
function notify(message) { $('notice').textContent = message; $('notice').hidden = !message; }
function emptyEvidence(message = 'Choose a finding to inspect its evidence.') { $('selection-bar').hidden=true; $('evidence-actions').hidden = true; $('evidence-actions').innerHTML = ''; $('evidence').innerHTML = `<div class="empty small"><span class="empty-icon" aria-hidden="true">⌕</span><h3>Evidence, in context.</h3><p>${esc(message)}</p></div>`; }
function setBusy(busy) { if(busy && !busyState)workedAgentRoles.clear(); busyState=busy; if (!busy) activeAgentRole=null; broadcastActivity(); ['go','learn','learn-real','learn-checker','eval','fresh','reset'].forEach((id) => { $(id).disabled = busy || (id === 'go' && $('ver').disabled); }); $('audit-button-label').hidden = busy; $('busy-orb-root').hidden = !busy; $('go').setAttribute('aria-busy',String(busy)); $('activity-dot').style.background = busy ? 'var(--warn)' : 'var(--good)'; $('busy-notice').hidden=!busy; if(busy)$('busy-notice').textContent='A job is running. You can browse saved results; new runs will be available when it finishes.'; }
function setPreviewAddress(url){$('preview-url').textContent=url;$('url').value=url;syncExampleSelection();}
function broadcastPreview() { window.cluesoPreview=pendingAudit; window.dispatchEvent(new CustomEvent('clueso:preview',{detail:pendingAudit})); }
function beginAuditPreview(url, job = null) {
  ++loadSerial; currentReport=null; records=[]; selectedKey=null; filter='all';
  pendingAudit={url,job,image:null,width:1280,height:800,targets:[]};
  const locationUrl=new URL(location.href); locationUrl.searchParams.delete('audit'); history.replaceState(null,'',locationUrl);
  $('history').value=''; syncHistorySelect();
  setPreviewAddress(url); $('preview-controls').innerHTML=''; $('expand-preview').disabled=true;
  $('preview-stage').classList.remove('zoomed'); $('preview-stage').scrollTop=0;
  $('preview-stage').innerHTML=`<div class="preview-loading"><div class="preview-skeleton" aria-hidden="true"><i></i><i></i><i></i></div><h3>Opening the website…</h3><p>${esc(url)}</p></div>`;
  $('preview-caption').textContent='Opening browser · waiting for the first capture'; $('preview-location').textContent='';
  $('run-status').className='status-dot working'; $('run-title').textContent='Inspecting your app…'; $('run-meta').textContent='A fresh preview will appear as the browser loads';
  $('finding-count').textContent='—'; $('filters').innerHTML=''; $('finding-list').innerHTML='<div class="empty small"><h3>Gathering evidence</h3><p>Findings will appear when the independent checks finish.</p></div>';
  emptyEvidence('The agents are gathering evidence for this website.');
  broadcastPreview();
}
function updateAuditPreview(preview, job) {
  if(!pendingAudit || pendingAudit.job!==job || !/^[\w-]+$/.test(job) || !/^[\w.-]+\.png$/.test(preview.file))return;
  if(!Number.isFinite(preview.width) || !Number.isFinite(preview.height) || preview.width<=0 || preview.height<=0)return;
  pendingAudit={...pendingAudit,...preview,job,image:`/artifacts/${encodeURIComponent(job)}/${encodeURIComponent(preview.file)}`};
  setPreviewAddress(pendingAudit.url);
  $('preview-stage').innerHTML=`<div class="screenshot-wrap"><img class="website-shot live-website-shot" src="${esc(pendingAudit.image)}" alt="Current browser capture of ${esc(pendingAudit.url)}"></div>`;
  $('preview-stage').scrollTop=0;
  $('preview-stage').querySelector('img').onerror=()=>{if(pendingAudit?.job===job){$('preview-caption').textContent='Browser capture temporarily unavailable; inspection continues';}};
  $('preview-caption').textContent='Current browser capture · inspection in progress'; $('run-meta').textContent='Reviewing page components and gathering evidence';
  broadcastPreview();
}
async function readJson(url) { const r = await fetch(url); if (!r.ok) throw new Error(`Could not load data (${r.status}).`); return r.json(); }
async function refreshStatus() {
  status = await readJson('/api/status');

  $('fixtures').innerHTML = '<span class="example-label">Examples</span>' + EXAMPLE_SITES.map(site=>`<button type="button" class="chip ${site.primary?'primary-example':''}" data-example="${esc(site.url)}" title="${esc(site.description)}${site.primary?' · Primary example':''}">${esc(site.name)}${site.primary?'<span class="example-star" aria-hidden="true">✦</span>':''}</button>`).join('');
  document.querySelectorAll('[data-example]').forEach(button=>{button.onclick=()=>{$('url').value=button.dataset.example;syncExampleSelection();$('url').focus();};});
  syncExampleSelection();
  setBusy(!!status.busy);
  if (status.busy && !['starting','running','error'].includes(labOperation?.state)) {
    const entry = Object.entries(LAB_ACTIONS).find(([, action]) => action.busy === status.busy);
    if (entry) updateLabOperation(entry[0], 'running', 'This operation is already running. New progress will appear here.');
  }

  if(status.liveAudit){activeAgentRole=status.liveAudit.role??null;(status.liveAudit.workedRoles??[]).forEach(role=>workedAgentRoles.add(role));broadcastActivity();}
  if(status.liveAudit && (!pendingAudit || pendingAudit.job!==status.liveAudit.job)){followLive=true;beginAuditPreview(status.liveAudit.url,status.liveAudit.job);if(status.liveAudit.preview)updateAuditPreview(status.liveAudit.preview,status.liveAudit.job);}
}
async function refreshHistory(loadLatest = false) {
  const {reports} = await readJson('/api/reports');
  $('history').innerHTML = '<option value="">Choose a completed run</option>' + reports.map((r) => {
    const date = new Date(r.startedAt); const time = Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : '';
    let name = r.url; try { const u = new URL(r.url); name = NAMES[u.pathname.split('/').find((x) => /^app-[a-z]$/.test(x))] || EXAMPLE_SITES.find(site=>new URL(site.url).hostname===u.hostname)?.name || u.hostname; } catch { /* display original URL as text */ }
    return `<option value="${esc(r.job)}">${esc(name)} · ${r.findings} findings · ${esc(time)}</option>`;
  }).join('');
  if (currentReport) $('history').value = currentReport.job;
  if (loadLatest && !currentReport && !pendingAudit) {
    const requested = new URL(location.href).searchParams.get('audit');
    if (requested) await loadReport(requested);
    else if (reports.length) {
      const primary=reports.find(report=>{try{return new URL(report.url).hostname==='zupapps.com';}catch{return false;}});
      if(primary)await loadReport(primary.job);
    }
  }
}
async function loadReport(job) {
  if (!/^[\w-]+$/.test(job)) { notify('That audit identifier is not valid.'); return; }
  const serial = ++loadSerial;
  try {
    const r = await readJson('/api/report/' + encodeURIComponent(job));
    if (serial !== loadSerial) return;
    if(!r || r.job!==job || !Array.isArray(r.findings) || !r.scan || !r.url)throw new Error('Incomplete saved report');
    renderReport(r);
  } catch (error) {
    if (serial !== loadSerial) return;
    $('history').value = currentReport?.job ?? ''; syncHistorySelect();
    if(currentReport){const url=new URL(location.href);url.searchParams.set('audit',currentReport.job);history.replaceState(null,'',url);}
    throw new Error('This saved audit could not be loaded. Choose another run or try again.');
  }
}
function renderReport(r) {
  if (!r || !r.job || !Array.isArray(r.findings) || !r.scan) { notify('This audit report could not be read.'); return; }
  if(!Array.isArray(r.unresolved)){r={...r,unresolved:[]};notify('This saved report did not record unresolved items; its review status is incomplete.');}
  pendingAudit=null; broadcastPreview();
  currentReport = r; focusFinding=true; phase = 'pre'; filter = 'all';
  records = [...r.findings.map((f,i) => ({key:'finding-' + i, kind:'verified', title:f.title, number:i+1, data:f})),
    ...(r.unresolved || []).map((u,i) => ({key:'review-' + i, kind:'review', title:u.summary, number:r.findings.length+i+1, data:u})),
    ...(r.rejected || []).map((f,i) => ({key:'rejected-' + i, kind:'rejected', title:f.title, number:r.findings.length+(r.unresolved || []).length+i+1, data:f}))];
  selectedKey = records[0]?.key ?? null;
  const u = new URL(location.href); u.searchParams.set('audit', r.job); history.replaceState(null,'',u);
  $('history').value = r.job; syncHistorySelect();
  $('run-title').textContent = `${r.findings.length} verified ${r.findings.length === 1 ? 'issue' : 'issues'}${r.unresolved.length ? ` · ${r.unresolved.length} need review` : ''}`;
  $('run-meta').textContent = `Brain ${r.brainVersion??'version not recorded'} · ${hasMetric(r.ms)?(r.ms/1000).toFixed(1)+'s':'Time not recorded'} · ${hasMetric(r.scan.requests)?r.scan.requests+' requests':'Request count not recorded'}${r.scan.stubbedThirdParties ? ' · simulated test app' : ''}`;
  $('run-status').className = 'status-dot' + (r.unresolved.length ? ' review' : '');
  $('finding-count').textContent = r.findings.length;
  setPreviewAddress(r.url);
  $('expand-preview').disabled = !r.scan.screenshots?.pre;
  $('preview-controls').innerHTML = [['pre','Before consent'],['post','After consent']].filter(([key]) => r.scan.screenshots?.[key]).map(([key,name]) => `<button type="button" data-phase="${key}" class="${key === phase ? 'active' : ''}" aria-pressed="${key === phase}">${name}</button>`).join('');
  $('preview-controls').querySelectorAll('[data-phase]').forEach((b) => { b.onclick = () => { phase = b.dataset.phase; renderPreview(); }; });
  notify(''); renderFindings(); renderPreview(); renderEvidence(); renderLearningProof();
}
function visibleRecords() { return records.filter((r) => filter === 'all' || r.kind === filter); }
function renderFindings() {
  $('filters').innerHTML = [['all','All'],['verified','Verified'],['review','Review'],['rejected','Rejected']].map(([key,name]) => {
    const count = records.filter((r) => key === 'all' || r.kind === key).length;
    return `<button class="filter ${key === filter ? 'active' : ''}" data-filter="${key}" aria-pressed="${key === filter}">${name} ${count}</button>`;
  }).join('');
  const visible = visibleRecords();
  if (!visible.some((r) => r.key === selectedKey)) selectedKey = visible[0]?.key ?? null;
  $('finding-list').innerHTML = visible.length ? visible.map((r) => `<button class="finding-item ${r.key === selectedKey ? 'selected' : ''}" data-finding="${r.key}" aria-pressed="${r.key === selectedKey}"><span class="issue-number">${String(r.number).padStart(2,'0')}</span><span><span class="issue-title">${esc(r.title)}</span><span class="issue-meta"><i class="issue-severity ${esc(r.data.severity || '')}"></i>${r.kind === 'verified' ? esc(label(r.data.type)) : r.kind === 'review' ? 'Needs independent review' : 'Could not reproduce'}</span></span></button>`).join('') : `<div class="empty small"><span class="empty-icon" aria-hidden="true">✓</span><h3>${filter === 'all' ? 'No issues found in this scope.' : 'No ' + (filter === 'review' ? 'review items' : filter + ' findings') + '.'}</h3><p>Findings reflect only the checks this audit could run.</p></div>`;
  $('filters').querySelectorAll('[data-filter]').forEach((b) => { b.onclick = () => { filter = b.dataset.filter; renderFindings(); renderPreview(); renderEvidence(); }; });
  $('finding-list').querySelectorAll('[data-finding]').forEach((b) => { b.onclick = () => selectFinding(b.dataset.finding); });
}
function selectFinding(key) {
  const refocus = document.activeElement?.hasAttribute('data-finding');
  selectedKey = key; focusFinding=true;
  const location=locationFor(records.find(record=>record.key===key));
  if(location?.bounds)phase='pre';
  renderFindings(); renderPreview(); renderEvidence();
  if (refocus) $('finding-list').querySelector('[data-finding="' + key + '"]')?.focus({preventScroll:true});
}
function assetFor(record) { return record?.data?.evidence?.find((e) => e.kind === 'asset')?.data || record?.data?.data?.asset; }
function locationFor(record) {
  const asset=assetFor(record),data=record?.data?.data;
  const selector=asset?.selector||data?.selector;
  return (selector && currentReport?.scan?.locations?.find(item=>item.selector===selector)) || asset || (data?.bounds?data:null);
}
function validBounds(b){return b && [b.x,b.y,b.width,b.height,b.viewportWidth,b.viewportHeight].every(Number.isFinite) && b.width>0 && b.height>0 && b.viewportWidth>0 && b.viewportHeight>0 && b.x<b.viewportWidth && b.y<b.viewportHeight && b.x+b.width>0 && b.y+b.height>0;}
function renderPreview() {
  if (!currentReport) return;
  $('preview-controls').querySelectorAll('[data-phase]').forEach(b=>{const active=phase===b.dataset.phase;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
  const selected=records.find(r=>r.key===selectedKey), location=locationFor(selected);
  const positioned=focusFinding && phase==='pre' && validBounds(location?.bounds);
  const contextFile=positioned && location.contextShot && artifact(location.contextShot)?location.contextShot:null;
  const src=artifact(contextFile || currentReport.scan.screenshots?.[phase]);
  $('expand-preview').disabled=!src;
  if(!src){$('preview-stage').innerHTML='<div class="empty"><h3>No screenshot available</h3><p>This report did not capture that page state.</p></div>';return;}
  let highlight='';
  if(positioned){
    const b=location.bounds,left=Math.max(0,b.x),top=Math.max(0,b.y),right=Math.min(b.viewportWidth,b.x+b.width),bottom=Math.min(b.viewportHeight,b.y+b.height);
    highlight=`<button class="marker finding-focus-box" data-marker="${selected.key}" style="left:${left/b.viewportWidth*100}%;top:${top/b.viewportHeight*100}%;width:${(right-left)/b.viewportWidth*100}%;height:${(bottom-top)/b.viewportHeight*100}%" aria-label="Finding ${selected.number}: ${esc(selected.title)}"><span>${String(selected.number).padStart(2,'0')} · Inspecting this element</span></button>`;
  }
  const requests=selected?.data?.evidence?.filter(e=>e.kind==='request').map(e=>e.data?.url||e.summary) || [];
  const urls=requests.length?requests:(selected?.data?.data?.urls||[]);
  const network=urls.length>0 || ['unknown_third_party','undisclosed_vendor','pre_consent_tracking'].includes(selected?.data?.type);
  const kind=positioned?'Element located':network?'Network evidence':'Page-level observation';
  const explanation=positioned?'The outline marks the recorded element in this capture.':phase==='post'&&location?.bounds?'Element position was recorded before consent. Switch to Before consent to locate it.':network?'This runs behind the page and has no visible element to highlight.':'No element position was saved for this observation.';
  const policyUrl=selected?.data?.type==='undisclosed_vendor'?safeLink(currentReport.scan.policy?.url):'';
  const note=selected?`<div class="preview-finding-note" role="status"><div class="focus-note-heading"><span class="focus-number">${String(selected.number).padStart(2,'0')}</span><strong>${kind}</strong>${validBounds(location?.bounds)?`<button type="button" id="toggle-finding-focus" aria-pressed="${focusFinding}">${focusFinding?'Full page':'Locate finding'} ${focusFinding?'↗':'◎'}</button>`:''}</div><p>${esc(selected.title)}</p><small>${explanation}</small>${network&&urls.length?`<code title="${esc(urls[0])}">${esc(urls[0])}</code>`:''}${policyUrl?`<a href="${esc(policyUrl)}" target="_blank" rel="noopener noreferrer">Open captured policy source ↗</a>`:''}</div>`:'';
  $('preview-stage').dataset.focused=String(!!selected);
  $('preview-stage').innerHTML=note+`<div class="screenshot-wrap"><img class="website-shot" src="${esc(src)}" alt="${contextFile?'Element location capture':'Audited website '+(phase==='pre'?'before':'after')+' consent interaction'}">${highlight}</div>`;
  $('preview-caption').textContent=contextFile?'Element location · captured before consent':`${phase==='pre'?'Before':'After'} consent · captured evidence`;
  $('preview-location').textContent=positioned?`Finding ${selected.number} · recorded position`:network?'Network / policy evidence':'No element position recorded';
  $('preview-stage').querySelectorAll('[data-marker]').forEach(b=>b.onclick=()=>selectFinding(b.dataset.marker));
  if($('toggle-finding-focus'))$('toggle-finding-focus').onclick=()=>{focusFinding=!focusFinding;renderPreview();};
  const image=$('preview-stage').querySelector('img');
  image.onload=()=>{const box=$('preview-stage').querySelector('.finding-focus-box');if(box){const stage=$('preview-stage'),r=box.getBoundingClientRect(),s=stage.getBoundingClientRect();stage.scrollTo({top:Math.max(0,stage.scrollTop+r.top-s.top-stage.clientHeight/2+r.height/2),behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});}};
  image.onerror=()=>{$('expand-preview').disabled=true;$('preview-stage').innerHTML='<div class="empty"><h3>Screenshot unavailable</h3><p>The captured image is missing from this local run.</p></div>';};
  $('expand-preview').onclick=()=>openImage(src,contextFile?'Selected element · captured location':'Website screenshot');
}

function renderEvidence() {
  const record = records.find((r) => r.key === selectedKey);
  if (!record) { emptyEvidence(); return; }
  $('quick-copy').textContent='Copy fix prompt ↗';
  $('selection-bar').hidden=false; $('selection-label').textContent=`${String(record.number).padStart(2,'0')} · ${record.title}`; $('quick-copy').hidden=!(record.kind==='verified' && record.data.repairPrompt);
  const f = record.data, asset = assetFor(record);
  const layout=f.type==='brand_layout_review'?f.data:null;
  const visual = (currentReport.visual || []).find((v) => v.brand === f.subject && (!asset || v.selector === asset.selector)) || (currentReport.visual || []).find((v) => v.brand === f.subject);
  const official = visual?.official || f.evidence?.find((e) => e.kind === 'verification' && e.data?.provenance)?.data;
  const referenceFile = visual?.referenceFile || f.evidence?.find((e) => e.kind === 'verification' && e.file)?.file;
  const actualFile = asset?.shot || f.evidence?.find((e) => e.kind === 'asset' && e.file)?.file || visual?.actualFile;
  const isVisual = f.type === 'badge_misuse' || f.type === 'visual_review' || !!visual;
  const dlRow = (name,value) => `<div><dt>${esc(name)}</dt><dd>${esc(value)}</dd></div>`;
  const evidence = (f.evidence || []).filter((e) => !['screenshot','verification'].includes(e.kind));
  const rationale = record.kind === 'verified' || record.kind === 'rejected' ? f.rationale : 'This observation is unresolved. It is a lead for further checking, not a verified violation.';
  const notes = f.verification?.notes || [];
  const source = safeLink(official?.pageUrl);
  $('evidence').innerHTML = `<div class="evidence-kicker"><span class="tag ${record.kind}">${record.kind === 'verified' ? 'Verified issue' : record.kind === 'review' ? 'Needs review' : 'Rejected'}</span>${f.severity ? `<span class="muted">${esc(f.severity)} severity</span>` : ''}</div><h3 class="evidence-title">${esc(f.title || f.summary)}</h3><p class="evidence-description">${esc(rationale)}</p>
    ${isVisual ? `<div class="evidence-section"><div class="section-label">Artwork comparison <span>Click to expand</span></div><div class="comparison"><figure>${imageTile(actualFile,'Artwork in your app')}<figcaption>In your app</figcaption></figure><figure>${imageTile(referenceFile,'Official reference artwork')}<figcaption>${official?.referenceKind === 'official_page_example' ? 'Official page example' : 'Official reference'}</figcaption></figure></div>${!referenceFile ? '<p class="muted" style="font-size:10px;margin-top:8px">No official reference captured in this run. Geometry evidence is shown below.</p>' : ''}</div>` : ''}
    ${layout ? `<div class="evidence-section"><div class="section-label">Brand size & spacing · measured review</div><dl>${dlRow('Painted / standard height',metricFixed(layout.measuredHeight)+' / '+layout.minimumHeight+' px')}${dlRow('Measured nearest gap',layout.nearestGap===null?'Unavailable':metricFixed(layout.nearestGap)+' px')}${dlRow('Standard clear space',metricFixed(layout.standardClearSpace)+' px')}${dlRow('Limited-space alternative',metricFixed(layout.limitedClearSpace)+' px')}${dlRow('Nearest content',layout.neighbor||'Not measured')}</dl><p class="muted">DOM geometry estimate. Constrained advertising has an exception; transparent artwork and complex layouts need review.</p><a href="${esc(safeLink(layout.source))}" target="_blank" rel="noopener noreferrer">Official size and clear-space guidance ↗</a></div>`:''}
    ${asset ? `<div class="evidence-section"><div class="section-label">Measured by browser</div><dl>${dlRow('Source dimensions',`${metricValue(asset.naturalW)} × ${metricValue(asset.naturalH)} px`)}${dlRow('Painted dimensions',`${metricFixed(asset.drawnW)} × ${metricFixed(asset.drawnH)} px`)}${dlRow('Source / painted ratio',`${metricRatio(asset.naturalW,asset.naturalH)} / ${metricRatio(asset.drawnW,asset.drawnH)}`)}${dlRow('Inspection method',asset.technique)}${asset.filter && asset.filter !== 'none' ? dlRow('CSS filter',asset.filter) : ''}</dl><div class="section-label" style="margin-top:12px">Element</div><code class="selector">${esc(asset.selector)}</code></div>` : ''}
    ${source ? `<div class="evidence-section"><div class="section-label">Reference provenance</div><a href="${esc(source)}" target="_blank" rel="noopener noreferrer">Official brand guidelines ↗</a><dl>${dlRow('Retrieved',new Date(official.retrievedAt).toLocaleDateString())}${dlRow('Provenance','Linked from official page')}${dlRow('SHA-256',official.sha256)}</dl>${visual?.sourceCheck ? `<p class="muted" style="font-size:10px;margin-top:8px">${visual.sourceCheck.status === 'exact_official_bytes' ? 'Source bytes match this official reference.' : visual.sourceCheck.status === 'different_bytes_requires_review' ? 'Source bytes differ. This alone does not establish misuse.' : 'Source-byte comparison was unavailable.'}</p>` : ''}</div>` : ''}
    <div class="evidence-section"><div class="section-label">${record.kind === 'verified' ? 'Independent verification' : 'Review status'}</div><div class="verification ${record.kind === 'review' ? 'review' : ''}">${esc(notes.join(' · ') || (record.kind === 'review' ? 'Not independently verified. Further measurements or review are needed.' : f.verification?.method || 'No verification notes recorded.'))}</div>${f.verification?.method ? `<p class="muted" style="font-size:10px;margin-top:7px">${esc(f.verification.method)}</p>` : ''}</div>
    ${evidence.length ? `<div class="evidence-section"><div class="section-label">${f.type?.includes('tracking') ? 'Network evidence' : 'Audit evidence'}</div><ul class="evidence-list">${evidence.map((e) => `<li>${esc(e.summary)}</li>`).join('')}</ul></div>` : ''}
    ${record.kind === 'review' && visual?.observation ? `<div class="evidence-section"><div class="section-label">Vision observation · unverified</div><ul class="evidence-list">${visual.observation.differences.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>` : ''}
    ${record.kind === 'verified' && f.repairPrompt ? `<details class="repair-details"><summary>Read the prompt & acceptance checks</summary><pre id="repair-text">${esc(f.repairPrompt)}</pre></details><p class="muted" style="font-size:10px;margin-top:10px">Recommended fix · not applied or tested on your code.</p>` : ''}`;
  $('evidence-actions').hidden = !(record.kind === 'verified' && f.repairPrompt);
  $('evidence-actions').innerHTML = record.kind === 'verified' && f.repairPrompt ? '<button class="primary repair-button" id="copy-prompt">Copy fix prompt <span aria-hidden="true">↗</span></button>' : '';
  $('evidence').querySelectorAll('[data-image]').forEach((b) => { b.onclick = () => openImage(b.dataset.image,b.dataset.title); });
  $('evidence').querySelectorAll('.image-tile img').forEach((img) => { img.onerror = () => { const parent = img.parentElement; parent.classList.add('missing'); parent.textContent = 'Image unavailable'; parent.disabled = true; }; });
  if ($('copy-prompt')) $('copy-prompt').onclick = async () => {
    try { await navigator.clipboard.writeText(f.repairPrompt); $('copy-prompt').textContent = 'Copied to clipboard ✓'; $('quick-copy').textContent='Copied ✓'; notify('Fix prompt copied to clipboard.'); }
    catch { $('evidence').querySelector('.repair-details').open = true; const range = document.createRange(); range.selectNodeContents($('repair-text')); getSelection().removeAllRanges(); getSelection().addRange(range); notify('Clipboard access was unavailable. The fix prompt is selected for you to copy.'); }
  };
}
function openImage(src,title) {
  if (!src || !src.startsWith('/artifacts/')) return;
  $('image-error').hidden=true;$('dialog-image').hidden=false;$('image-dialog').setAttribute('aria-busy','true');
  $('dialog-image').src=src;$('dialog-title').textContent=title;if(!$('image-dialog').open)$('image-dialog').showModal();
}
$('dialog-image').onload=()=>{$('image-dialog').setAttribute('aria-busy','false');};
$('dialog-image').onerror=()=>{$('dialog-image').hidden=true;$('image-error').hidden=false;$('image-dialog').setAttribute('aria-busy','false');};
$('expand-preview').onclick = () => openImage(artifact(currentReport?.scan.screenshots?.[phase]),'Website screenshot · ' + (phase === 'pre' ? 'before consent' : 'after consent'));
$('close-dialog').onclick = () => $('image-dialog').close();
$('image-dialog').addEventListener('click',(e) => { if (e.target === $('image-dialog')) $('image-dialog').close(); });
function showLearning(open) { showView(open ? 'learning' : 'inspection'); }
$('learning-toggle').onclick = () => showView('learning');
$('close-learning').onclick = () => { showView('inspection'); $('nav-inspect').focus(); };
$('history').onchange = () => { if ($('history').value) { followLive = false; loadReport($('history').value).catch((e) => notify(e.message)); } };

async function refreshBrain() {
  let b;
  try { b = await readJson('/api/brain'); if (!Array.isArray(b.versions) || !b.brain) throw new Error(); }
  catch { $('ver').disabled = true; $('brain-label').textContent = 'Unavailable'; syncVersionSelect(); setBusy(busyState); throw new Error('Brain metadata could not be loaded. Reload to retry.'); }
  $('ver').disabled = false; setBusy(busyState);
  const cur = $('ver').value;
  $('ver').innerHTML = b.versions.map(v=>`<option value="${v.version}">brain ${v.version}${v.version===b.active?' (active)':''}</option>`).join('');
  $('ver').value=b.versions.some(v=>v.version===cur)?cur:b.active;
  $('brain-label').textContent=b.active;
  learningState.brain=b;renderLearningProof();
  const stat=(value,name)=>`<div class="brain-stat"><strong>${esc(value)}</strong><span>${name}</span></div>`;
  $('timeline').innerHTML=`<div class="lab-card"><div class="lab-card-heading"><h3>Team memory</h3><span class="lab-badge">${esc(b.active)} active</span></div><div class="brain-stats">${stat(b.brain.vendors.length,'Known vendors')}${stat(b.brain.probes.length,'Checking abilities')}${stat(b.versions.length,'Versions')}</div><div class="version-path" aria-label="Version history">${b.versions.map((v,i)=>`${i?'<span class="path-arrow" aria-hidden="true">→</span>':''}<span class="version-node ${v.version===b.active?'current':''}">${esc(v.version)}${v.version===b.active?'<i>ACTIVE</i>':''}</span>`).join('')}</div></div>`;
  $('timeline').innerHTML += b.decisions.length?b.decisions.slice().reverse().map(d=>{
    const candidate=b.versions.find(v=>v.version===d.candidate);
    const probes=candidate?.addedProbes ?? [];
    const vendors=candidate?.addedVendors ?? [];
    const before=d.parentMetrics ?? {}, after=d.candidateMetrics ?? {};
    const measured=value=>typeof value==='number'&&Number.isFinite(value);
    const metric=(value,name)=>`<div><strong>${esc(value)}</strong><span>${name}</span></div>`;
    const pair=(a,z)=>measured(a)&&measured(z)?`${a} → ${z}`:'Not measured';
    const benchmark=measured(before.tp)&&measured(after.tp);
    const reviewed=!benchmark&&measured(before.unknownVendors)&&measured(after.unknownVendors);
    const delta=benchmark?after.tp-before.tp:null;
    const metrics=reviewed
      ? metric(pair(before.unknownVendors,after.unknownVendors),'unrecognized vendors')+metric(measured(after.regressionTestsPassed)?after.regressionTestsPassed:'Not measured','regression tests passed')+metric(after.disclosureCandidate===true?'Candidate found':after.disclosureCandidate===false?'No candidate':'Not measured','disclosure check')
      : metric(benchmark?`${delta>0?'+':''}${delta}`:'Not measured','issues found')+metric(pair(before.unresolved,after.unresolved),'unresolved')+metric(measured(after.fp)?after.fp:'Not measured','false findings');
    return `<article class="lab-card decision-card"><div class="lab-card-heading"><h3><span class="decision-icon ${d.accepted?'pass':'review'}">${d.accepted?'✓':'×'}</span>${esc(d.parent)} <span class="muted">→</span> ${esc(d.candidate)}</h3><span class="lab-badge ${d.accepted?'pass':'review'}">${reviewed?'Reviewed update':d.accepted?'Promoted':'Not promoted'}</span></div><div class="decision-metrics">${metrics}</div><div class="ability-chips">${probes.map(p=>`<span>⌘ ${esc(p.id||p.name||'Learned checker')}</span>`).join('')}${vendors.map(v=>`<span>◎ ${esc(v.name||v.id||'Vendor knowledge')}</span>`).join('')}</div><details class="lab-details"><summary>Why this version ${reviewed?'was reviewed':d.accepted?'passed':'was rejected'}</summary><p>${esc((d.reasons??[]).join(' '))}</p>${candidate?`<p class="muted">${esc(candidate.changelog.join(' '))}</p>`:''}${vendors.length?`<details><summary>Vendor knowledge & sources</summary><pre>${esc(JSON.stringify(vendors,null,2))}</pre></details>`:''}${probes.length?`<details><summary>Agent-written checker code</summary>${probes.map(p=>`<pre>${esc(p.code)}</pre>`).join('')}</details>`:''}</details></article>`;
  }).join(''):'<div class="lab-card lab-empty"><span>◎</span><h3>Ready to learn</h3><p>Run a learning cycle to propose and test a new ability.</p></div>';
}
async function renderEval() {
  const e = await (await fetch('/api/eval/latest')).json();
  learningState.benchmark=e;renderLearningProof();
  if (!e) { $('evalbox').innerHTML = '<p class="muted">No version comparison has been saved yet.</p>'; return; }
  const B = e.before?.metrics ?? {}, A = e.after?.metrics ?? {};
  const beforeVersion = e.before?.version ?? 'Version unavailable', afterVersion = e.after?.version ?? 'Version unavailable';
  const pct = value => hasMetric(value) && value >= 0 && value <= 1 ? Math.round(value * 100) : null;
  const issueCount = metrics => hasMetric(metrics.tp) && hasMetric(metrics.fn) ? `${metrics.tp} / ${metrics.tp + metrics.fn}` : 'Not measured';
  const recall = metrics => pct(metrics.recall) === null ? 'Not measured' : `${pct(metrics.recall)}%`;
  const elapsed = metrics => hasMetric(metrics.ms) ? `${(metrics.ms / 1000).toFixed(1)}s` : 'Not measured';
  const ring = (metrics, version, isAfter) => {
    const score = pct(metrics.recall), description = `${version}: ${issueCount(metrics)} issues found; recall ${recall(metrics)}`;
    return `<div class="score-version ${isAfter?'after':'before'}"><span class="score-caption">${isAfter?'AFTER':'BEFORE'} · ${esc(version)}</span><div class="score-ring"><svg viewBox="0 0 120 120" role="img" aria-label="${esc(description)}"><circle class="ring-track" cx="60" cy="60" r="49"/>${score === null ? '' : `<circle class="ring-fill" cx="60" cy="60" r="49" pathLength="100" stroke-dasharray="${score} 100"/>`}</svg><strong>${score ?? '—'}${score === null ? '' : '<small>%</small>'}</strong></div><span class="score-label">${issueCount(metrics)}${issueCount(metrics)==='Not measured'?'':' issues found'}</span></div>`;
  };
  const row = (name,b,a) => `<tr><td>${name}</td><td>${esc(b)}</td><td>${esc(a)}</td></tr>`;
  const apps = Array.isArray(e.apps) ? e.apps : [];
  const beforeApps = Array.isArray(B.apps) ? B.apps : [], afterApps = Array.isArray(A.apps) ? A.apps : [];
  $('evalbox').classList.remove('muted');
  $('evalbox').innerHTML = `<article class="lab-card comparison-card"><div class="lab-card-heading"><h3>Does the team get better?</h3><span class="lab-badge">Reserved test apps</span></div><div class="score-comparison">${ring(B,beforeVersion,false)}<span class="score-arrow" aria-hidden="true">↗</span>${ring(A,afterVersion,true)}</div><div class="comparison-stats"><div><strong>${metricValue(A.fp)}</strong><span>false findings</span><small>Previously ${metricValue(B.fp)}</small></div><div><strong>${metricValue(B.unresolved)}<span class="muted"> → </span>${metricValue(A.unresolved)}</strong><span>unresolved items</span></div></div><p class="lab-scope">${apps.length ? 'Measured on '+apps.map(a=>esc(NAMES[a]||a)).join(' + ') : 'Test apps not recorded'} · small synthetic test set</p><details class="lab-details"><summary>Inspect test results & run costs</summary><table><tr><th>Metric</th><th>${esc(beforeVersion)}</th><th>${esc(afterVersion)}</th></tr>${row('Issues found',issueCount(B),issueCount(A))}${row('Recall',recall(B),recall(A))}${row('False findings',metricValue(B.fp),metricValue(A.fp))}${row('Unresolved',metricValue(B.unresolved),metricValue(A.unresolved))}${row('Audit time',elapsed(B),elapsed(A))}${e.llm?row('Model calls / tokens',`${metricValue(B.llmCalls)} / ${metricValue(B.tokens)}`,`${metricValue(A.llmCalls)} / ${metricValue(A.tokens)}`):''}</table>${afterApps.map(a=>{
    const before=beforeApps.find(x=>x.app===a.app);
    const added=Array.isArray(a.tp) && Array.isArray(before?.tp) ? a.tp.filter(k=>!before.tp.includes(k)) : null;
    return `<p><b>${esc(NAMES[a.app]||a.app||'App unavailable')}</b> · ${added===null?'Per-app comparison not measured':added.length?esc(added.join(', ')):'No new findings'}</p>`;
  }).join('')}</details></article>`;
}
async function renderFresh() {
  const r=await (await fetch('/api/eval/fresh/latest')).json();
  learningState.transfer=r;renderLearningProof();
  if(!r){$('freshbox').innerHTML='<p class="muted">No fresh-app transfer check has been saved yet.</p>';return;}
  if(!Array.isArray(r.results)||!r.results.length||!Array.isArray(r.learnedIds)||r.results.some(a=>!['expected','found','missed','falseFindings'].every(key=>Array.isArray(a[key])))){
    $('freshbox').innerHTML='<article class="lab-card"><h3>Transfer results unavailable</h3><p class="muted">This saved run is incomplete. Run Benchmark transfer to collect a complete result.</p></article>';return;
  }
  const candidates=r.from===r.to?r.results.slice(r.results.length/2):r.results.filter(a=>a.version===r.to);
  const cards=candidates.map(a=>{
    const before=r.results.find(x=>x.app===a.app&&x.version===r.from);
    const control=a.expected.length===0;
    const passed=a.missed.length===0&&a.falseFindings.length===0;
    return `<div class="transfer-case"><div class="transfer-case-icon ${passed?'pass':'review'}">${control?'◇':'⌕'}</div><div><h4>${control?'Clean control':'New app with a seeded issue'}</h4><span>${esc(a.app)} · ${control?'Checks for false alarms':'Checks for a learned detection'}</span></div><div class="case-result ${passed?'pass':'review'}"><strong>${control?`${a.falseFindings.length} false alarms`:`${Array.isArray(before?.found)?before.found.length:'Not measured'} → ${a.found.length} found`}</strong><span>${passed?(control?'Stayed clean':'Issue detected'):`${a.missed.length} missed · ${a.falseFindings.length} false`}</span></div></div>`;
  }).join('');
  $('freshbox').classList.remove('muted');
  $('freshbox').innerHTML=`<article class="lab-card transfer-card"><div class="lab-card-heading"><div><span class="eyebrow">THE TRANSFER TEST</span><h3>Can it use the new skill elsewhere?</h3></div><span class="lab-badge ${r.transferred?'pass':'review'}">${r.transferred?'✓ Passed':'not proven'}</span></div><div class="transfer-path"><div><span class="path-symbol">⌘</span><b>${esc(r.to??'Version unavailable')} frozen</b><small>${r.unchanged?'Candidate locked':'Candidate changed'}</small></div><span class="path-arrow" aria-hidden="true">→</span><div><span class="path-symbol">▧</span><b>Fresh apps</b><small>Generated afterward</small></div><span class="path-arrow" aria-hidden="true">→</span><div><span class="path-symbol">${r.transferred?'✓':'?'}</span><b>${r.transferred?'Skill transferred':'Not proven'}</b><small>${r.results.every(a=>a.modelCalls===0)?'Zero model calls':'See model usage below'}</small></div></div><div class="transfer-cases">${cards}</div><div class="transfer-caption"><span>${r.learnedIds.map(esc).join(' · ')||'No learned checker'}</span><span>Two synthetic apps · limited proof of transfer</span></div><details class="lab-details"><summary>Inspect transfer evidence</summary><p>Candidate ${esc(r.to??'Version unavailable')} frozen before generating test sites. These use stand-in artwork and do not establish real-world accuracy.</p><table><tr><th>Version</th><th>App</th><th>Found</th><th>Missed</th><th>False findings</th><th>Model calls</th></tr>${r.results.map(a=>`<tr><td>${esc(a.version??'Version unavailable')}</td><td>${esc(a.app)}</td><td>${a.found.length}</td><td>${a.missed.length}</td><td>${a.falseFindings.length}</td><td>${metricValue(a.modelCalls)}</td></tr>`).join('')}</table></details></article>`;
}

async function post(url, body = {}) {
  notify(''); setBusy(true);
  try {
    const res = await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const j = await res.json(); if (!res.ok) throw new Error(j.error || 'The operation could not be started.');
    return j;
  } catch (e) { notify(e.message || 'Could not connect to the local server.'); setBusy(false); await refreshStatus().catch(() => {}); return false; }
}
$('audit-form').onsubmit = async (e) => {
  e.preventDefault(); if(busyState)return;
  const field = $('url'); let target = field.value.trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(target) && /^[^\s/]+\.[^\s/]+(?:[/?#]|$)/.test(target)) target = 'https://' + target;
  let valid = /^fixture:app-[a-z0-9-]+$/.test(target);
  if (!valid) { try { const url = new URL(target); valid = /^https?:$/.test(url.protocol) && !url.username && !url.password; } catch {} }
  if (!valid) { field.setCustomValidity('Enter an http(s) website URL, such as https://example.com.'); field.reportValidity(); field.focus(); notify('Enter a valid website URL. Your saved audit has been kept.'); return; }
  field.setCustomValidity(''); field.value = target;
  followLive=true; beginAuditPreview(target);
  const started=await post('/api/audit',{url:$('url').value.trim(),version:$('ver').value});
  if(started){
    if(pendingAudit && started.job){pendingAudit={...pendingAudit,job:started.job,url:started.url};setPreviewAddress(started.url);broadcastPreview();}
    $('activity').open=true;
  }else{
    followLive=false; pendingAudit=null; broadcastPreview();
    $('run-status').className='status-dot review'; $('run-title').textContent='Audit could not start';
    $('preview-caption').textContent='No capture available';
    $('preview-stage').innerHTML='<div class="empty"><h3>No preview available</h3><p>Correct the audit request and try again.</p></div>'; $('run-meta').textContent='No audit was started';
  }
};
$('lab-view-activity').onclick = () => showView('activity');
$('lab-view-result').onclick = () => { if (labOperation) { showView('learning'); openLearningEvidence(LAB_ACTIONS[labOperation.id].target); $(LAB_ACTIONS[labOperation.id].target).scrollIntoView({ behavior: 'smooth', block: 'start' }); } };
$('learn-checker').onclick = () => runLabAction('learn-checker', '/api/learn/checker');
$('learn-real').onclick = () => runLabAction('learn-real', '/api/learn/real');
$('learn').onclick = () => post('/api/learn');
$('eval').onclick = () => runLabAction('eval', '/api/eval');
$('fresh').onclick = () => runLabAction('fresh', '/api/eval/fresh');
$('reset').onclick = () => { if(!busyState){$('reset-dialog').showModal();$('cancel-reset').focus();} };
$('cancel-reset').onclick = () => $('reset-dialog').close();
$('confirm-reset').onclick = async () => { $('reset-dialog').close(); if(await post('/api/reset')){setBusy(false);await refreshStatus();await refreshBrain();notify('The shared brain was reset to v0. Saved audit reports were kept.');} };
const es = new EventSource('/api/events');
es.onmessage = async (m) => {
  try {
    const e = JSON.parse(m.data);
    if (e.msg === '__idle__') {
      const updates = await Promise.allSettled([refreshStatus(), refreshBrain(), refreshHistory(), renderRealLearning(), renderCheckerLearning(), renderEval(), renderFresh()]);
      if (!status.busy && labOperation && ['starting','running'].includes(labOperation.state) && e.t >= labOperation.startedAt) updateLabOperation(labOperation.id, 'completed', updates.some(result=>result.status==='rejected') ? 'Finished. Some result panels could not be reloaded; refresh to retry.' : 'Finished. The results below have been updated.');
      return;
    }
    updateLabProgress(e);
    if(followLive && pendingAudit?.job===e.job && e.data?.preview)updateAuditPreview(e.data.preview,e.job);
    if(busyState && ['scanner','vision','investigator','verifier','fixer','learner','research','gate'].includes(e.role)){activeAgentRole=e.role; workedAgentRoles.add(['research','gate'].includes(e.role)?'learner':e.role); broadcastActivity();}
    events++; $('event-count').textContent = `${events} events`; $('activity-last').textContent = e.msg;
    const div = document.createElement('div'); div.className = 'ev ' + (['warn','error','llm'].includes(e.kind) ? e.kind : e.role === 'llm' ? 'llm' : '');
    const role = document.createElement('span'); role.className = 'r'; role.textContent = e.role;
    div.append(role,document.createTextNode(e.msg)); $('trace').appendChild(div);
    if ($('trace').childElementCount > 500) $('trace').firstElementChild.remove();
    $('trace').scrollTop = $('trace').scrollHeight;
    if (e.kind === 'error' && followLive) notify(e.msg);
    if(e.role==='controller' && e.kind==='error' && pendingAudit){pendingAudit=null;broadcastPreview();$('run-title').textContent='Audit stopped';$('preview-caption').textContent='Last capture · audit did not complete';}
    if (e.role === 'controller' && e.kind === 'done' && e.data?.job && !/^(eval-|fresh-)/.test(e.data.job) && (followLive ? pendingAudit?.job===e.data.job : !currentReport && !pendingAudit)) {
      await loadReport(e.data.job); followLive = false; await refreshHistory();
    }
    if (e.role === 'gate') await refreshBrain();
    if (e.role === 'eval' && e.kind === 'done') { await renderEval(); await renderFresh(); }
  } catch (e) { notify('Could not update the workspace. ' + e.message); }
};
es.onerror = () => { $('activity-last').textContent = 'Reconnecting to agent activity…'; };
async function init() {
  const updates = await Promise.allSettled([refreshStatus(),refreshBrain(),renderEval(),renderFresh(),renderRealLearning(),renderCheckerLearning()]);
  try { await refreshHistory(true); }
  catch (error) { notify(error.message || 'Saved audits could not be loaded. Reload to retry.'); return; }
  if (updates.some(result=>result.status==='rejected')) notify('Some workspace data could not be loaded. Available saved audits still work; reload to retry.');
}
init();

function tabEntries(){return [['inspection','nav-inspect','view-inspection'],['evidence','nav-evidence','view-evidence'],['learning','learning-toggle','n1'],['activity','nav-activity','view-activity']];}
function showView(view,updateHistory=true){
  if(!tabEntries().some(([name])=>name===view))view='inspection';
  // Reuse the same finding/evidence state across views, rather than duplicating it.
  const dock=$(view==='evidence'?'evidence-dock':'inspection-dock');
  dock.append($('report'),$('selection-bar'));
  for(const [name,tab,panel] of tabEntries()){
    const active=name===view;$(panel).hidden=!active;$(tab).classList.toggle('active',active);$(tab).setAttribute('aria-selected',String(active));$(tab).tabIndex=active?0:-1;
  }
  $('learning-toggle').setAttribute('aria-expanded',String(view==='learning'));
  if(view==='activity')$('activity').open=true;
  document.body.dataset.view=view;
  if(updateHistory){const url=new URL(location.href);if(view==='inspection')url.searchParams.delete('view');else url.searchParams.set('view',view);if(url.href!==location.href)history.pushState(null,'',url);}
  window.dispatchEvent(new CustomEvent('clueso:view',{detail:{view,panel:tabEntries().find(([name])=>name===view)[2]}}));
}
$('nav-inspect').onclick=()=>showView('inspection');
$('nav-evidence').onclick=()=>showView('evidence');
$('nav-activity').onclick=()=>showView('activity');
$('inspect-selection').onclick=()=>showView('evidence');
for(const [view,id] of tabEntries())$(id).addEventListener('keydown',e=>{
  const tabs=tabEntries();let index=tabs.findIndex(([,tab])=>tab===id);
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;
  e.preventDefault();index=e.key==='Home'?0:e.key==='End'?tabs.length-1:(index+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
  showView(tabs[index][0]);$(tabs[index][1]).focus();
});
window.addEventListener('popstate', async () => {
  ++loadSerial; // Invalidate an earlier navigation even when this report is already displayed.
  const url = new URL(location.href), job = url.searchParams.get('audit');
  showView(url.searchParams.get('view') || 'inspection', false);
  if (job && job !== currentReport?.job) { followLive = false; try { await loadReport(job); } catch (error) { notify(error.message); } }
});
showView(new URL(location.href).searchParams.get('view')||'inspection',false);
$('quick-copy').onclick=()=>$('copy-prompt')?.click();
const commandActions=[
 {name:'Run website audit',hint:'Inspect',enabled:()=>!busyState,unavailable:'Another job is running',run:()=>{showView('inspection');if(!busyState)$('audit-form').requestSubmit();}},
 {name:'Copy selected fix prompt',hint:'Copy',enabled:()=>!!$('copy-prompt'),unavailable:'Select a verified finding with a fix prompt',run:()=>{$('copy-prompt')?.click();}},
 {name:'Show findings needing review',hint:'Filter',run:()=>{filter='review';renderFindings();renderPreview();renderEvidence();showView('inspection');}},
 {name:'Next finding',hint:'Select',enabled:()=>visibleRecords().length>0,unavailable:'No findings are available',run:()=>{const items=visibleRecords();if(items.length){selectFinding(items[(items.findIndex(r=>r.key===selectedKey)+1)%items.length].key);if(document.body.dataset.view!=='evidence')showView('inspection');}}},
 {name:'Open learning lab',hint:'N+1',run:()=>showLearning(true)},
 {name:'Open agent activity',hint:'Live',run:()=>{showView('activity');}},
 {name:'Show before consent',hint:'Preview',enabled:()=>!!currentReport?.scan.screenshots?.pre,unavailable:'No before-consent screenshot was captured',run:()=>{phase='pre';renderPreview();showView('inspection');}},
 {name:'Show after consent',hint:'Preview',enabled:()=>!!currentReport?.scan.screenshots?.post,unavailable:'No after-consent screenshot was captured',run:()=>{phase='post';renderPreview();showView('inspection');}}
];
let commandIndex=0, matchedCommands=[];
function commandAvailable(command){return !command.enabled || command.enabled();}
function renderCommands(){
  matchedCommands=commandActions.filter(c=>c.name.toLowerCase().includes($('command-search').value.toLowerCase()));
  if(!matchedCommands[commandIndex] || !commandAvailable(matchedCommands[commandIndex]))commandIndex=matchedCommands.findIndex(commandAvailable);
  $('command-results').innerHTML=matchedCommands.length?matchedCommands.map((c,i)=>`<button type="button" class="command-item ${i===commandIndex?'active':''}" data-command="${i}" ${commandAvailable(c)?'':'disabled'}><span aria-hidden="true">↗</span>${esc(c.name)}<span>${esc(commandAvailable(c)?c.hint:c.unavailable)}</span></button>`).join(''):'<div class="empty small" style="min-height:80px;padding:15px">No matching actions.</div>';
  $('command-results').querySelectorAll('[data-command]').forEach(button=>button.onclick=()=>runCommand(Number(button.dataset.command)));
}
function runCommand(i){const c=matchedCommands[i];if(!c||!commandAvailable(c))return;$('command-dialog').close();c.run();}
function openCommands(){commandIndex=0;$('command-search').value='';renderCommands();if(!$('command-dialog').open)$('command-dialog').showModal();$('command-search').focus();}
$('open-commands').onclick=openCommands;
$('close-commands').onclick=()=>$('command-dialog').close();
$('command-search').oninput=()=>{commandIndex=0;renderCommands();};
$('command-dialog').addEventListener('keydown',e=>{
  if(e.isComposing)return;
  if(e.key==='Enter'){if(e.target===$('command-search')){e.preventDefault();runCommand(commandIndex);}return;}
  if(!['ArrowDown','ArrowUp'].includes(e.key)||e.target===$('close-commands'))return;
  e.preventDefault();const enabled=matchedCommands.map((command,index)=>commandAvailable(command)?index:-1).filter(index=>index>=0);if(!enabled.length)return;
  const focused=e.target.closest('[data-command]');const current=focused?Number(focused.dataset.command):commandIndex;
  const index=enabled.indexOf(current);commandIndex=enabled[(index+(e.key==='ArrowDown'?1:-1)+enabled.length)%enabled.length];renderCommands();
  if(focused)$('command-results').querySelector(`[data-command="${commandIndex}"]`)?.focus();
});
$('command-dialog').addEventListener('click',e=>{if(e.target===$('command-dialog'))$('command-dialog').close();});
document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();openCommands();}});

function applyTheme(theme){
  const dark=theme==='dark';document.documentElement.dataset.theme=dark?'dark':'light';
  $('theme-toggle').setAttribute('aria-pressed',String(dark));$('theme-toggle').setAttribute('aria-label',dark?'Switch to light mode':'Switch to dark mode');$('theme-toggle').innerHTML=dark?'☀ <span>Light</span>':'☾ <span>Dark</span>';
  document.querySelector('meta[name="theme-color"]').content=dark?'#060813':'#edf1fb';
  try{localStorage.setItem('clueso-theme',dark?'dark':'light');}catch{/* Theme still works if storage is unavailable. */}
  window.dispatchEvent(new CustomEvent('clueso:theme',{detail:{theme:dark?'dark':'light'}}));
}
$('theme-toggle').onclick=()=>applyTheme(document.documentElement.dataset.theme==='dark'?'light':'dark');
window.addEventListener('storage',e=>{if(e.key==='clueso-theme')applyTheme(e.newValue==='dark'?'dark':'light');});
applyTheme(document.documentElement.dataset.theme==='dark'?'dark':'light');

// Theme-matched listboxes retain the native select as the source of form values.
function upgradeSelect(id){
  const select=$(id),wrapper=document.createElement('div'),trigger=document.createElement('button'),menu=document.createElement('div');
  wrapper.className='select-control '+(id==='history'?'history-control':'version-control');
  select.before(wrapper);wrapper.append(select,trigger,menu);
  trigger.type='button';trigger.className='select-trigger';trigger.id=id+'-trigger';trigger.setAttribute('role','combobox');trigger.setAttribute('aria-haspopup','listbox');trigger.setAttribute('aria-expanded','false');trigger.setAttribute('aria-controls',id+'-menu');trigger.setAttribute('aria-label',select.getAttribute('aria-label')||'Choose an option');
  menu.id=id+'-menu';menu.className='select-menu';menu.setAttribute('role','listbox');menu.setAttribute('aria-label',select.getAttribute('aria-label')||'Options');menu.setAttribute('popover','auto');
  select.hidden=true;select.tabIndex=-1;
  document.querySelectorAll(`label[for="${id}"]`).forEach(label=>label.htmlFor=trigger.id);
  function sync(){
    const wasOpen=menu.matches(':popover-open'), scroll=menu.scrollTop;
    const focused=menu.contains(document.activeElement)?document.activeElement.dataset.optionValue:null;
    const selected=select.options[select.selectedIndex];
    const text=(selected?.textContent||'Choose').replace(/\s*\(active\)/g,'');
    trigger.innerHTML=`<span>${esc(text)}</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>`;
    trigger.disabled=select.disabled;
    menu.innerHTML=[...select.options].map((o,i)=>`<button type="button" role="option" aria-selected="${o.selected}" data-option="${i}" data-option-value="${esc(o.value)}" ${o.disabled?'disabled':''}><span class="option-check" aria-hidden="true">${o.selected?'✓':''}</span><span>${esc(o.textContent.replace(/\s*\(active\)/g,''))}</span></button>`).join('');
    menu.querySelectorAll('[data-option]').forEach(button=>button.onclick=()=>{select.selectedIndex=Number(button.dataset.option);select.dispatchEvent(new Event('change',{bubbles:true}));sync();menu.hidePopover();trigger.focus();});
    if(wasOpen){if(focused!==null)[...menu.querySelectorAll('[data-option]')].find(button=>button.dataset.optionValue===focused)?.focus({preventScroll:true});menu.scrollTop=scroll;}
  }
  function place(){const rect=trigger.getBoundingClientRect();const width=Math.min(Math.max(rect.width,id==='history'?290:200),innerWidth-24);menu.style.width=width+'px';menu.style.left=Math.min(Math.max(12,rect.left),innerWidth-width-12)+'px';menu.style.top=Math.min(rect.bottom+8,Math.max(12,innerHeight-menu.offsetHeight-12))+'px';}
  function open(last=false){sync();menu.showPopover();place();trigger.setAttribute('aria-expanded','true');const options=[...menu.querySelectorAll('[role=option]:not(:disabled)')];(last?options.at(-1):menu.querySelector('[aria-selected=true]')||options[0])?.focus();}
  trigger.onclick=()=>menu.matches(':popover-open')?menu.hidePopover():open();
  trigger.onkeydown=e=>{if(['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();open(e.key==='ArrowUp');}};
  menu.addEventListener('keydown',e=>{const options=[...menu.querySelectorAll('[role=option]:not(:disabled)')];const index=options.indexOf(document.activeElement);if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();const next=e.key==='Home'?0:e.key==='End'?options.length-1:(index+(e.key==='ArrowDown'?1:-1)+options.length)%options.length;options[next]?.focus();}if(e.key==='Escape'){e.preventDefault();menu.hidePopover();trigger.focus();}if(e.key==='Tab'){menu.hidePopover();trigger.focus();}});
  menu.addEventListener('toggle',()=>trigger.setAttribute('aria-expanded',String(menu.matches(':popover-open'))));
  select.addEventListener('change',sync);
  new MutationObserver(sync).observe(select,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled','selected']});
  window.addEventListener('resize',()=>{if(menu.matches(':popover-open'))place();});
  // Menu scrolling (including keyboard focus) must not dismiss the popover.
  window.addEventListener('scroll',event=>{
    if(!menu.matches(':popover-open')||(event.target instanceof Node&&menu.contains(event.target)))return;
    const rect=trigger.getBoundingClientRect();
    if(rect.bottom<0||rect.top>innerHeight)menu.hidePopover();else place();
  },true);
  sync();return sync;
}
const syncVersionSelect=upgradeSelect('ver'),syncHistorySelect=upgradeSelect('history');

$('url').addEventListener('input',()=>{$('url').setCustomValidity('');syncExampleSelection();});

async function renderRealLearning(){
  const response=await fetch('/api/learn/real/latest');
  if(response.status===404)return; // Existing audits can finish while the server is upgraded.
  if(!response.ok)throw new Error('Could not load the real-site experiment.');
  const result=await response.json();
  if(result && (!Array.isArray(result.results)||!Array.isArray(result.learnedVendors)||!result.training||!Array.isArray(result.training.unknownDomains))){
    window.cluesoLearning=null;window.dispatchEvent(new CustomEvent('clueso:learning',{detail:null}));
    $('real-learning').innerHTML='<article class="lab-card"><h3>Real-site results unavailable</h3><p class="muted">This saved experiment is incomplete. Run Learn on Zup to collect a complete result.</p></article>';return;
  }
  window.cluesoLearning=result;
  window.dispatchEvent(new CustomEvent('clueso:learning',{detail:result}));
  if(!result){$('real-learning').innerHTML='<article class="lab-card real-learning-card"><div class="lab-card-heading"><h3>Real-site learning</h3><span class="lab-badge">Ready</span></div><p class="lab-scope">Learn from Zup. Freeze the candidate. Test Mojo, Captions, and Ripl with no inference.</p></article>';return;}
  const targetCount=result.results.length;
  const transferred=result.results.filter(site=>site.knowledgeTransferred).length;
  $('real-learning').innerHTML=`<article class="lab-card real-learning-card"><div class="lab-card-heading"><div><span class="eyebrow">REAL PUBLIC WEBSITES</span><h3>Learn on Zup → test elsewhere</h3></div><span class="lab-badge ${result.knowledgeTransferred?'pass':'review'}">${result.knowledgeTransferred?'Recognition transferred':'Transfer not proven'}</span></div><div class="brain-stats"><div class="brain-stat"><strong>${result.learnedVendors.length}</strong><span>Vendor rules proposed</span></div><div class="brain-stat"><strong>${transferred} / ${targetCount}</strong><span>Sites with reproduced recognition</span></div><div class="brain-stat"><strong>${typeof result.newExecutableCheckerLearned==='boolean'?(result.newExecutableCheckerLearned?1:0):'Not measured'}</strong><span>New executable checkers</span></div></div><div class="real-sites-list">${result.results.map(site=>{const source=safeLink(site.url);return `<div><a href="${esc(source)}" target="_blank" rel="noopener noreferrer">${esc(source?new URL(source).hostname:'Site unavailable')}</a><span class="lab-badge ${site.knowledgeTransferred?'pass':'review'}">${site.error?'Scan unavailable':site.knowledgeTransferred?'Reproduced':'No transfer observed'}</span></div>`;}).join('')}</div><p class="lab-scope">${result.unchanged?'Candidate unchanged':'Candidate integrity failed'} · ${metricValue(result.modelCallsDuringTransfer)} model calls during transfer · ${result.promoted?'Promoted':'Candidate only; active brain unchanged'}</p><p class="real-learning-note">${result.newExecutableCheckerLearned?'Executable checker evidence is listed below.':'Zup’s current store badges were already measurable. This run learns vendor knowledge, not new checking code.'} Real-site accuracy and violation detection are not established by this experiment.</p><details class="lab-details"><summary>Inspect real-site experiment evidence</summary><p>${esc(result.scope)}</p><p>Frozen ${esc(result.frozenAt??'not recorded')} · SHA-256 ${esc(result.fingerprint??'not recorded')}</p><pre>${esc(JSON.stringify(result,null,2))}</pre></details></article>`;
}

async function renderCheckerLearning(){
  const response=await fetch('/api/learn/checker/latest');if(response.status===404)return;if(!response.ok)throw new Error('Could not load real checker experiment');
  const result=await response.json();
  learningState.checker=result;renderLearningProof();
  if(!result){$('real-checker-learning').innerHTML='<article class="lab-card real-checker-card"><div class="lab-card-heading"><h3>Learn a new checking ability on real websites</h3><span class="lab-badge">Ready</span></div><p class="lab-scope">Train on Biuty’s unmeasured SVG artwork. Freeze the generated code, then test Mojo, Captions and Ripl without inference.</p></article>';return;}
  if(result.status==='failed'){$('real-checker-learning').innerHTML=`<article class="lab-card real-checker-card"><div class="lab-card-heading"><h3>No new checker accepted</h3><span class="lab-badge review">Learning attempt failed</span></div><p class="lab-scope">The SVG checker did not pass development validation. The active brain was not changed. Open the attempt below for the exact failures.</p><details class="lab-details"><summary>Inspect the attempt</summary><pre>${esc(JSON.stringify(result,null,2))}</pre></details></article>`;return;}
  const passed=result.executableCheckerTransferProven;
  const sites=result.results.filter(site=>site.transferred).length;
  $('real-checker-learning').innerHTML=`<article class="lab-card real-checker-card"><div class="lab-card-heading"><div><span class="eyebrow">EXECUTABLE CHECKER · REAL WEBSITES</span><h3>Nemotron learned to inspect SVG artwork</h3></div><span class="lab-badge ${passed?'pass':'review'}">${passed?'Checker transfer proven':'Transfer not proven'}</span></div><div class="brain-stats"><div class="brain-stat"><strong>+1</strong><span>Agent-written checking ability</span></div><div class="brain-stat"><strong>${sites} / ${result.results.length}</strong><span>Real sites with reproduced transfer</span></div><div class="brain-stat"><strong>${result.modelCallsDuringTransfer}</strong><span>Model calls during transfer</span></div></div><div class="real-sites-list">${result.results.map(site=>`<div><a href="${esc(safeLink(site.url))}" target="_blank" rel="noopener noreferrer">${esc(new URL(site.url).hostname)}</a><span class="lab-badge ${site.transferred?'pass':'review'}">${site.error?'Unavailable':site.transferred?`${site.reproducedMeasurements} measurements reproduced`:'No verified transfer'}</span><small>${site.first?`Unmeasured links: ${site.first.beforeUnmeasured} → ${site.first.afterUnmeasured}`:'No result'}</small></div>`).join('')}</div><p class="lab-scope">Learned from ${esc(new URL(result.trainingUrl).hostname)} · ${result.development.cases} development measurement cases passed · ${result.unchanged?'Frozen code unchanged':'Integrity check failed'} · Candidate only</p><p class="real-learning-note">${passed?'A new inspection capability transferred.':'This experiment did not prove checker transfer.'} This does not establish trademark or privacy-compliance accuracy.</p><details class="lab-details"><summary>Inspect the generated checker and experiment</summary><p>${esc(result.learnerModel)} · ${esc(result.probe.codeHash)} · frozen ${esc(result.frozenAt)}</p><pre>${esc(result.probe.code)}</pre><pre>${esc(JSON.stringify(result,null,2))}</pre></details></article>`;
}

function openLearningEvidence(target){const section=$(target)?.closest('details.learning-disclosure');if(section)section.open=true;}
function renderLearningProof(){
 const {brain:b,benchmark:e,transfer:t,checker:c}=learningState;
 const decision=b?.decisions?.slice().reverse().find(d=>d.accepted && b.versions?.find(v=>v.version===d.candidate)?.addedProbes?.length);
 const version=b?.versions?.find(v=>v.version===decision?.candidate);
 const probes=version?.addedProbes??[];
 const names=probes.map(p=>p.id==='background-artwork'?'CSS background artwork':p.name||p.id);
 const ids=probes.map(p=>p.id);
 const retained=!!decision&&ids.length>0;
 const before=e?.before?.metrics,after=e?.after?.metrics;
 const measured=before&&after&&[before.tp,before.fn,after.tp,after.fn].every(hasMetric);
 const matchedTransfer=retained&&t?.transferred===true&&t.unchanged===true&&Array.isArray(t.learnedIds)&&ids.some(id=>t.learnedIds.includes(id))&&Array.isArray(t.results)&&t.results.length>0&&t.results.every(r=>r.modelCalls===0);
 const gain=measured?`${before.tp}/${before.tp+before.fn} → ${after.tp}/${after.tp+after.fn}`:'Not measured';
 const title=retained?`Learned to inspect ${names.join(' + ')}`:'No learned checker retained yet';
 const badge=retained?`${decision.parent} → ${decision.candidate} retained`:'Awaiting validated change';
 const scope=matchedTransfer?'Transfer passed on fresh synthetic apps. Real-site checker transfer is not established by this result.':'Unseen-app checker transfer has not been verified for this retained change.';
 const reportVersion=currentReport?.brainVersion;
 const strip=`<div class="learning-proof-head"><div><span class="eyebrow">VERSION N+1 · ${retained?'VERIFIED LEARNING':'TEAM LEARNING'}</span><h2>${esc(title)}</h2></div><span class="lab-badge ${retained?'pass':''}">${esc(badge)}</span></div><div class="learning-proof-facts"><span><b>Changed</b>${retained?'Reusable inspection code':'No accepted tool change'}</span><span><b>Tested</b>${measured?esc(gain)+' issues found':'No saved comparison'} <small>${measured?'synthetic benchmark':''}</small></span><span><b>Transferred</b>${matchedTransfer?'Passed · fresh test apps':'Not proven'}</span><button type="button" class="quiet proof-details">See learning evidence ↗</button></div><p class="learning-proof-scope">${reportVersion?'This audit uses '+esc(reportVersion)+'. ':''}${esc(scope)}${measured?' Benchmark '+esc(e.before.version)+' → '+esc(e.after.version)+'.':''}</p>`;
 for(const id of ['learning-proof','evidence-learning-proof']){const root=$(id);if(root){root.innerHTML=strip;root.querySelector('.proof-details').onclick=()=>{showView('learning');};}}
 const story=$('learning-story');if(!story)return;
 story.innerHTML=`<div class="learning-story-heading"><span class="eyebrow">THE RESULT, EXPLAINED</span><span class="lab-badge">${esc(b?.active??'Loading')} active</span></div><div class="learning-story-grid"><article><span class="story-step">01 / WHAT CHANGED</span><h3>${retained?esc(names.join(' + ')):'No new tool yet'}</h3><p>${retained?(ids.includes('background-artwork')?'The learner added a checker for CSS background badges that the original tool could not measure.':'The learner added reusable inspection code to the shared brain.'):'Run a learning cycle to propose a reusable checking tool. A proposal alone does not count as a learned capability.'}</p><small>${retained?esc(decision.parent)+' → '+esc(decision.candidate)+' · stored in shared memory':'Existing tools remain available'}</small></article><article><span class="story-step">02 / HOW WE TESTED</span><h3>${measured?esc(gain)+' issues found':'No comparison saved'}</h3><p>${measured?'Compared both versions on reserved synthetic apps. This score includes all changes between those versions.':'Run Benchmark comparison to compare two versions on reserved synthetic apps.'}</p><small>${measured?esc(e.before.version)+' → '+esc(e.after.version)+' · '+esc(after.fp??'Unmeasured')+' false findings':'No accuracy score claimed'}</small></article><article><span class="story-step">03 / WHAT WE KEPT</span><h3>${retained?'Checker retained':'Nothing promoted yet'}</h3><p>${matchedTransfer?'The frozen checker passed on fresh synthetic apps, including a clean control. Zero model calls during transfer.':retained?'The tool passed its promotion gate. Transfer to newly generated apps still needs evidence.':'A change must pass validation before it enters the active brain.'}</p><small>${retained?'Retained in '+esc(decision.candidate):'The existing brain is unchanged'}</small></article></div><div class="learning-story-limits"><span class="tiny-dot"></span><p>${c?.status==='failed'?'Latest real-site attempt: SVG checker failed development tests and was not kept. ':''}${b?.versions?.some(v=>v.version==='v2'&&v.addedVendors?.some(v=>v.id==='cloudflare-web-analytics'))?'Cloudflare knowledge was a maintainer-reviewed addition. ':''}These results demonstrate the learning mechanism on small synthetic test sets, not real-world compliance accuracy.</p></div>`;
}
