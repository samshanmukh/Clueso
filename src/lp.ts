import { config } from './settings.ts';
import { startFixtureServer } from './fixtures/server.ts';
import { closeBrowser } from './scan/scanner.ts';
import { runAudit } from './agents/controller.ts';
import { learnCycle } from './learn/learner.ts';
import { runTransfer, printTransfer } from './eval/transfer.ts';
import { loadBrain, loadRegistry, resetBrain } from './brain/store.ts';
import { loadLabels } from './eval/score.ts';
import { chat, llmAvailable, usage } from './llm.ts';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (f: string) => rest.includes(f);
const opt = (f: string) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] : undefined; };
const positional = rest.filter((a, i) => !a.startsWith('--') && !rest[i - 1]?.startsWith('--'));

async function withFixtures<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const s = await startFixtureServer();
  try { return await fn(s.base); } finally { s.close(); await closeBrowser(); }
}

async function main() {
  switch (cmd) {
    case 'audit': {
      const target = positional[0];
      if (!target) throw new Error('usage: npm run audit -- <url | fixture:app-a> [--version v0] [--no-llm]');
      await withFixtures(async (base) => {
        const url = target.startsWith('fixture:') ? `${base}/${target.slice(8)}/` : target;
        const r = await runAudit(url, { version: opt('--version'), useLlm: !flag('--no-llm') });
        console.log(`\n${r.verdict}\n`);
        for (const f of r.findings) console.log(`■ ${f.title}\n  ${f.verification?.notes[0] ?? ''}\n\n${f.repairPrompt}\n`);
        for (const u of r.unresolved) console.log(`? ${u.summary}`);
        console.log(`\nReport: data/runs/${r.job}/report.json`);
      });
      break;
    }
    case 'learn':
      await withFixtures(async (base) => {
        const r = await learnCycle(base, loadLabels().splits.dev);
        for (const d of r.decisions) console.log(`${d.accepted ? '✔' : '✘'} ${d.summary}\n   ${d.reasons.join('\n   ')}`);
        console.log(`Active brain: ${loadRegistry().active}`);
      });
      break;
    case 'eval':
      await withFixtures(async (base) => printTransfer(await runTransfer(base, opt('--from') ?? 'v0', opt('--to'), !flag('--no-llm'))));
      break;
    case 'demo':
      // Full story: reset → learn on dev apps → frozen before/after on held-out apps
      resetBrain();
      await withFixtures(async (base) => {
        const r = await learnCycle(base, loadLabels().splits.dev);
        for (const d of r.decisions) console.log(`${d.accepted ? '✔' : '✘'} ${d.summary}`);
        printTransfer(await runTransfer(base, 'v0', undefined, !flag('--no-llm')));
      });
      break;
    case 'brain': {
      if (positional[0] === 'reset') { resetBrain(); console.log('Brain reset to v0'); break; }
      const reg = loadRegistry(); const b = loadBrain();
      console.log(`Active ${reg.active}; versions ${reg.versions.join(' → ')}`);
      console.log(`Vendors: ${b.vendors.map((v) => v.name).join(', ')}\nProbes: ${b.probes.map((p) => p.id).join(', ')}`);
      for (const d of reg.decisions) console.log(`${d.accepted ? '✔' : '✘'} ${d.summary}`);
      break;
    }
    case 'check-model': {
      if (!config.crusoeKey) throw new Error('Set CRUSOE_INTELLIGENCE_API_KEY in .env first');
      const res = await fetch(`${config.crusoeBase}/models`, { headers: { authorization: `Bearer ${config.crusoeKey}` } });
      const j: any = await res.json();
      const ids: string[] = (j.data ?? []).map((m: any) => m.id);
      console.log(`Models (${res.status}):\n  ${ids.join('\n  ')}`);
      console.log(ids.includes(config.model) ? `✔ CRUSOE_MODEL ${config.model} is available` : `✘ CRUSOE_MODEL ${config.model} NOT in list — set CRUSOE_MODEL in .env`);
      if (!llmAvailable()) break;
      const r = await chat({ role: 'check', messages: [{ role: 'user', content: 'Call the ping tool with {"n": 7}.' }],
        tools: [{ type: 'function', function: { name: 'ping', description: 'test', parameters: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } } }] });
      console.log(r.toolCalls.length ? `✔ Tool calling works: ${JSON.stringify(r.toolCalls[0].function)}` : `~ No native tool call; text was: ${r.content.slice(0, 200)} (the agent loop falls back to JSON-in-text)`);
      console.log(`Latency ${r.ms} ms, tokens ${usage.prompt}+${usage.completion}`);
      break;
    }
    default:
      console.log('Commands: audit <url|fixture:app-a> | learn | eval | demo | brain [reset] | check-model');
  }
}

main().catch(async (e) => { console.error(e?.stack ?? e); await closeBrowser(); process.exit(1); });
