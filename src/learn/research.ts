import { config } from '../settings.ts';
import { emit } from '../events.ts';
import { YouClient } from '../providers/you.ts';

export interface WebResult { url: string; title: string; description: string; snippets: string[] }

type SearchMock = (q: string) => WebResult[];
let mock: SearchMock | null = null;
/** Offline self-test only. */
export function setSearchMock(fn: SearchMock | null) { mock = fn; }
export function searchAvailable() { return !!config.youKey || !!mock; }

/** You.com Web Search API (POST https://ydc-index.io/v1/search, X-API-Key). */
export async function webSearch(query: string, count = 6): Promise<WebResult[]> {
  if (mock) return mock(query);
  if (!config.youKey) throw new Error('YOU_API_KEY not set');
  const t0 = Date.now();
  const result = await new YouClient(config).search(query, { count: Math.min(count, 10) });
  const web: WebResult[] = result.results.map((r) => ({ ...r, description: r.description ?? '' }));
  emit('research', 'step', `You.com: "${query}" → ${web.length} result(s) in ${Date.now() - t0} ms`);
  return web;
}
