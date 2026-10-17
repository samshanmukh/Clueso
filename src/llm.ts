import { config } from './settings.ts';
import { emit } from './events.ts';
import { CrusoeClient } from './providers/crusoe.ts';
import type { ContentPart } from './providers/crusoe.ts';

export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface Msg { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | ContentPart[] | null; tool_calls?: ToolCall[]; tool_call_id?: string; name?: string }
export interface ToolDef { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
export interface ChatResult { content: string; reasoning?: string; toolCalls: ToolCall[]; usage: { prompt: number; completion: number }; ms: number }

export interface ChatOpts { role: string; messages: Msg[]; tools?: ToolDef[]; temperature?: number; maxTokens?: number; model?: string; timeoutMs?: number; reasoningEffort?: 'low' | 'medium' | 'high'; enableThinking?: boolean }

/** Scripted responder used ONLY by the offline self-test (LLM_MODE=mock). */
type MockFn = (o: ChatOpts) => ChatResult | Promise<ChatResult>;
let mockFn: MockFn | null = null;
export function setMock(fn: MockFn | null) { mockFn = fn; }

export const usage = { calls: 0, prompt: 0, completion: 0, ms: 0, errors: 0 };
export function resetUsage() { Object.assign(usage, { calls: 0, prompt: 0, completion: 0, ms: 0, errors: 0 }); }

export function llmAvailable() { return config.llmMode === 'live' ? !!config.crusoeKey : config.llmMode === 'mock' && !!mockFn; }

/** Remove <think>…</think> blocks some reasoning models put inside content. */
export function stripThinking(s: string): { text: string; reasoning: string } {
  let reasoning = '';
  const text = s.replace(/<think>([\s\S]*?)<\/think>/gi, (_, r) => { reasoning += r; return ''; })
    .replace(/^[\s\S]*?<\/think>/i, (m) => { reasoning += m; return ''; }) // unmatched closing tag
    .trim();
  return { text, reasoning };
}

export async function chat(o: ChatOpts): Promise<ChatResult> {
  if (config.llmMode === 'mock') {
    if (!mockFn) throw new Error('LLM mock not configured');
    return mockFn(o);
  }
  if (config.llmMode !== 'live' || !config.crusoeKey) throw new Error('Live inference requires CRUSOE_INTELLIGENCE_API_KEY.');
  const t0 = Date.now();
  try {
    const client = new CrusoeClient({ ...config, crusoeModel: o.model ?? config.model, timeoutMs: o.timeoutMs ?? config.timeoutMs });
    const result = await client.chat(o.messages, {
      tools: o.tools,
      temperature: o.temperature,
      reasoningEffort: o.reasoningEffort,
      enableThinking: o.enableThinking,
      maxTokens: Math.max(o.maxTokens ?? 4096, 4096),
    });
    const m = result.message;
    const { text, reasoning } = stripThinking(m.content ?? '');
    const r: ChatResult = {
      content: text,
      reasoning: (m.reasoning_content ?? m.reasoning ?? '') + reasoning,
      toolCalls: m.tool_calls ?? [],
      usage: { prompt: Number(result.usage?.prompt_tokens ?? 0), completion: Number(result.usage?.completion_tokens ?? 0) },
      ms: Date.now() - t0,
    };
    usage.calls++; usage.prompt += r.usage.prompt; usage.completion += r.usage.completion; usage.ms += r.ms;
    emit('llm', 'info', `${o.role}: ${r.usage.prompt}+${r.usage.completion} tokens, ${r.ms} ms${r.toolCalls.length ? `, ${r.toolCalls.length} tool call(s)` : ''}`);
    if (!r.content && !r.toolCalls.length) throw new Error('Model returned no usable final content.');
    return r;
  } catch (error) { usage.errors++; throw error; }
}

/** Extract the first JSON object/array from model text (handles ```json fences and chatter). */
export function extractJson<T = any>(text: string): T | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = fence ? [fence[1], text] : [text];
  for (const c of candidates) {
    for (const open of ['{', '[']) {
      const close = open === '{' ? '}' : ']';
      let start = c.indexOf(open);
      while (start !== -1) {
        let depth = 0, inStr = false, esc = false;
        for (let i = start; i < c.length; i++) {
          const ch = c[i];
          if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
          if (ch === '"') inStr = true;
          else if (ch === open) depth++;
          else if (ch === close && --depth === 0) {
            try { return JSON.parse(c.slice(start, i + 1)); } catch { break; }
          }
        }
        start = c.indexOf(open, start + 1);
      }
    }
  }
  return null;
}

/** Ask for a JSON answer; one repair retry if it doesn't parse. */
export async function chatJson<T>(o: ChatOpts, validate?: (v: any) => string | null): Promise<T> {
  const r = await chat(o);
  let v = extractJson<T>(r.content);
  let problem = v === null ? 'Your reply was not valid JSON.' : validate?.(v) ?? null;
  if (!problem) return v as T;
  const r2 = await chat({ ...o, messages: [...o.messages, { role: 'assistant', content: r.content }, { role: 'user', content: `${problem} Reply again with ONLY the corrected JSON.` }] });
  v = extractJson<T>(r2.content);
  problem = v === null ? 'not JSON' : validate?.(v) ?? null;
  if (problem) throw new Error(`Model JSON invalid after retry: ${problem}`);
  return v as T;
}

export interface Tool { def: ToolDef; run: (args: any) => Promise<unknown> | unknown }

/**
 * Generic agent tool loop with controller-owned limits: step budget, token budget,
 * repeated-call detection (loop catch) and a required `finish` tool.
 */
export async function runToolLoop(o: { role: string; system: string; user: string; tools: Tool[]; maxSteps?: number; job?: string; model?: string }): Promise<{ finished: boolean; finishArgs?: any; steps: number; stopReason: string }> {
  const messages: Msg[] = [{ role: 'system', content: o.system }, { role: 'user', content: o.user }];
  const byName = new Map(o.tools.map((t) => [t.def.function.name, t]));
  const seen = new Map<string, number>();
  const maxSteps = o.maxSteps ?? config.maxAgentSteps;
  const tokensAtStart = usage.prompt + usage.completion;
  for (let step = 1; step <= maxSteps; step++) {
    if (usage.prompt + usage.completion - tokensAtStart > config.maxTokensPerJob) return { finished: false, steps: step, stopReason: 'token budget exhausted' };
    const r = await chat({ role: o.role, messages, tools: o.tools.map((t) => t.def), model: o.model });
    let calls = r.toolCalls;
    // Fallback: some deployments return the call as JSON text instead of tool_calls.
    if (!calls.length) {
      const j = extractJson<any>(r.content);
      if (j?.tool && byName.has(j.tool)) calls = [{ id: `text_${step}`, type: 'function', function: { name: j.tool, arguments: JSON.stringify(j.arguments ?? j.args ?? {}) } }];
    }
    messages.push({ role: 'assistant', content: r.content || null, tool_calls: calls.length ? calls : undefined });
    if (!calls.length) {
      messages.push({ role: 'user', content: 'Use one of the tools. Call `finish` when you are done.' });
      continue;
    }
    for (const c of calls) {
      const name = c.function.name;
      let args: any = {};
      try { args = JSON.parse(c.function.arguments || '{}'); } catch { /* keep {} */ }
      const key = `${name}:${JSON.stringify(args)}`;
      const n = (seen.get(key) ?? 0) + 1; seen.set(key, n);
      if (name === 'finish') return { finished: true, finishArgs: args, steps: step, stopReason: 'finish' };
      let out: unknown;
      if (n >= 3) {
        emit('controller', 'warn', `${o.role} repeated ${name} 3x — loop detected, stopping`, undefined, o.job);
        return { finished: false, steps: step, stopReason: 'loop detected' };
      } else if (n === 2) {
        out = { note: 'You already made this exact call. Use the earlier result or call finish.' };
      } else {
        const tool = byName.get(name);
        try { out = tool ? await tool.run(args) : { error: `unknown tool ${name}` }; } catch (e: any) { out = { error: String(e?.message ?? e) }; }
      }
      emit(o.role as any, 'step', `${name}(${short(args)})`, undefined, o.job);
      messages.push({ role: 'tool', tool_call_id: c.id, name, content: JSON.stringify(out).slice(0, 6000) });
    }
  }
  return { finished: false, steps: maxSteps, stopReason: 'step budget exhausted' };
}

function short(a: unknown) { const s = JSON.stringify(a); return s.length > 80 ? s.slice(0, 77) + '…' : s; }
