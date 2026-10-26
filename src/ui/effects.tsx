import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BotAvatar } from 'bot-avatars';
import type { BotAvatarType } from 'bot-avatars';
import { ThinkingOrb } from 'thinking-orbs';
import { BorderBeam } from 'border-beam';
import { animate, motion, AnimatePresence, MotionConfig, useReducedMotion } from 'framer-motion';
import { agentProgress } from './agent-progress.ts';
import type { LearningEvidence } from './agent-progress.ts';
import {siteRoleWork,workPercent,type SiteWork} from './site-progress.ts';

type PreviewTarget = { selector: string; label: string; x: number; y: number; width: number; height: number };
type InspectionPreview = { job: string | null; url: string; image: string | null; width: number; height: number; targets: PreviewTarget[] };
type LabState = { id: string; state: 'starting'|'running'|'completed'|'no-change'|'error'; role: string|null; phase?: string; workedRoles: string[]; phases: string[]; site?: string; sites: string[]; eventCount: number; message: string };
type UIState = { busy: boolean; role: string | null; workedRoles?: string[]; message: string };
declare global { interface Window { cluesoLab?: LabState | null; cluesoState?: UIState; cluesoLearning?: LearningEvidence | null; cluesoSiteWork?:SiteWork|null; cluesoPreview?: InspectionPreview | null } }
const initial: UIState = { busy: false, role: null, message: 'Ready for your next inspection' };
function useActivity() {
  const [state, setState] = useState<UIState>(window.cluesoState ?? initial);
  const [theme, setTheme] = useState<'dark'|'light'>(document.documentElement.dataset.theme==='dark'?'dark':'light');
  const [paused, setPaused] = useState(document.hidden);
  const [reduced, setReduced] = useState(matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const onState = (event: Event) => setState((event as CustomEvent<UIState>).detail);
    const onVisibility = () => setPaused(document.hidden);
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    const onMotion = () => setReduced(mq.matches);
    const onTheme=()=>setTheme(document.documentElement.dataset.theme==='dark'?'dark':'light');
    window.addEventListener('clueso:theme',onTheme);
    window.addEventListener('clueso:state', onState);
    document.addEventListener('visibilitychange', onVisibility);
    mq.addEventListener('change', onMotion);
    setState(window.cluesoState ?? initial);
    return () => { window.removeEventListener('clueso:theme',onTheme); window.removeEventListener('clueso:state', onState); document.removeEventListener('visibilitychange', onVisibility); mq.removeEventListener('change', onMotion); };
  }, []);
  return { ...state, theme, paused: paused || reduced, reduced };
}
const agents: { role: string; name: string; task: string; avatar: BotAvatarType }[] = [
  { role: 'scanner', name: 'Scout', task: 'Browser inspection', avatar: 'clover' },
  { role: 'vision', name: 'Iris', task: 'Visual comparison', avatar: 'flower' },
  { role: 'investigator', name: 'Atlas', task: 'Investigates findings', avatar: 'mech' },
  { role: 'verifier', name: 'Vera', task: 'Independent verification', avatar: 'star' },
  { role: 'fixer', name: 'Patch', task: 'Writes fix prompts', avatar: 'ghost' },
  { role: 'learner', name: 'Nova', task: 'Learns new checks', avatar: 'hexagon' },
];
function LandingTeam(){const state=useActivity();return <>{agents.map(agent=><article className="landing-agent" key={agent.role}><div><BotAvatar type={agent.avatar} state="default" size={48} shading="fabric" paused={state.paused} aria-hidden="true"/></div><strong>{agent.name}</strong><small>{agent.task}</small></article>)}</>;}
function AgentRoster() {
  const state = useActivity();
  const [site,setSite]=useState<SiteWork|null>(window.cluesoSiteWork??null);
  useEffect(()=>{const update=(event:Event)=>setSite((event as CustomEvent<SiteWork|null>).detail);window.addEventListener('clueso:site-work',update);setSite(window.cluesoSiteWork??null);return()=>window.removeEventListener('clueso:site-work',update);},[]);
  const work=siteRoleWork(site);
  const siteLabel=(()=>{try{return new URL(site?.url??'').hostname;}catch{return site?.url??'Choose a site';}})();
  return <><div className="team-heading"><h2>Inspection team</h2><span className={"team-site-progress"+(site?.running?" state-shimmer":"")}>{siteLabel} · Site work progress</span></div><div className="agent-roster">{agents.map((a) => {
    const row=work[a.role as keyof typeof work],percent=workPercent(row);
    const working=site?.running&&row.state==='running';
    const done=row.state==='completed';
    const activity=working?'working':done?'completed':row.state;
    const caption=percent===null?(site?'Not needed':'No site'):row.state==='failed'?'Stopped':working?'In progress':row.state==='waiting'?'Waiting':`${row.completed}/${row.total} done`;
    return <motion.div key={a.role} initial={false} animate={{ y: working && !state.paused ? -3 : 0 }} transition={{ type: 'spring', stiffness: 310, damping: 25 }} className={'agent-card site-agent-card ' + activity} data-agent={a.role} data-state={activity}>
      <div className="avatar-space"><BotAvatar type={a.avatar} state={working?'working':'default'} size={32} shading="fabric" paused={state.paused} aria-hidden="true"/></div>
      <div className="agent-card-copy"><strong>{a.name}</strong><span>{a.task}</span><small title={row.detail}>{caption}</small></div>
      <div className="agent-score-ring" role="progressbar" aria-label={`${a.name}: site work progress. ${row.detail}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent??undefined} aria-valuetext={percent===null?caption:`${percent}%. ${row.completed} of ${row.total} work items. ${row.detail}`} title={row.detail}>
        <div className="agent-ring-value" aria-hidden="true">{percent===null?'—':<>{percent}<small>%</small></>}</div>
        <div className="agent-ring-track" aria-hidden="true"><div className="agent-ring-fill" style={{transform:`scaleX(${(percent??0)/100})`}}/></div>
      </div>
    </motion.div>;
  })}</div><p className="team-progress-note">Completed work for this site. 100% means the planned work finished; findings may still need review.</p></>;
}
function InspectionBot() {
  const state = useActivity();
  const [preview, setPreview] = useState<InspectionPreview | null>(window.cluesoPreview ?? null);
  const [index, setIndex] = useState(0);
  const [frame, setFrame] = useState({ x: 0, y: 0, width: 0, height: 0, surfaceWidth: 0, surfaceHeight: 0 });
  const scanning = !state.role || state.role === 'scanner';
  useEffect(() => {
    const onPreview = (event: Event) => { setPreview((event as CustomEvent<InspectionPreview | null>).detail); setIndex(0); };
    window.addEventListener('clueso:preview', onPreview);
    setPreview(window.cluesoPreview ?? null);
    return () => window.removeEventListener('clueso:preview', onPreview);
  }, []);
  useEffect(() => {
    const surface = document.querySelector('.preview-surface');
    const stage = document.getElementById('preview-stage');
    if (!surface || !stage) return;
    const sync = () => {
      const area = surface.getBoundingClientRect(), image = stage.querySelector('img');
      const box = image?.getBoundingClientRect();
      setFrame({ x: box ? box.left - area.left : 0, y: box ? box.top - area.top : 0, width: image?.complete && image.naturalWidth && box ? box.width : 0, height: image?.complete && image.naturalWidth && box ? box.height : 0, surfaceWidth: area.width, surfaceHeight: area.height });
    };
    const resize = new ResizeObserver(sync); resize.observe(surface);
    const changes = new MutationObserver(sync); changes.observe(stage, { childList: true, subtree: true });
    stage.addEventListener('load', sync, true); stage.addEventListener('scroll', sync, { passive: true });
    window.addEventListener('resize', sync); sync();
    return () => { resize.disconnect(); changes.disconnect(); stage.removeEventListener('load', sync, true); stage.removeEventListener('scroll', sync); window.removeEventListener('resize', sync); };
  }, []);
  useEffect(() => {
    // Walk the actual captured DOM targets once; never invent locations or loop forever.
    if (!state.busy || state.paused || !scanning || !frame.width || !preview || index >= preview.targets.length - 1) return;
    const timer = setTimeout(() => setIndex(current => current + 1), 1250);
    return () => clearTimeout(timer);
  }, [state.busy, state.paused, scanning, frame.width, preview, index]);
  if (!state.busy || !preview) return null;
  const role = state.role === 'research' || state.role === 'gate' ? 'learner' : state.role;
  const agent = agents.find(agent => agent.role === role) ?? agents[0];
  const raw = scanning && preview.image && frame.width ? preview.targets[index] : null;
  const valid = raw && [raw.x, raw.y, raw.width, raw.height].every(Number.isFinite) && raw.width > 0 && raw.height > 0;
  const target = valid ? { x: frame.x + raw.x / preview.width * frame.width, y: frame.y + raw.y / preview.height * frame.height, width: raw.width / preview.width * frame.width, height: raw.height / preview.height * frame.height } : null;
  const visible = target && target.x + target.width > 0 && target.y + target.height > 0 && target.x < frame.surfaceWidth && target.y < frame.surfaceHeight;
  const clamp = (value: number, max: number) => Math.max(10, Math.min(value, Math.max(10, max)));
  const x = visible ? clamp(target.x + target.width - 30, frame.surfaceWidth - 170) : preview.image ? 16 : Math.max(16, frame.surfaceWidth / 2 - 80);
  const y = visible ? clamp(target.y - 48, frame.surfaceHeight - 65) : preview.image ? Math.max(12, frame.surfaceHeight - 75) : Math.max(20, frame.surfaceHeight / 2 - 78);
  const tasks: Record<string, string> = { scanner: 'Reviewing captured components', vision: 'Comparing visual evidence', investigator: 'Investigating findings', verifier: 'Verifying evidence', fixer: 'Preparing fix prompts', learner: 'Learning from evidence' };
  const message = !preview.image ? 'Opening the website' : tasks[agent.role];
  return <div className="inspection-bot-layer" data-inspection-role={agent.role} data-target-index={index}>
    {visible ? <motion.div className="inspection-target" initial={false} animate={{ left: target.x, top: target.y, width: target.width, height: target.height }} transition={{ duration: state.paused ? 0 : .5, ease: [.22, 1, .36, 1] }} aria-hidden="true" /> : null}
    <motion.div className="inspection-bot" initial={false} animate={{ x, y }} transition={{ duration: state.paused ? 0 : .55, ease: [.22, 1, .36, 1] }}>
      <div className="inspection-bot-avatar"><BotAvatar type={agent.avatar} state="working" size={32} shading="fabric" paused={state.paused} aria-hidden="true" /></div>
      <div className="inspection-bot-label"><strong>{agent.name} <span>inspecting</span></strong><span>{visible ? raw!.label : message}</span></div>
    </motion.div>
    <span className="sr-only" role="status">{agent.name}: {message}</span>
    {preview.image && scanning && preview.targets.length ? <div className="inspection-component-count" aria-hidden="true">Captured components <b>{Math.min(index + 1, preview.targets.length)} / {preview.targets.length}</b></div> : null}
  </div>;
}
const liveSiteLabel=(value:string)=>{try{const url=new URL(value);return /localhost|127\.0\.0\.1/.test(url.hostname)?url.pathname:url.hostname;}catch{return value;}};
function LiveExecutionSummary({run,theme,paused,resultMessage='Results are ready below'}:{run:LabState;theme:'dark'|'light';paused:boolean;resultMessage?:string}) {
  const running=run.state==='starting'||run.state==='running';
  const stopped=paused||!running;
  const current=agents.find(agent=>agent.role===run.role);
  const title=run.state==='no-change'?'No new checker needed':run.state==='completed'?'Run complete':run.state==='error'?'Run stopped':run.phase??'Connecting to the team';
  return <>
    <div className="learning-live-focus">
      <div className="learning-live-orb" aria-hidden="true">{running ? <ThinkingOrb state={run.role === 'scanner' ? 'searching' : run.role === 'fixer' ? 'composing' : run.state === 'starting' ? 'connecting' : 'solving'} theme={theme} size={64} paused={stopped} /> : <span className={'learning-run-end ' + run.state}>{['completed','no-change'].includes(run.state) ? '✓' : '!'}</span>}</div>
      <div className="learning-live-copy"><span className="live-state">{running ? 'Live' : 'Finished'}</span><AnimatePresence mode="wait" initial={false}><motion.h4 key={title} initial={{ opacity: 0, y: paused ? 0 : 5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: paused ? 0 : .18 }}>{title}</motion.h4></AnimatePresence><p>{current && running ? `${current.name} is working` : running ? 'Waiting for the next agent event' : run.state === 'no-change' ? 'Existing inspection tools are unchanged' : run.state === 'completed' ? resultMessage : 'See the error message above'}</p>{run.site && <span className="learning-live-site">{liveSiteLabel(run.site)}</span>}</div>
      <div className="learning-live-count"><strong>{run.eventCount}</strong><span>live updates</span></div>
    </div>
    <div className="learning-work-sweep" aria-hidden="true"><i /></div>
  </>;
}
function InspectionLiveStage(){
  const activity=useActivity();
  const [site,setSite]=useState<SiteWork|null>(window.cluesoSiteWork??null);
  const [lab,setLab]=useState<LabState|null>(window.cluesoLab??null);
  const [visible,setVisible]=useState(!document.getElementById('view-inspection')?.hidden);
  useEffect(()=>{
    const onSite=(event:Event)=>setSite((event as CustomEvent<SiteWork|null>).detail);
    const onLab=(event:Event)=>setLab((event as CustomEvent<LabState|null>).detail);
    const onView=()=>setVisible(!document.getElementById('view-inspection')?.hidden);
    window.addEventListener('clueso:site-work',onSite);window.addEventListener('clueso:lab-state',onLab);window.addEventListener('clueso:view',onView);
    setSite(window.cluesoSiteWork??null);setLab(window.cluesoLab??null);
    return()=>{window.removeEventListener('clueso:site-work',onSite);window.removeEventListener('clueso:lab-state',onLab);window.removeEventListener('clueso:view',onView);};
  },[]);
  const phases:Record<string,string>={scanner:'Inspecting the website',vision:'Comparing visual evidence',investigator:'Investigating findings',verifier:'Verifying evidence',fixer:'Preparing fix prompts',learner:'Learning from evidence'};
  const run:LabState|null=site?.running?{id:site.job??'inspection',state:'running',role:site.activeRole??null,phase:phases[site.activeRole??'']??'Connecting to the team',workedRoles:[],phases:[],sites:[site.url],site:site.url,eventCount:site.eventCount??0,message:site.message??''}:lab&&['starting','running'].includes(lab.state)?lab:null;
  if(!run)return null;
  return <div className="inspection-live-panel learning-live-stage" data-run-state={run.state} data-motion-paused={String(activity.paused||!visible)}><LiveExecutionSummary run={run} theme={activity.theme} paused={activity.paused||!visible}/></div>;
}
function LearningLiveStage() {
  const activity = useActivity();
  const [run, setRun] = useState<LabState | null>(window.cluesoLab ?? null);
  const [visible, setVisible] = useState(!document.getElementById('n1')?.hidden);
  useEffect(() => {
    const onRun = (event: Event) => setRun((event as CustomEvent<LabState | null>).detail);
    const onView = () => setVisible(!document.getElementById('n1')?.hidden);
    window.addEventListener('clueso:lab-state', onRun);
    window.addEventListener('clueso:view', onView);
    setRun(window.cluesoLab ?? null);
    return () => { window.removeEventListener('clueso:lab-state', onRun); window.removeEventListener('clueso:view', onView); };
  }, []);
  if (!run) return null;
  const running = run.state === 'starting' || run.state === 'running';
  const stopped = activity.paused || !running || !visible;
  return <div className="learning-live-stage" data-run-state={run.state} data-motion-paused={String(stopped)}>
    <LiveExecutionSummary run={run} theme={activity.theme} paused={activity.paused||!visible}/>
    <div className="learning-live-agents">{agents.map(agent => {
      const working = running && run.role === agent.role;
      const participated = run.workedRoles.includes(agent.role);
      return <motion.div key={agent.role} className={'learning-live-agent' + (working ? ' working' : '')} data-live-agent={agent.role} data-state={working ? 'working' : participated ? 'participated' : 'waiting'} initial={false} animate={{ y: working && !stopped ? -3 : 0 }} transition={{ type:'spring', stiffness:300, damping:24 }}>
        <div className="learning-live-avatar"><BotAvatar type={agent.avatar} state={working ? 'working' : 'default'} size={32} shading="fabric" paused={stopped || !working} aria-hidden="true" /></div><b>{agent.name}</b><span>{working ? 'Working' : participated ? 'Participated' : running ? 'Waiting' : 'Not used'}</span>
      </motion.div>;
    })}</div>
    {run.phases.length > 0 && <div className="learning-observed-phases" aria-label="Observed work phases">{run.phases.map(phase => <span className={running && phase === run.phase ? 'active' : ''} key={phase}>{phase}</span>)}</div>}
    {run.sites.length > 1 && <p className="learning-observed-sites">Observed sites: {run.sites.map(liveSiteLabel).join(' · ')}</p>}
  </div>;
}

function AgentProgress() {
  const [evidence, setEvidence] = useState<LearningEvidence | null>(window.cluesoLearning ?? null);
  const reduced = useReducedMotion();
  useEffect(() => {
    const onLearning = (event: Event) => setEvidence((event as CustomEvent<LearningEvidence | null>).detail);
    window.addEventListener('clueso:learning', onLearning);
    setEvidence(window.cluesoLearning ?? null);
    return () => window.removeEventListener('clueso:learning', onLearning);
  }, []);
  return <section className="lab-card agent-progress-panel" aria-labelledby="agent-progress-title">
    <div className="lab-card-heading"><div><h3 id="agent-progress-title">Saved role evidence</h3></div><span className="lab-badge">{evidence ? `${evidence.from} → ${evidence.to} · ${evidence.promoted ? 'Promoted' : 'Candidate'}` : 'Awaiting evidence'}</span></div>
    <p className="agent-progress-intro">{evidence ? 'Latest completed real-site run. Each bar has its own unit; these are not comparable skill scores.' : 'Your next real-site learning cycle will show what changed for each role.'}</p>
    <div className="agent-progress-grid">{agentProgress(evidence).map(row => {
      const agent = agents.find(a => a.role === row.role)!;
      const progress = row.progress;
      const percent = progress ? Math.round(progress.value / progress.total * 100) : 0;
      return <article className={'agent-learning-card' + (progress ? ' measured' : '')} data-learning-agent={agent.role} key={agent.role}>
        <div className="agent-learning-heading"><div className="learning-avatar"><BotAvatar type={agent.avatar} state="default" size={30} shading="fabric" paused aria-hidden="true" /></div><div><h4>{agent.name}</h4><span>{agent.task}</span></div><span className="agent-learning-state">{progress ? 'Measured' : 'Not evaluated'}</span></div>
        <strong className="agent-learning-result">{row.headline}</strong>
        <div className="agent-learning-scale"><span>{progress?.label ?? 'No role-specific evaluation'}</span><b>{progress ? `${progress.value} / ${progress.total}` : '—'}</b></div>
        {progress ? <div className="agent-learning-track" role="progressbar" aria-label={`${agent.name}: ${progress.label}`} aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.value} aria-valuetext={`${progress.value} of ${progress.total}. ${progress.label}.`}><motion.div className="agent-learning-fill" initial={{ scaleX: reduced ? percent / 100 : 0 }} animate={{ scaleX: percent / 100 }} transition={{ duration: reduced ? 0 : .65, ease: [.22, 1, .36, 1] }} /></div> : <div className="agent-learning-track unmeasured" aria-hidden="true" />}
        <p className="agent-learning-detail">{row.detail}</p>
      </article>;
    })}</div>
    <p className="agent-progress-footnote">Rules are shared across the team. Bars show research coverage and observed reuse, not model training or accuracy.</p>
  </section>;
}
function BusyIndicator() {
  const s = useActivity();
  return <AnimatePresence initial={false}>{s.busy && <motion.span key="busy" initial={{opacity:0,y:s.paused?0:5}} animate={{opacity:1,y:0}} exit={{opacity:0,y:s.paused?0:-3}} transition={{duration:s.paused?0:.2}} className="orb-status" role="status"><ThinkingOrb state={s.role === 'research' || s.role === 'scanner' ? 'searching' : s.role === 'fixer' ? 'composing' : 'solving'} theme={s.theme} size={20} paused={s.paused} aria-hidden="true" /><span className="state-shimmer">{s.role ? `${s.role.charAt(0).toUpperCase()}${s.role.slice(1)} working` : 'Starting inspection'}</span></motion.span>}</AnimatePresence>;
}
function InputBeam() {
  const s = useActivity();
  const [focused,setFocused]=useState(false);
  useEffect(()=>{const form=document.getElementById('audit-form');if(!form)return;const sync=()=>setFocused(form.contains(document.activeElement));form.addEventListener('focusin',sync);form.addEventListener('focusout',sync);return()=>{form.removeEventListener('focusin',sync);form.removeEventListener('focusout',sync);};},[]);
  return <BorderBeam size="md" staticColors colorVariant="forest" theme={s.theme} active={!s.paused} strength={s.busy || focused ? 1 : 0.85} brightness={s.theme === 'dark' ? 1.3 : 1} saturation={0.8} glowSize={0.8} duration={4.2} borderRadius={8} data-beam-state={s.busy ? 'working' : focused ? 'focused' : 'idle'} style={{ width: '100%', height: '100%' }}><div style={{ width: '100%', height: '100%', borderRadius: 12 }} /></BorderBeam>;
}

/** Motion's DOM API bridges the existing evidence renderer without replacing its state. */
function WorkspaceMotion() {
  useEffect(() => {
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    const running = new Set<ReturnType<typeof animate>>();
    const observers: MutationObserver[] = [];
    const cleanups: (() => void)[] = [];
    let frame = 0;
    const pending = new Set<Element>();
    const enabled = () => !mq.matches && !document.hidden;
    function enter(elements: Element[], distance = 7, stagger = .025) {
      if (!enabled()) return;
      elements.filter(el => el instanceof HTMLElement && el.getClientRects().length > 0).slice(0,40).forEach((el,i) => {
        const controls = animate(el as HTMLElement, { opacity:[.25,1], y:[distance,0] }, { duration:.3, delay:Math.min(i,8)*stagger, ease:[.22,1,.36,1] });
        running.add(controls); controls.then(() => running.delete(controls));
      });
    }
    function schedule(elements: Element[]) {
      elements.forEach(el=>pending.add(el));
      if (frame) return;
      frame=requestAnimationFrame(()=>{frame=0;enter([...pending]);pending.clear();});
    }
    document.documentElement.dataset.motion = 'framer';
    enter([...document.querySelectorAll('.topbar,.inspection-heading,.audit-bar,#agent-roster-root,.workspace-summary,.pane,.activity-panel')],10,.045);
    for (const id of ['finding-list','evidence','preview-stage','filters','trace','timeline','evalbox','freshbox','command-results','real-learning']) {
      const el=document.getElementById(id); if(!el)continue;
      const observer=new MutationObserver(changes=>{
        if(id==='preview-stage' && window.cluesoPreview)return;
        const added=changes.flatMap(c=>[...c.addedNodes]).filter((n):n is Element=>n instanceof Element);
        schedule(added);
      });
      observer.observe(el,{childList:true}); observers.push(observer);
    }
    for (const id of ['selection-bar','n1']) {
      const el=document.getElementById(id);if(!el)continue;
      const observer=new MutationObserver(()=>{if(!el.hidden)schedule([el]);});
      observer.observe(el,{attributes:true,attributeFilter:['hidden']});observers.push(observer);
    }
    for (const dialog of document.querySelectorAll('dialog')) {
      const onOpen=()=>{if(dialog.open)enter([dialog],9,0);};
      const observer=new MutationObserver(onOpen);
      observer.observe(dialog,{attributes:true,attributeFilter:['open']});observers.push(observer);
    }
    // Pointer interactions use Motion as well; ignore movements between a button's children.
    let hovered:HTMLElement|null=null;
    let hoverControl:ReturnType<typeof animate>|null=null;
    const onPointer=(event:PointerEvent)=>{
      const button=event.target instanceof Element?event.target.closest('button'):null;
      if(button===hovered)return;
      hoverControl?.complete();
      if(hovered)hovered.style.transform='';
      hovered=button;
      if(button && !button.disabled && enabled()){
        hoverControl=animate(button,{scale:[1,1.025]},{type:'spring',stiffness:380,damping:24});
      }
    };
    const onPress=(event:PointerEvent)=>{const button=event.target instanceof Element?event.target.closest('button'):null;if(!button||button.disabled||!enabled())return;hoverControl?.complete();hoverControl=animate(button,{scale:event.type==='pointerdown'?.975:(hovered===button?1.025:1)},{type:'spring',stiffness:450,damping:28});};
    const settle=()=>{if(mq.matches||document.hidden){running.forEach(c=>c.complete());running.clear();hoverControl?.complete();if(hovered)hovered.style.transform='';}};
    const onView=(event:Event)=>{const panel=document.getElementById((event as CustomEvent<{panel:string}>).detail.panel);if(panel)enter([panel],8,0);};
    window.addEventListener('clueso:view',onView);
    cleanups.push(()=>window.removeEventListener('clueso:view',onView));
    document.addEventListener('pointerover',onPointer);
    document.addEventListener('pointerdown',onPress);
    document.addEventListener('pointerup',onPress);
    document.addEventListener('pointercancel',onPress);
    document.addEventListener('visibilitychange',settle);
    mq.addEventListener('change',settle);
    cleanups.push(()=>document.removeEventListener('pointerdown',onPress),()=>document.removeEventListener('pointerup',onPress),()=>document.removeEventListener('pointercancel',onPress),()=>document.removeEventListener('pointerover',onPointer),()=>document.removeEventListener('visibilitychange',settle),()=>mq.removeEventListener('change',settle));
    return ()=>{cancelAnimationFrame(frame);observers.forEach(o=>o.disconnect());running.forEach(c=>c.complete());hoverControl?.stop();cleanups.forEach(fn=>fn());delete document.documentElement.dataset.motion;};
  },[]);
  return null;
}
for (const [id, component] of [['landing-team-root', <LandingTeam />], ['agent-roster-root', <AgentRoster />], ['preview-bot-root', <InspectionBot />], ['agent-progress-root', <AgentProgress />], ['lab-live-root', <LearningLiveStage />], ['inspection-live-root', <InspectionLiveStage />], ['busy-orb-root', <BusyIndicator />], ['input-beam-root', <InputBeam />], ['motion-root', <WorkspaceMotion />]] as const) {
  const el = document.getElementById(id); if (el) createRoot(el).render(<MotionConfig reducedMotion="user">{component}</MotionConfig>);
}
