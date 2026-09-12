import assert from 'node:assert/strict';
import test from 'node:test';

import worker, { buildServer, MCP_TOOL_DESCRIPTION, mcpCandidateShape } from '../src/worker';
import type { Env } from '../src/worker';

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

test('MCP Tool contract maintains strict PR #25 non-sensitive parity', () => {
  const server = buildServer();
  assert.ok(server);

  // Verify MCP Tool description highlights non-sensitive categories only
  assert.ok(MCP_TOOL_DESCRIPTION.includes('SCOPE (alpha, non-sensitive categories only)'));
  assert.ok(MCP_TOOL_DESCRIPTION.includes('does NOT accept, infer, or act on race, color, national origin'));

  // Verify candidateShape in MCP tool has non-sensitive properties and does NOT mandate v1.2 fields
  const parsedCandidate = mcpCandidateShape.safeParse({
    listing_id: 'test-1',
    name: 'Test Listing',
    currency: 'USD',
    nightly_rate: 150,
    max_guests: 2,
    amenities: ['wifi', 'kitchen'],
  });
  assert.equal(parsedCandidate.success, true);
});

test('REST Decision API (/decide) accepts and scores extended v1.2 candidate payload', async () => {
  const { env } = makeMockKv();
  const v12Payload = {
    traveler: { profile_id: 'worker-1', traveler_type: 'remote_engineer' },
    trip: {
      purpose: 'remote-work',
      group_size: 1,
      nights: 3,
      budget: { currency: 'USD', max_total: 600 }
    },
    candidate_listings: [
      {
        listing_id: 'listing-work-ready',
        name: 'Detached Garden ADU',
        currency: 'USD',
        nightly_rate: 140,
        max_guests: 2,
        amenities: ['wifi', 'kitchen'],
        workspace_details: {
          desk_type: 'standing_desk',
          chair_type: 'ergonomic_office',
          verified_wifi_mbps: 300,
        },
        acoustic_profile: {
          structure: 'private_adu',
          exposure: 'garden_courtyard',
          noise_review_sentiment: 'silent',
        },
        safety_belonging: {
          host_sentiment: 'welcoming',
          neighborhood_safety: 'well_lit_secure',
        },
      }
    ]
  };

  const request = new Request('https://example.com/decide', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(v12Payload),
  });

  const response = await worker.fetch(request, env);
  assert.equal(response.status, 200);

  const data = await response.json() as any;
  assert.equal(data.recommended_listing_id, 'listing-work-ready');
  assert.ok(data.evidence.some((e: any) => e.signal === 'workspace_ergonomics' && String(e.value).includes('standing desk')));
  assert.ok(data.evidence.some((e: any) => e.signal === 'acoustic_profile'));
});

test('GET /openapi.json delivers complete OpenAPI 3.1.0 specification for Decision API v1.2', async () => {
  const { env } = makeMockKv();
  const request = new Request('https://example.com/openapi.json', { method: 'GET' });
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 200);

  const spec = await response.json() as any;
  assert.equal(spec.openapi, '3.1.0');
  assert.equal(spec.info.title, 'StayGraph — Lodging Decision Intelligence API');
  assert.equal(spec.info.version, '1.2.0');
  assert.ok(spec.paths['/decide']);
  assert.ok(spec.paths['/decide'].post.requestBody.content['application/json'].schema.properties.candidate_listings.items.properties.workspace_details);
  assert.ok(spec.paths['/decide'].post.requestBody.content['application/json'].schema.properties.candidate_listings.items.properties.safety_belonging);
});

test('GET /benchmark delivers live hospitality benchmark', async () => {
  const { env } = makeMockKv();
  const request = new Request('https://example.com/benchmark', { method: 'GET' });
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 200);

  const report = await response.json() as any;
  assert.equal(report.report_title, 'Scenic Stay Hospitality & Agentic Decision Benchmark');
  assert.ok(report.summary.standing_desk_availability_pct !== undefined);
  assert.ok(report.scenic_stay_gold_standard);
});
