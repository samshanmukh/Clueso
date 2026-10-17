import { existsSync } from 'node:fs';
import { loadConfig, loadLocalEnv } from './config.ts';
import { CrusoeClient } from './providers/crusoe.ts';
import { YouClient } from './providers/you.ts';
import { inspectPage } from './tools/browser.ts';
import { fetchAsset } from './tools/assets.ts';
import { runToolAgent } from './agent.ts';
import { toolDefinitions } from './tools/registry.ts';
import type { RequestMetric } from './http.ts';

loadLocalEnv();
const config = loadConfig();
const [command = 'doctor', ...args] = process.argv.slice(2);
const metrics: RequestMetric[] = [];
const onMetric = (metric: RequestMetric) => metrics.push(metric);
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

async function smokeCrusoe() {
  const client = new CrusoeClient(config, { onMetric });
  const model = await client.verifyModel();
  const reply = await client.chat([{ role: 'user', content: 'Reply with one short sentence confirming this inference connection works. Do not call any tools.' }]);
  return { provider: 'Crusoe', model: model.id, supportedParameters: model.supported_parameters ?? null, features: model.features ?? null, answer: reply.message.content, usage: reply.usage };
}
async function smokeYou() {
  const client = new YouClient(config, { onMetric });
  const search = await client.search('Instagram official brand assets guidelines', { count: 2, includeDomains: ['meta.com', 'www.meta.com'] });
  if (!search.results.length) throw new Error('You.com returned no results for the smoke query.');
  const pages = await client.contents([search.results[0]!.url]);
  if (!pages.some((page) => page.markdown?.trim())) throw new Error('You.com search worked, but Contents returned no readable page.');
  return { provider: 'You.com', searchResults: search.results.map((row) => ({ title: row.title, url: row.url })), pages: pages.map((page) => ({ url: page.url, readable: Boolean(page.markdown?.trim()), characters: page.markdown?.length ?? 0 })), authorityStatus: 'unreviewed' };
}

async function main() {
  if (command === 'doctor') {
    let browser: { dependency: boolean; chromiumInstalled: boolean } = { dependency: false, chromiumInstalled: false };
    try { const { chromium } = await import('playwright'); browser = { dependency: true, chromiumInstalled: existsSync(chromium.executablePath()) }; } catch { /* Missing browser dependency is reported without credential output. */ }
    print({ node: process.version, credentials: { crusoeInferenceKey: config.crusoeKey ? 'configured' : 'missing', YOU_API_KEY: config.youKey ? 'configured' : 'missing' }, crusoe: { baseUrl: config.crusoeBaseUrl, model: config.crusoeModel, liveVerified: false }, you: { baseUrl: config.youBaseUrl, liveVerified: false }, browser, tools: toolDefinitions.map((tool) => tool.function.name), note: 'Offline configuration check only. Provider smoke commands perform live requests.' });
    return;
  }
  if (command === 'models') {
    print((await new CrusoeClient(config, { onMetric }).models()).map((model) => ({ id: model.id, features: model.features, supportedParameters: model.supported_parameters })));
  } else if (command === 'smoke') {
    if (!['crusoe', 'you', 'all'].includes(args[0] ?? 'all')) throw new Error('Usage: npm run smoke -- [all|crusoe|you]');
    const providers = args[0] === 'crusoe' ? ['crusoe'] : args[0] === 'you' ? ['you'] : ['crusoe', 'you'];
    const results = [];
    let failed = false;
    for (const provider of providers) {
      try { results.push({ status: 'passed', ...(provider === 'crusoe' ? await smokeCrusoe() : await smokeYou()) }); }
      catch (error) { failed = true; results.push({ provider, status: 'failed', message: error instanceof Error ? error.message : 'Request failed.' }); }
    }
    print({ results, metrics });
    if (failed) process.exitCode = 1;
  } else if (command === 'search') {
    print(await new YouClient(config, { onMetric }).search(args.join(' ')));
  } else if (command === 'contents') {
    print(await new YouClient(config, { onMetric }).contents(args));
  } else if (command === 'inspect') {
    if (!args[0]) throw new Error('Usage: npm run inspect -- <authorized-url> [--mobile] [--allow-localhost]');
    print(await inspectPage(args[0], { artifactRoot: config.artifactRoot, width: args.includes('--mobile') ? 390 : 1440, height: args.includes('--mobile') ? 844 : 900, allowLocalhost: args.includes('--allow-localhost') }));
  } else if (command === 'asset') {
    if (!args[0] || !args[1]) throw new Error('Usage: npm run asset -- <asset-url> <approved-host> [additional-approved-host]');
    print(await fetchAsset(args[0], { artifactRoot: config.artifactRoot, allowedHosts: args.slice(1) }));
  } else if (command === 'agent-smoke') {
    const client = new CrusoeClient(config, { onMetric });
    const result = await runToolAgent({ client, context: { config, approvedReferenceHosts: [], authorizedTargetOrigins: [] }, prompt: 'Call integration_status exactly once, then briefly summarize the returned configuration status. You must call the tool before answering.', allowedTools: ['integration_status'], maxModelCalls: 3, maxToolCalls: 2 });
    if (!result.calls.some((call) => call.name === 'integration_status' && call.status === 'ok')) throw new Error('Model answered without the required tool call; native tool calling has not been verified.');
    print({ ...result, metrics });
  } else throw new Error('Unknown command. Available: doctor, models, smoke, search, contents, inspect, asset, agent-smoke.');
}

main().catch((error: unknown) => {
  // Do not print exception stacks or provider response bodies, which may contain private inputs.
  console.error(error instanceof Error ? error.message : 'Command failed.');
  process.exitCode = 1;
});
