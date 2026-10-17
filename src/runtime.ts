import { resolve } from 'node:path';
import { loadConfig, loadLocalEnv } from './config.ts';

loadLocalEnv();
const base = loadConfig();
function bounded(name: string, fallback: number, min: number, max: number): number {
  const value = process.env[name] ? Number(process.env[name]) : fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} is outside its permitted range.`);
  return value;
}
const mode = process.env.LLM_MODE || 'live';
if (!['live', 'off', 'mock'].includes(mode)) throw new Error('LLM_MODE must be live, off, or mock.');
export const config = {
  ...base,
  model: base.crusoeModel,
  learnerModel: process.env.CRUSOE_LEARNER_MODEL || base.crusoeModel,
  llmMode: mode as 'live' | 'off' | 'mock',
  dataDir: base.artifactRoot,
  brainDir: resolve(process.env.BRAIN_DIR || resolve(base.artifactRoot, 'brain')),
  fixturesDir: resolve('fixtures'),
  maxAgentSteps: bounded('MAX_AGENT_STEPS', 5, 1, 12),
  maxTokensPerJob: bounded('MAX_TOKENS_PER_JOB', 30000, 1024, 100000),
};
