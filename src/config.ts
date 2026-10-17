import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export type Config = {
  crusoeKey?: string;
  crusoeBaseUrl: string;
  crusoeModel: string;
  youKey?: string;
  youBaseUrl: string;
  artifactRoot: string;
  timeoutMs: number;
  maxRetries: number;
};

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Configuration integer must be between ${min} and ${max}.`);
  }
  return parsed;
}

function endpoint(value: string, name: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be an HTTPS base URL without credentials, query, or fragment.`);
  }
  return url.href.replace(/\/$/, '');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    crusoeKey: env.CRUSOE_INTELLIGENCE_API_KEY?.trim() || env.CRUSOE_API_KEY?.trim() || undefined,
    crusoeBaseUrl: endpoint(env.CRUSOE_BASE_URL || 'https://api.inference.crusoecloud.com/v1', 'CRUSOE_BASE_URL'),
    crusoeModel: env.CRUSOE_MODEL || 'nvidia/Nemotron-3-Nano-Omni-Reasoning-30B-A3B',
    youKey: env.YOU_API_KEY?.trim() || env.YDC_API_KEY?.trim() || undefined,
    youBaseUrl: endpoint(env.YOU_BASE_URL || 'https://ydc-index.io/v1', 'YOU_BASE_URL'),
    artifactRoot: resolve(env.ARTIFACT_ROOT || './artifacts'),
    timeoutMs: integer(env.REQUEST_TIMEOUT_MS, 60_000, 1, 300_000),
    maxRetries: integer(env.MAX_RETRIES, 2, 0, 4),
  };
}

export function loadLocalEnv(): void {
  const path = resolve('.env');
  if (existsSync(path)) process.loadEnvFile(path);
}

export function requireKey(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is missing. Set it in the local .env file.`);
  return value;
}
