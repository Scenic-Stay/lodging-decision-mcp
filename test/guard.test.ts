import assert from 'node:assert/strict';
import test from 'node:test';

import { remoteWorkSampleRequest } from '../src/kernel/fixtures';
import { guardRequest, GuardRejectionError } from '../src/guard';

test('guard passes a clean non-sensitive request through', () => {
  assert.doesNotThrow(() => guardRequest(remoteWorkSampleRequest));
});

test('guard rejects a denylisted term in traveler.preferences', () => {
  const request = { ...remoteWorkSampleRequest, traveler: { ...remoteWorkSampleRequest.traveler, preferences: ['quiet', 'christian hosts only'] } };
  assert.throws(() => guardRequest(request), (error: unknown) => {
    assert.ok(error instanceof GuardRejectionError);
    assert.ok(error.flaggedFields.some((f) => f.includes('traveler.preferences')));
    return true;
  });
});

test('guard rejects a denylisted term in a candidate review_signals field', () => {
  const request = {
    ...remoteWorkSampleRequest,
    candidate_listings: [
      { ...remoteWorkSampleRequest.candidate_listings[0], review_signals: ['great for families', 'no lgbt guests'] },
    ],
  };
  assert.throws(() => guardRequest(request), (error: unknown) => {
    assert.ok(error instanceof GuardRejectionError);
    assert.ok(error.flaggedFields.some((f) => f.includes('review_signals')));
    return true;
  });
});

test('guard does not flag legitimate accessibility_needs content', () => {
  const request = { ...remoteWorkSampleRequest, traveler: { ...remoteWorkSampleRequest.traveler, accessibility_needs: ['wheelchair accessible', 'step-free entry'] } };
  assert.doesNotThrow(() => guardRequest(request));
});
