import type { Config } from '../config.ts';
import { requireKey } from '../config.ts';
import { JsonHttp } from '../http.ts';
import type { Fetch, RequestMetric } from '../http.ts';
import { validatePublicUrl } from '../tools/network.ts';

export type SearchResult = { url: string; title: string; description?: string; snippets: string[] };
export type ContentPage = { url: string; title?: string; markdown: string | null; html?: string | null; metadata?: unknown };
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

export class YouClient {
  readonly http: JsonHttp;
  constructor(config: Config, options: { fetch?: Fetch; onMetric?: (metric: RequestMetric) => void } = {}) {
    this.http = new JsonHttp({ provider: 'You.com', baseUrl: config.youBaseUrl, headers: { 'X-API-Key': requireKey(config.youKey, 'YOU_API_KEY') }, timeoutMs: config.timeoutMs, maxRetries: config.maxRetries, ...options });
  }

  async search(query: string, options: { count?: number; includeDomains?: string[] } = {}): Promise<{ results: SearchResult[]; metadata?: unknown }> {
    if (!query.trim() || query.length > 2000) throw new Error('Search query must contain 1–2000 characters.');
    const count = options.count ?? 5;
    if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error('Search count must be between 1 and 10.');
    const result = await this.http.request('/search', { query, count, ...(options.includeDomains?.length ? { include_domains: options.includeDomains } : {}) });
    if (!object(result) || !object(result.results) || (result.results.web !== undefined && !Array.isArray(result.results.web))) throw new Error('You.com returned an unexpected search response.');
    const results = (result.results.web ?? []) as unknown[];
    return {
      results: results.map((row) => {
        if (!object(row) || typeof row.url !== 'string' || typeof row.title !== 'string') throw new Error('You.com returned a malformed search result.');
        return { url: row.url, title: row.title, description: typeof row.description === 'string' ? row.description : undefined, snippets: Array.isArray(row.snippets) ? row.snippets.filter((s): s is string => typeof s === 'string') : [] };
      }),
      metadata: result.metadata,
    };
  }

  async contents(urls: string[], options: { maxAge?: number; resolveDns?: boolean } = {}): Promise<ContentPage[]> {
    if (urls.length < 1 || urls.length > 10) throw new Error('Contents requires 1–10 public URLs.');
    for (const url of urls) await validatePublicUrl(url, { resolveDns: options.resolveDns });
    const maxAge = options.maxAge ?? 86400;
    if (!Number.isInteger(maxAge) || maxAge < 0) throw new Error('maxAge must be a non-negative integer.');
    const result = await this.http.request('/contents', { urls, formats: ['markdown', 'metadata'], crawl_timeout: 15, max_age: maxAge });
    if (!Array.isArray(result)) throw new Error('You.com returned an unexpected contents response.');
    return result.map((row) => {
      if (!object(row) || typeof row.url !== 'string' || (row.markdown != null && typeof row.markdown !== 'string')) throw new Error('You.com returned a malformed contents page.');
      return { url: row.url, title: typeof row.title === 'string' ? row.title : undefined, markdown: typeof row.markdown === 'string' ? row.markdown : null, metadata: row.metadata };
    });
  }
}
