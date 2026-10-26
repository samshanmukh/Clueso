import assert from 'node:assert/strict';
import { test } from 'node:test';

// Bind the actual app wrappers to test credentials before settings is imported.
process.env.CRUSOE_INTELLIGENCE_API_KEY = 'app-test-key';
process.env.YOU_API_KEY = 'search-test-key';
process.env.LLM_MODE = 'live';
const { chat, runToolLoop } = await import('../src/llm.ts');
const { webSearch } = await import('../src/learn/research.ts');
const { setQuiet } = await import('../src/events.ts');
setQuiet(true);
const response = (message: unknown, status = 200) => new Response(JSON.stringify(message), { status, headers: { 'content-type': 'application/json' } });

test('app tool loop preserves native calls and returns actual tool results', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async (_input, init) => {
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer app-test-key');
      const body = JSON.parse(String(init?.body));
      if (++calls === 1) return response({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'native-read', type: 'function', function: { name: 'read', arguments: '{}' } }] } }] });
      assert.equal(body.messages[3].tool_call_id, 'native-read');
      assert.deepEqual(JSON.parse(body.messages[3].content), { evidence: 'measured' });
      return response({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'native-finish', type: 'function', function: { name: 'finish', arguments: '{"ok":true}' } }] } }] });
    };
    const result = await runToolLoop({ role: 'test', system: 'Inspect.', user: 'Go.', tools: [
      { def: { type: 'function', function: { name: 'read', description: 'Read evidence', parameters: { type: 'object' } } }, run: () => ({ evidence: 'measured' }) },
      { def: { type: 'function', function: { name: 'finish', description: 'Finish', parameters: { type: 'object' } } }, run: () => ({}) },
    ] });
    assert.equal(result.finished, true);
    assert.deepEqual(result.finishArgs, { ok: true });
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});

test('app inference authentication failures are neither retried nor leaked', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return response({ error: 'PRIVATE app-test-key' }, 401); };
    await assert.rejects(() => chat({ role: 'test', messages: [{ role: 'user', content: 'Go' }] }), (e: unknown) => e instanceof Error && !/PRIVATE|app-test-key/.test(e.message));
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('app research uses the tested You.com POST endpoint and normalizes missing descriptions', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), 'https://ydc-index.io/v1/search');
      assert.equal(init?.method, 'POST');
      assert.equal((init?.headers as Record<string, string>)['X-API-Key'], 'search-test-key');
      assert.deepEqual(JSON.parse(String(init?.body)), { query: 'official reference', count: 2 });
      return response({ results: { web: [{ url: 'https://example.com/brand', title: 'Official', snippets: ['Rule'] }] } });
    };
    assert.equal((await webSearch('official reference', 2))[0].description, '');
  } finally { globalThis.fetch = original; }
});

test('disabling model use also disables semantic verification calls', async () => {
  const { startFixtureServer } = await import('../src/fixtures/server.ts');
  const { closeBrowser } = await import('../src/scan/scanner.ts');
  const { verifyFinding } = await import('../src/agents/verifier.ts');
  const { loadBrain } = await import('../src/brain/store.ts');
  const fixture = await startFixtureServer();
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; throw new Error('Unexpected model request'); };
    const result = await verifyFinding({ type: 'undisclosed_vendor', subject: 'mixpanel', key: 'undisclosed_vendor:mixpanel', evidence: [{ kind: 'policy', data: { url: `${fixture.base}/app-a/privacy.html` } }] } as any,
      `${fixture.base}/app-a/`, loadBrain('v0'), undefined, false);
    assert.equal(result.status, 'confirmed');
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; fixture.close(); await closeBrowser(); }
});


test('verifier rejects a consent claim unsupported by the reviewed vendor rule before opening a browser', async () => {
  const { verifyFinding } = await import('../src/agents/verifier.ts');
  const { loadBrain } = await import('../src/brain/store.ts');
  const { cloudflareWebAnalytics } = await import('../src/brain/reviewed-vendors.ts');
  const brain = loadBrain('v0');
  brain.vendors.push(cloudflareWebAnalytics);
  const result = await verifyFinding({ type: 'pre_consent_tracking', subject: cloudflareWebAnalytics.id, key: 'pre_consent_tracking:cloudflare-web-analytics' } as any,
    'https://not-a-real-site.invalid/', brain);
  assert.equal(result.status, 'rejected');
  assert.match(result.verification!.notes[0], /does not establish a consent violation/);
});

test('investigator cannot propose pre-consent tracking for context-dependent analytics', async () => {
  const { investigate } = await import('../src/agents/investigator.ts');
  const { loadBrain } = await import('../src/brain/store.ts');
  const { cloudflareWebAnalytics } = await import('../src/brain/reviewed-vendors.ts');
  const brain = loadBrain('v0'); brain.vendors.push(cloudflareWebAnalytics);
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      if (++calls === 1) return response({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'bad-consent', type: 'function', function: { name: 'propose_finding', arguments: JSON.stringify({ type: 'pre_consent_tracking', vendor_id: cloudflareWebAnalytics.id, request_ids: ['r1'], rationale: 'Loaded before consent' }) } }] } }] });
      const result = JSON.parse(body.messages.at(-1).content);
      assert.match(result.error, /does not establish a consent requirement/);
      return response({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'done', type: 'function', function: { name: 'finish', arguments: '{"summary":"No blanket consent verdict."}' } }] } }] });
    };
    const result = await investigate({ url: 'https://example.com', host: 'example.com', consent: { found: false }, requests: [{ id: 'r1', host: 'static.cloudflareinsights.com', phase: 'pre' }] } as any, brain, [], []);
    assert.deepEqual(result.proposed, []);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});

test('investigator summaries cannot clear an audit that still has unresolved evidence',async()=>{
 const {reviewAwareSummary}=await import('../src/agents/investigator.ts');
 const unresolved=[{id:'unknown',type:'unknown_third_party',subject:'unknown.example',summary:'Unknown service',data:{}}] as any;
 for(const summary of ['No further action required.','No action is needed.','The site is fully compliant.']){
  const result=reviewAwareSummary(summary,unresolved);assert.match(result,/1 observations remain unresolved/);assert.match(result,/No overall clearance/);assert.notEqual(result,summary);
 }
 assert.equal(reviewAwareSummary('Research the unknown service before a conclusion.',unresolved),'Research the unknown service before a conclusion.');
 assert.equal(reviewAwareSummary('No further action required.',[]),'No further action required.');
});
