// Ported unmodified in behavior from PR #25's tests/scenicgraph/lodging-decision.test.ts
// (Scenic-Stay/staygraph, branch agent/scenicgraph-lodging-decision-api) -- only import
// paths changed to point at this service's copied kernel files. Confirms DI-001-A's
// kernel copy is behaviorally identical to PR #25's source.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { familySampleRequest, remoteWorkSampleRequest } from '../src/kernel/fixtures';
import type { LodgingDecisionRequest } from '../src/kernel/contracts';
import { decideLodging } from '../src/kernel/lodging-decision';
import { DecisionRequestError, parseDecisionRequest } from '../src/kernel/validation';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const exampleRequest = JSON.parse(readFileSync(path.join(__dirname, 'examples/lodging-decision-request.json'), 'utf8'));
const exampleResponse = JSON.parse(readFileSync(path.join(__dirname, 'examples/lodging-decision-response.json'), 'utf8'));

test('remote-work fixture returns the same ranked decision every time', () => {
  const first = decideLodging(remoteWorkSampleRequest);
  assert.deepEqual(first, decideLodging(remoteWorkSampleRequest));
  assert.equal(first.recommended_listing_id, 'harbor-work-studio');
  assert.deepEqual(first.ranked_candidates.map((candidate) => candidate.listing_id), ['harbor-work-studio', 'old-town-design-loft', 'garden-value-flat']);
  assert.match(first.decision_id, /^sg_[a-f0-9]{16}$/);
  assert.ok(first.agent_explanation.includes('Harbor Work Studio'));
});

test('ranking is independent of candidate input order', () => {
  const result = decideLodging({ ...remoteWorkSampleRequest, candidate_listings: [...remoteWorkSampleRequest.candidate_listings].reverse() });
  assert.equal(result.recommended_listing_id, 'harbor-work-studio');
  assert.deepEqual(result.ranked_candidates.map((candidate) => candidate.listing_id), ['harbor-work-studio', 'old-town-design-loft', 'garden-value-flat']);
});

test('hard constraints keep an otherwise strong listing out of the recommendation', () => {
  const result = decideLodging(familySampleRequest);
  const designLoft = result.ranked_candidates.find((candidate) => candidate.listing_id === 'old-town-design-loft');
  assert.equal(result.recommended_listing_id, 'garden-value-flat');
  assert.equal(designLoft?.eligible, false);
  assert.ok(designLoft?.hard_constraint_failures.includes('accessibility:step-free entry'));
});

test('response exposes every agent-facing decision field', () => {
  const result = decideLodging(remoteWorkSampleRequest);
  assert.deepEqual(Object.keys(result), [
    'decision_id', 'recommended_listing_id', 'ranked_candidates', 'decision_reason', 'evidence', 'tradeoffs',
    'risk_flags', 'constraint_matches', 'confidence', 'missing_information', 'agent_explanation', 'booking_next_action'
  ]);
  assert.ok(result.evidence.length > 0);
  assert.ok(result.constraint_matches.length > 0);
  assert.ok(result.confidence >= 0 && result.confidence <= 1);
});

test('request parser rejects duplicate listing IDs with actionable details', () => {
  const first = remoteWorkSampleRequest.candidate_listings[0];
  assert.throws(() => parseDecisionRequest({ ...remoteWorkSampleRequest, candidate_listings: [first, first] }), (error: unknown) => {
    assert.ok(error instanceof DecisionRequestError);
    assert.ok(error.details.includes('candidate_listings listing_id values must be unique.'));
    return true;
  });
});

test('committed example response stays in sync with the scorer', () => {
  const parsed = parseDecisionRequest(exampleRequest as unknown as LodgingDecisionRequest);
  assert.deepEqual(decideLodging(parsed), exampleResponse);
});
