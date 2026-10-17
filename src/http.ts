import { setTimeout as sleep } from 'node:timers/promises';

export type Fetch = typeof globalThis.fetch;
export type RequestMetric = {
  provider: string;
  operation: string;
  attempt: number;
  status?: number;
  durationMs: number;
  rateLimits?: Record<string, string>;
};

export class ProviderError extends Error {
  readonly status: number;
  constructor(provider: string, status: number) {
    super(`${provider} request failed (HTTP ${status}). ${status === 401 || status === 403 ? 'Check the configured key and account access.' : 'Check provider availability, credits, and rate limits.'}`);
    this.name = 'ProviderError';
    this.status = status;
  }
}

export function retryDelay(header: string | null, attempt: number): number {
  const seconds = header === null ? NaN : Number(header);
  const date = header === null || Number.isFinite(seconds) ? NaN : Date.parse(header);
  const desired = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(date) ? date - Date.now() : 1000 * 2 ** attempt + Math.random() * 500;
  return Math.min(30_000, Math.max(0, desired));
}

export class JsonHttp {
  readonly options: {
      provider: string;
      baseUrl: string;
      headers: Record<string, string>;
      timeoutMs: number;
      maxRetries: number;
      fetch?: Fetch;
      sleep?: (ms: number) => Promise<unknown>;
      onMetric?: (metric: RequestMetric) => void;
    };
  constructor(options: JsonHttp['options']) { this.options = options; }

  async request(path: string, body?: unknown, retryTransient = true): Promise<unknown> {
    const fetcher = this.options.fetch ?? globalThis.fetch;
    const attempts = retryTransient ? this.options.maxRetries + 1 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const started = Date.now();
      let response: Response;
      try {
        response = await fetcher(`${this.options.baseUrl}${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { Accept: 'application/json', ...this.options.headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: 'error',
          signal: AbortSignal.timeout(this.options.timeoutMs),
        });
      } catch {
        this.options.onMetric?.({ provider: this.options.provider, operation: path, attempt: attempt + 1, durationMs: Date.now() - started });
        // An uncertain POST may have been processed and billed. Do not replay network failures.
        throw new Error(`${this.options.provider} network request failed or timed out. No response body or credentials were logged.`);
      }
      const rateLimits: Record<string, string> = {};
      for (const name of ['x-ratelimit-limit-tokens', 'x-ratelimit-remaining-tokens', 'x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests']) {
        const value = response.headers.get(name);
        if (value !== null) rateLimits[name] = value;
      }
      this.options.onMetric?.({ provider: this.options.provider, operation: path, attempt: attempt + 1, status: response.status, durationMs: Date.now() - started, ...(Object.keys(rateLimits).length ? { rateLimits } : {}) });
      if (!response.ok) {
        const delay = retryDelay(response.headers.get('retry-after'), attempt);
        await response.body?.cancel();
        if ((response.status === 429 || response.status === 503) && attempt + 1 < attempts) {
          await (this.options.sleep ?? sleep)(delay);
          continue;
        }
        // Provider error bodies may echo submitted private content or credentials.
        throw new ProviderError(this.options.provider, response.status);
      }
      try { return await response.json(); }
      catch { throw new Error(`${this.options.provider} returned invalid JSON.`); }
    }
    throw new Error('Request attempts exhausted.');
  }
}
