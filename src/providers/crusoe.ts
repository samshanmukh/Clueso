import type { Config } from '../config.ts';
import { requireKey } from '../config.ts';
import { JsonHttp } from '../http.ts';
import type { Fetch, RequestMetric } from '../http.ts';

export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };
export type Message = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_content?: string | null;
  reasoning?: string | null;
};
export type ToolDefinition = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };
export type InputMessage = Omit<Message, 'content'> & { content: string | ContentPart[] | null };
export type Model = { id: string; features?: unknown; supported_parameters?: string[]; [key: string]: unknown };
export type Completion = { message: Message; finishReason: string; usage?: Record<string, unknown>; model?: string };

function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

export class CrusoeClient {
  readonly http: JsonHttp;
  readonly model: string;
  constructor(config: Config, options: { fetch?: Fetch; onMetric?: (metric: RequestMetric) => void } = {}) {
    this.model = config.crusoeModel;
    this.http = new JsonHttp({ provider: 'Crusoe', baseUrl: config.crusoeBaseUrl, headers: { Authorization: `Bearer ${requireKey(config.crusoeKey, 'CRUSOE_INTELLIGENCE_API_KEY (or CRUSOE_API_KEY)')}` }, timeoutMs: config.timeoutMs, maxRetries: config.maxRetries, ...options });
  }

  async models(): Promise<Model[]> {
    const result = await this.http.request('/models');
    if (!object(result) || !Array.isArray(result.data) || !result.data.every((x) => object(x) && typeof x.id === 'string')) throw new Error('Crusoe returned an unexpected models response.');
    return result.data as Model[];
  }

  async verifyModel(requiredParameters: string[] = []): Promise<Model> {
    const model = (await this.models()).find((m) => m.id === this.model);
    if (!model) throw new Error('Configured CRUSOE_MODEL was not returned by /models. Run npm run models and use an exact model ID.');
    for (const parameter of requiredParameters) {
      if (!model.supported_parameters?.includes(parameter)) throw new Error(`Model metadata does not confirm support for ${parameter}. Run npm run models and select a model declaring the required capability.`);
    }
    return model;
  }

  async chat(messages: InputMessage[], options: { tools?: ToolDefinition[]; maxTokens?: number; temperature?: number; reasoningEffort?: 'low' | 'medium' | 'high'; enableThinking?: boolean } = {}): Promise<Completion> {
    const result = await this.http.request('/chat/completions', {
      model: this.model,
      messages,
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.2,
      stream: false,
      ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
      ...(options.enableThinking !== undefined ? { chat_template_kwargs: { enable_thinking: options.enableThinking } } : {}),
      ...(options.tools?.length ? { tools: options.tools } : {}),
    });
    if (!object(result) || !Array.isArray(result.choices) || !object(result.choices[0])) throw new Error('Crusoe returned no completion choices.');
    const choice = result.choices[0];
    const raw = choice.message;
    if (!object(raw) || raw.role !== 'assistant' || (raw.content != null && typeof raw.content !== 'string')) throw new Error('Crusoe returned an invalid assistant message.');
    if (choice.finish_reason === 'length') throw new Error('Nemotron exhausted its output budget; increase maxTokens. The partial answer was not accepted.');
    if (raw.tool_calls !== undefined && (!Array.isArray(raw.tool_calls) || !raw.tool_calls.every((c: unknown) => object(c) && typeof c.id === 'string' && c.type === 'function' && object(c.function) && typeof c.function.name === 'string' && typeof c.function.arguments === 'string'))) throw new Error('Crusoe returned malformed tool calls.');
    if (!(typeof raw.content === 'string' && raw.content.trim()) && !(Array.isArray(raw.tool_calls) && raw.tool_calls.length)) throw new Error('Nemotron returned no final content or tool calls. Reasoning alone was not accepted as a result.');
    return { message: raw as Message, finishReason: String(choice.finish_reason ?? 'unknown'), usage: object(result.usage) ? result.usage : undefined, model: typeof result.model === 'string' ? result.model : undefined };
  }
}
