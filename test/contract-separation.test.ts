import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import { buildServer, MCP_TOOL_DESCRIPTION, mcpCandidateShape, mcpLodgingDecisionInputShape } from '../src/worker';

test('MCP Tool contract maintains strict PR #25 non-sensitive parity', () => {
  const server = buildServer();
  assert.ok(server);

  // Verify MCP Tool description highlights non-sensitive categories only
  assert.ok(MCP_TOOL_DESCRIPTION.includes('SCOPE (alpha, non-sensitive categories only)'));
  assert.ok(MCP_TOOL_DESCRIPTION.includes('does NOT accept, infer, or act on race, color, national origin'));

  const parsedRequest = z.object(mcpLodgingDecisionInputShape).safeParse({
    traveler: {
      profile_id: 'traveler-1',
      traveler_type: 'remote worker',
      preferences: ['quiet'],
      accessibility_needs: ['step-free entry'],
    },
    trip: {
      purpose: 'remote-work',
      group_size: 2,
      nights: 4,
      budget: { currency: 'USD', max_total: 900, max_nightly: 220 },
      location_preferences: { preferred_areas: ['downtown'], max_distance_km: 3, near: ['conference center'] },
      required_amenities: ['wifi'],
      preferred_amenities: ['kitchen'],
      accessibility_constraints: ['step-free entry'],
      work_constraints: ['reliable wifi'],
    },
    candidate_listings: [
      {
        listing_id: 'test-1',
        name: 'Test Listing',
        currency: 'USD',
        nightly_rate: 150,
        max_guests: 2,
        area: 'downtown',
        distance_to_preference_km: 1.5,
        nearby: ['conference center'],
        amenities: ['wifi', 'kitchen'],
        accessibility_features: ['step-free entry'],
        work_features: ['desk'],
        rating: 4.8,
        review_count: 42,
        quality_signals: ['spotless'],
        review_signals: ['quiet'],
        policy: { cancellation: 'moderate', minimum_nights: 2, instant_book: true, house_rules: ['no smoking'] },
        fees: { cleaning: 60, service: 45, taxes: 30, other: 0 },
      }
    ]
  });
  assert.equal(parsedRequest.success, true);
  assert.deepEqual(Object.keys(mcpCandidateShape.shape), [
    'listing_id',
    'name',
    'currency',
    'nightly_rate',
    'max_guests',
    'area',
    'distance_to_preference_km',
    'nearby',
    'amenities',
    'accessibility_features',
    'work_features',
    'rating',
    'review_count',
    'quality_signals',
    'review_signals',
    'policy',
    'fees',
  ]);
  for (const removedField of ['workspace_details', 'acoustic_profile', 'market_context', 'access_details', 'safety_belonging']) {
    assert.equal(removedField in mcpCandidateShape.shape, false);
  }
});
