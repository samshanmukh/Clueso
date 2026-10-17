import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { JsonHttp, ProviderError } from '../src/http.ts';
import type { Fetch } from '../src/http.ts';
import { CrusoeClient } from '../src/providers/crusoe.ts';
import { YouClient } from '../src/providers/you.ts';
import { fetchAsset } from '../src/tools/assets.ts';
import { isPublicAddress, validatePublicUrl } from '../src/tools/network.ts';
import { executeTool } from '../src/tools/registry.ts';
import { runToolAgent } from '../src/agent.ts';

const config = loadConfig({ CRUSOE_API_KEY: 'test-crusoe-secret', YOU_API_KEY: 'test-you-secret', MAX_RETRIES: '0' });
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const fakeFetch = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>): Fetch => ((input: string | URL | Request, init?: RequestInit) => Promise.resolve(handler(String(input), init))) as Fetch;

test('inference uses the Intelligence API key and never substitutes cloud credentials', () => {
  assert.equal(loadConfig({ CRUSOE_INTELLIGENCE_API_KEY: 'intelligence-test', CRUSOE_API_KEY: 'legacy-test' }).crusoeKey, 'intelligence-test');
  assert.equal(loadConfig({ CRUSOE_API_KEY: 'legacy-test' }).crusoeKey, 'legacy-test');
  assert.equal(loadConfig({ CRUSOE_CLOUD_ACCESS_KEY: 'cloud-access-test', CRUSOE_CLOUD_SECRETE_KEY: 'cloud-secret-test' }).crusoeKey, undefined);
});

test('Crusoe sends native tool definitions and returns provider usage', async () => {
  const client = new CrusoeClient(config, { fetch: fakeFetch((url, init) => {
    assert.equal(url, 'https://api.inference.crusoecloud.com/v1/chat/completions');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer test-crusoe-secret');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, config.crusoeModel);
    assert.equal(body.tools[0].function.name, 'integration_status');
    assert.equal(body.stream, false);
    return json({ model: body.model, choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'integration_status', arguments: '{}' } }] } }], usage: { total_tokens: 42 } });
  }) });
  const result = await client.chat([{ role: 'user', content: 'Check configuration.' }], { tools: [{ type: 'function', function: { name: 'integration_status', description: 'Read availability', parameters: { type: 'object' } } }] });
  assert.equal(result.message.tool_calls?.[0]?.id, 'call-1');
  assert.equal(result.usage?.total_tokens, 42);
});

test('Crusoe preserves an explicit false thinking toggle for bounded code synthesis', async () => {
  const client = new CrusoeClient(config, { fetch: fakeFetch((_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    return json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Complete code.' } }] });
  }) });
  assert.equal((await client.chat([{ role: 'user', content: 'Write a probe.' }], { enableThinking: false })).message.content, 'Complete code.');
});

test('Crusoe rejects unknown configured model before inference', async () => {
  const client = new CrusoeClient(config, { fetch: fakeFetch(() => json({ data: [{ id: 'other-model' }] })) });
  await assert.rejects(() => client.verifyModel(), /not returned by \/models/);
});

test('Crusoe requires advertised tool support before native agent execution', async () => {
  const client = new CrusoeClient(config, { fetch: fakeFetch(() => json({ data: [{ id: config.crusoeModel, supported_parameters: ['max_tokens'] }] })) });
  await assert.rejects(() => client.verifyModel(['tools']), /does not confirm support for tools/);
});

test('Crusoe rejects reasoning-only and truncated answers', async () => {
  for (const [finish_reason, expected] of [['stop', /no final content/], ['length', /exhausted its output budget/]] as const) {
    const client = new CrusoeClient(config, { fetch: fakeFetch(() => json({ choices: [{ finish_reason, message: { role: 'assistant', content: null, reasoning_content: 'thinking' } }] })) });
    await assert.rejects(() => client.chat([{ role: 'user', content: 'Check.' }]), expected);
  }
});

test('transient HTTP errors retry within budget and respect bounded Retry-After', async () => {
  let count = 0;
  const delays: number[] = [];
  const http = new JsonHttp({ provider: 'test', baseUrl: 'https://example.com', headers: {}, timeoutMs: 1000, maxRetries: 2, sleep: async (ms) => { delays.push(ms); }, fetch: fakeFetch(() => ++count === 1 ? json({}, 429, { 'retry-after': '999999' }) : json({ ok: true })) });
  assert.deepEqual(await http.request('/search', { query: 'test' }), { ok: true });
  assert.equal(count, 2);
  assert.deepEqual(delays, [30000]);
});

test('authentication errors are not retried and do not expose provider error bodies', async () => {
  let count = 0;
  const http = new JsonHttp({ provider: 'test', baseUrl: 'https://example.com', headers: {}, timeoutMs: 1000, maxRetries: 2, fetch: fakeFetch(() => { count++; return json({ error: 'test-secret PRIVATE-CUSTOMER-CONTENT' }, 401); }) });
  await assert.rejects(() => http.request('/chat', {}), (error: unknown) => error instanceof ProviderError && error.status === 401 && !error.message.includes('PRIVATE') && !error.message.includes('test-secret'));
  assert.equal(count, 1);
});

test('uncertain network POST failures are not automatically replayed or leaked', async () => {
  let count = 0;
  const http = new JsonHttp({ provider: 'test', baseUrl: 'https://example.com', headers: {}, timeoutMs: 1000, maxRetries: 2, fetch: fakeFetch(() => { count++; throw new Error('PRIVATE token'); }) });
  await assert.rejects(() => http.request('/chat', {}), (error: unknown) => error instanceof Error && !error.message.includes('PRIVATE'));
  assert.equal(count, 1);
});

test('You.com uses POST search with domain restriction and X-API-Key', async () => {
  const client = new YouClient(config, { fetch: fakeFetch((url, init) => {
    assert.equal(url, 'https://ydc-index.io/v1/search');
    assert.equal(init?.method, 'POST');
    assert.equal((init?.headers as Record<string, string>)['X-API-Key'], 'test-you-secret');
    assert.deepEqual(JSON.parse(String(init?.body)), { query: 'official assets', count: 2, include_domains: ['example.com'] });
    return json({ results: { web: [{ url: 'https://example.com/brand', title: 'Brand', snippets: ['Guidelines'] }] }, metadata: { search_uuid: 'test-search' } });
  }) });
  const result = await client.search('official assets', { count: 2, includeDomains: ['example.com'] });
  assert.equal(result.results[0]?.title, 'Brand');
});

test('You.com Contents preserves failed-page nulls and sends freshness control', async () => {
  const client = new YouClient(config, { fetch: fakeFetch((url, init) => {
    assert.equal(url, 'https://ydc-index.io/v1/contents');
    assert.deepEqual(JSON.parse(String(init?.body)), { urls: ['https://example.com/brand'], formats: ['markdown', 'metadata'], crawl_timeout: 15, max_age: 0 });
    return json([{ url: 'https://example.com/brand', markdown: null }]);
  }) });
  assert.equal((await client.contents(['https://example.com/brand'], { maxAge: 0, resolveDns: false }))[0]?.markdown, null);
  await assert.rejects(() => client.contents(['http://127.0.0.1/secret']), /non-public/);
});

test('URL guard rejects private addresses, credential URLs and alternate protocols', async () => {
  for (const url of ['http://127.0.0.1', 'http://2130706433', 'http://10.0.0.1', 'http://169.254.169.254', 'http://[::1]', 'http://[::ffff:127.0.0.1]', 'http://app.local', 'file:///etc/passwd', 'https://user:password@example.com']) await assert.rejects(() => validatePublicUrl(url, { resolveDns: false }));
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('100.64.0.1'), false);
  assert.equal((await validatePublicUrl('http://localhost:3210', { allowLocalhost: true })).hostname, 'localhost');
  await assert.rejects(() => validatePublicUrl('http://10.0.0.1', { allowLocalhost: true }));
});

test('asset fetch writes a content-addressed reference and does not assert authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clueso-assets-'));
  try {
    const asset = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
    const record = await fetchAsset('https://example.com/logo.svg', { allowedHosts: ['example.com'], artifactRoot: root, resolveDns: false, fetch: fakeFetch(() => new Response(asset, { headers: { 'content-type': 'image/svg+xml' } })) });
    assert.match(record.sha256, /^[a-f0-9]{64}$/);
    assert.equal(record.authorityStatus, 'unreviewed');
    assert.equal(await readFile(record.path, 'utf8'), asset);
    const metadata = JSON.parse(await readFile(join(root, 'references', `${record.sha256}.json`), 'utf8'));
    assert.equal(metadata.sourceUrl, 'https://example.com/logo.svg');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('asset fetch rejects disallowed redirect targets, HTML, oversized data and fake image MIME', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clueso-assets-'));
  const options = { allowedHosts: ['example.com'], artifactRoot: root, resolveDns: false };
  try {
    await assert.rejects(() => fetchAsset('https://example.com/logo.svg', { ...options, fetch: fakeFetch(() => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } })) }), /non-public/);
    await assert.rejects(() => fetchAsset('https://example.com/logo.svg', { ...options, fetch: fakeFetch(() => new Response(null, { status: 302, headers: { location: 'https://unapproved.example/logo.svg' } })) }), /approved reference/);
    await assert.rejects(() => fetchAsset('https://example.com/logo.svg', { ...options, fetch: fakeFetch(() => new Response('<html>Login</html>', { headers: { 'content-type': 'text/html' } })) }), /supported image/);
    await assert.rejects(() => fetchAsset('https://example.com/logo.svg', { ...options, maxBytes: 5, fetch: fakeFetch(() => new Response('<svg></svg>', { headers: { 'content-type': 'image/svg+xml' } })) }), /size limit/);
    await assert.rejects(() => fetchAsset('https://example.com/logo.png', { ...options, fetch: fakeFetch(() => new Response('not-a-png', { headers: { 'content-type': 'image/png' } })) }), /bytes do not match/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('tool execution enforces schemas and owner scopes without exposing keys', async () => {
  const context = { config, approvedReferenceHosts: ['example.com'], authorizedTargetOrigins: [] };
  const result = JSON.stringify(await executeTool('integration_status', '{}', context));
  assert.ok(!result.includes('test-crusoe-secret'));
  assert.ok(!result.includes('test-you-secret'));
  await assert.rejects(() => executeTool('integration_status', '{"unexpected":true}', context), /unsupported/);
  await assert.rejects(() => executeTool('integration_status', '[]', context), /object/);
  await assert.rejects(() => executeTool('unregistered', '{}', context), /Unknown/);
  await assert.rejects(() => executeTool('read_reference_pages', '{"urls":["https://unapproved.example"]}', context), /approved reference/);
  await assert.rejects(() => executeTool('inspect_page', '{"url":"http://127.0.0.1"}', context), /non-public/);
});

test('agent preserves assistant-tool ordering and feeds matching tool_call_id back to Nemotron', async () => {
  let count = 0;
  const client = new CrusoeClient(config, { fetch: fakeFetch((url, init) => {
    if (url.endsWith('/models')) return json({ data: [{ id: config.crusoeModel, supported_parameters: ['tools'] }] });
    const body = JSON.parse(String(init?.body));
    if (++count === 1) return json({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'status-1', type: 'function', function: { name: 'integration_status', arguments: '{}' } }] } }] });
    assert.equal(body.messages[2].role, 'assistant');
    assert.equal(body.messages[3].role, 'tool');
    assert.equal(body.messages[3].tool_call_id, 'status-1');
    assert.equal(JSON.parse(body.messages[3].content).youConfigured, true);
    return json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Configured.' } }] });
  }) });
  const result = await runToolAgent({ client, context: { config, approvedReferenceHosts: [], authorizedTargetOrigins: [] }, prompt: 'Check.', allowedTools: ['integration_status'] });
  assert.equal(result.answer, 'Configured.');
  assert.deepEqual(result.calls, [{ name: 'integration_status', status: 'ok' }]);
});

test('agent does not run provider-invented tools or overrun model budgets', async () => {
  const make = (name: string) => new CrusoeClient(config, { fetch: fakeFetch((url) => url.endsWith('/models') ? json({ data: [{ id: config.crusoeModel, supported_parameters: ['tools'] }] }) : json({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name, arguments: '{}' } }] } }] })) });
  const context = { config, approvedReferenceHosts: [], authorizedTargetOrigins: [] };
  await assert.rejects(() => runToolAgent({ client: make('shell_exec'), context, prompt: 'Check.', allowedTools: ['integration_status'] }), /outside its allowed scope/);
  await assert.rejects(() => runToolAgent({ client: make('integration_status'), context, prompt: 'Check.', allowedTools: ['integration_status'], maxModelCalls: 1 }), /model-call budget exhausted/);
});
