import assert from 'node:assert/strict';
import test from 'node:test';

import worker, { classifyRequest, fingerprintToolCall, recordRequest, dayKeyFor, type Env } from '../src/worker';

// Minimal in-memory stand-in for Workers KV, just enough for recordRequest's
// get/put calls. Not a full KVNamespace implementation.
function makeMockKv(): { env: Env; store: Map<string, string> } {
  const store = new Map<string, string>();
  const kv = {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
  };
  return { env: { DI_001_A_ABUSE_CEILING: kv as any }, store };
}

const sampleToolCallBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: {
    name: 'lodging_decision',
    arguments: {
      traveler: { traveler_type: 'remote worker' },
      trip: { purpose: 'remote-work', group_size: 2, nights: 3, budget: { currency: 'USD', max_total: 900 } },
      candidate_listings: [
        { listing_id: 'b', name: 'B', currency: 'USD', nightly_rate: 100, max_guests: 2, amenities: ['wifi'] },
        { listing_id: 'a', name: 'A', currency: 'USD', nightly_rate: 120, max_guests: 2, amenities: ['wifi'] },
      ],
    },
  },
};

test('classifyRequest identifies a real lodging_decision tool call', () => {
  assert.equal(classifyRequest(sampleToolCallBody), 'tools_call_lodging_decision');
});

test('classifyRequest identifies discovery-shaped methods', () => {
  for (const method of ['initialize', 'tools/list', 'resources/list', 'prompts/list']) {
    assert.equal(classifyRequest({ jsonrpc: '2.0', id: 1, method }), 'discovery');
  }
});

test('classifyRequest falls back to other for unrecognized shapes', () => {
  assert.equal(classifyRequest({ method: 'tools/call', params: { name: 'not_our_tool' } }), 'other');
  assert.equal(classifyRequest(null), 'other');
  assert.equal(classifyRequest('not an object'), 'other');
});

test('fingerprintToolCall is deterministic and order-independent on candidate listings', async () => {
  const first = await fingerprintToolCall(sampleToolCallBody);
  const reordered = JSON.parse(JSON.stringify(sampleToolCallBody));
  reordered.params.arguments.candidate_listings.reverse();
  const second = await fingerprintToolCall(reordered);
  assert.ok(first);
  assert.equal(first, second);
});

test('fingerprintToolCall changes when trip shape actually differs', async () => {
  const first = await fingerprintToolCall(sampleToolCallBody);
  const changed = JSON.parse(JSON.stringify(sampleToolCallBody));
  changed.params.arguments.trip.nights = 10;
  const second = await fingerprintToolCall(changed);
  assert.notEqual(first, second);
});

test('fingerprintToolCall does not vary with free-text fields (preferences, listing names)', async () => {
  const first = await fingerprintToolCall(sampleToolCallBody);
  const changed = JSON.parse(JSON.stringify(sampleToolCallBody));
  changed.params.arguments.traveler.preferences = ['a wildly different free-text preference string'];
  changed.params.arguments.candidate_listings[0].name = 'A Completely Different Name';
  const second = await fingerprintToolCall(changed);
  assert.equal(first, second);
});

test('fingerprintToolCall returns null for malformed arguments', async () => {
  assert.equal(await fingerprintToolCall({ method: 'tools/call', params: {} }), null);
  assert.equal(await fingerprintToolCall(null), null);
});

test('recordRequest: repeated identical tool-call shape produces at most one shape entry, sampled writes aside', async () => {
  const { env, store } = makeMockKv();
  const fingerprint = await fingerprintToolCall(sampleToolCallBody);
  const day = dayKeyFor(new Date());

  // Force every call to land in the sampled 5% by seeding a run until we observe
  // at least one write, since sampling is randomized -- run enough iterations that
  // a real bug (e.g. always writing, or never deduping) would be caught reliably.
  for (let i = 0; i < 400; i++) {
    await recordRequest(env, 'tools_call_lodging_decision', fingerprint);
  }

  const shapes = store.get(`shapes:${day}`);
  assert.ok(shapes, 'expected at least one sampled write to have occurred across 400 attempts');
  assert.equal(shapes!.split(',').length, 1, 'identical fingerprint repeated many times should still be one distinct shape');
});

test('recordRequest: distinct tool-call shapes each get tracked, up to the cap', async () => {
  const { env, store } = makeMockKv();
  const day = dayKeyFor(new Date());

  for (let i = 0; i < 400; i++) {
    const body = JSON.parse(JSON.stringify(sampleToolCallBody));
    body.params.arguments.trip.nights = (i % 60) + 1; // up to 60 distinct shapes
    const fingerprint = await fingerprintToolCall(body);
    await recordRequest(env, 'tools_call_lodging_decision', fingerprint);
  }

  const shapes = store.get(`shapes:${day}`);
  assert.ok(shapes);
  const distinctCount = shapes!.split(',').length;
  assert.ok(distinctCount > 1, 'varied shapes should produce more than one tracked entry');
  assert.ok(distinctCount <= 50, 'tracked shapes must respect the per-day cap');
});

test('recordRequest: discovery-class traffic is tracked separately from tool-call traffic', async () => {
  const { env, store } = makeMockKv();
  const day = dayKeyFor(new Date());

  for (let i = 0; i < 400; i++) {
    await recordRequest(env, 'discovery', null);
  }

  assert.ok(store.has(`class:discovery:${day}`), 'expected sampled discovery-class writes');
  assert.ok(!store.has(`class:tools_call_lodging_decision:${day}`), 'discovery traffic must not inflate the tool-call class counter');
});

test('fetch exposes only DI-001-A worker endpoints outside MCP', async () => {
  const { env } = makeMockKv();

  const options = await worker.fetch(new Request('https://example.com/mcp', { method: 'OPTIONS' }), env);
  assert.equal(options.status, 204);

  const health = await worker.fetch(new Request('https://example.com/health'), env);
  assert.equal(health.status, 200);
  assert.equal(await health.text(), 'ok');

  const glama = await worker.fetch(new Request('https://example.com/.well-known/glama.json'), env);
  assert.equal(glama.status, 200);
  assert.equal((await glama.json() as any).maintainers[0].email, 'scenicstay@abetterbnb.com');

  const stats = await worker.fetch(new Request('https://example.com/stats'), env);
  assert.equal(stats.status, 200);
  assert.equal(typeof (await stats.json() as any).today_estimated_requests, 'number');

  for (const path of ['/openapi.json', '/decide', '/api/decide', '/benchmark', '/api/benchmark']) {
    const response = await worker.fetch(new Request(`https://example.com${path}`, {
      method: path.includes('decide') ? 'POST' : 'GET',
      body: path.includes('decide') ? '{}' : undefined,
    }), env);
    assert.equal(response.status, 404);
    assert.equal(await response.text(), 'Not found. Supported endpoints: /mcp (MCP), /stats, /health.');
  }
});
