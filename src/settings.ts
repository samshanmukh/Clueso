import path from 'node:path';
import { loadConfig, loadLocalEnv } from './config.ts';

loadLocalEnv();
const base = loadConfig();

// Shares the same .env as the integration layer (src/config.ts).
const crusoeKey = base.crusoeKey ?? '';

export const config = {
  ...base,
  crusoeKey,
  crusoeBase: base.crusoeBaseUrl,
  model: base.crusoeModel,
  visionModel: process.env.CRUSOE_VISION_MODEL || 'nvidia/NVIDIA-Nemotron-3.5-Super-VL',
  visionEnabled: process.env.LP_VISION !== 'off',
  learnerModel: process.env.CRUSOE_LEARNER_MODEL || 'nvidia/NVIDIA-Nemotron-3.5-Super-VL',
  youKey: base.youKey ?? '',
  youBase: base.youBaseUrl,
  /** live = call Crusoe; mock = scripted responses (self-test only); off = no LLM */
  llmMode: (process.env.LLM_MODE as 'live' | 'mock' | 'off') || (crusoeKey ? 'live' : 'off'),
  port: Number(process.env.PORT || 4300),
  dataDir: path.resolve(process.env.LP_DATA_DIR || 'data'),
  brainDir: path.resolve(process.env.LP_BRAIN_DIR || 'brain'),
  fixturesDir: path.resolve(process.env.LP_FIXTURES_DIR || 'fixtures'),
  maxAgentSteps: Number(process.env.LP_MAX_AGENT_STEPS || 10),
  maxTokensPerJob: Number(process.env.LP_MAX_TOKENS_PER_JOB || 120000),
};
