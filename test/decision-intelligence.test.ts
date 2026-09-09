import assert from 'node:assert/strict';
import test from 'node:test';

import type { LodgingDecisionRequest } from '../src/kernel/contracts';
import { decideLodging } from '../src/kernel/lodging-decision';

// Test 1: Remote Engineer evaluating ergonomics + acoustics + price sanity
const remoteWorkerDecisionRequest: LodgingDecisionRequest = {
  traveler: {
    profile_id: 'tech-founder-01',
    traveler_type: 'remote_engineer',
    preferences: ['quiet', 'natural light']
  },
  trip: {
    purpose: 'remote-work',
    group_size: 1,
    nights: 5,
    budget: { currency: 'USD', max_total: 900, max_nightly: 160 },
    required_amenities: ['wifi', 'kitchen'],
    work_constraints: ['dedicated workspace']
  },
  candidate_listings: [
    {
      listing_id: 'studio-central-berkeley',
      name: 'Modern Retro Private Studio (Berkeley)',
      currency: 'USD',
      nightly_rate: 125,
      max_guests: 2,
      amenities: ['wifi', 'kitchen', 'heating', 'coffee_maker'],
      work_features: ['dedicated workspace'],
      rating: 4.92,
      review_count: 86,
      policy: { cancellation: 'flexible', minimum_nights: 2, instant_book: true },
      fees: { cleaning: 45, service: 35, taxes: 40 },
      workspace_details: {
        dedicated_room: true,
        desk_type: 'standing_desk',
        chair_type: 'ergonomic_office',
        external_monitor: true,
        verified_wifi_mbps: 350
      },
      acoustic_profile: {
        structure: 'private_adu',
        exposure: 'garden_courtyard',
        quiet_hours_enforced: true,
        noise_review_sentiment: 'silent'
      },
      market_context: {
        submarket_name: 'Berkeley Central',
        submarket_baseline_adr: 125,
        median_cleaning_fee: 55
      },
      access_details: {
        checkin_type: 'keyless_smart_lock',
        superhost: true,
        guest_favorite: true
      }
    },
    {
      listing_id: 'downtown-mixed-use-loft',
      name: 'Downtown Mixed-Use Studio',
      currency: 'USD',
      nightly_rate: 155,
      max_guests: 2,
      amenities: ['wifi', 'kitchen'],
      work_features: ['dedicated workspace'],
      rating: 4.65,
      review_count: 42,
      policy: { cancellation: 'moderate', minimum_nights: 1 },
      fees: { cleaning: 95, service: 45, taxes: 50 },
      workspace_details: {
        dedicated_room: false,
        desk_type: 'dining_table',
        chair_type: 'dining_chair',
        external_monitor: false,
        verified_wifi_mbps: 35
      },
      acoustic_profile: {
        structure: 'shared_wall_apartment',
        exposure: 'busy_commercial',
        noise_review_sentiment: 'noisy'
      },
      market_context: {
        submarket_name: 'Berkeley Downtown',
        submarket_baseline_adr: 125,
        median_cleaning_fee: 55
      },
      access_details: {
        checkin_type: 'in_person_host',
        superhost: false
      }
    }
  ]
};

test('decision intelligence prioritizes ergonomic workstation, quiet acoustics, and fair ADR', () => {
  const result = decideLodging(remoteWorkerDecisionRequest);

  assert.equal(result.recommended_listing_id, 'studio-central-berkeley');
  const recommended = result.ranked_candidates[0];
  const runnerUp = result.ranked_candidates[1];

  assert.ok(recommended.score > runnerUp.score + 15, `Expected decisive score spread, got ${recommended.score} vs ${runnerUp.score}`);
  assert.ok(recommended.score_breakdown.ergonomics! >= 8);
  assert.ok(recommended.score_breakdown.acoustics! >= 8);
  assert.ok(recommended.score_breakdown.price_sanity! >= 8);
  assert.ok(recommended.score_breakdown.access_reliability! >= 8);

  const monitorTradeoff = result.tradeoffs.find((t) => t.description.includes('4K monitor'));
  assert.ok(monitorTradeoff, 'Should identify external monitor as a key tradeoff');

  const acousticTradeoff = result.tradeoffs.find((t) => t.description.includes('detached acoustic privacy'));
  assert.ok(acousticTradeoff, 'Should identify detached acoustic privacy as a key tradeoff');
});

// Test 2: Solo Traveler Late Arrival — Disqualifies host intrusion and undisclosed cameras
const soloTravelerRequest: LodgingDecisionRequest = {
  traveler: {
    profile_id: 'solo-traveler-02',
    traveler_type: 'traveling_consultant',
    preferences: ['private entrance', 'secure checkin']
  },
  trip: {
    purpose: 'business',
    group_size: 1,
    nights: 3,
    budget: { currency: 'USD', max_total: 650 },
    required_amenities: ['wifi']
  },
  candidate_listings: [
    {
      listing_id: 'secure-garden-suite-chicago',
      name: 'Secure Garden Suite (Lincoln Park, Chicago)',
      currency: 'USD',
      nightly_rate: 135,
      max_guests: 2,
      amenities: ['wifi', 'heating', 'dedicated entrance'],
      rating: 4.88,
      review_count: 58,
      fees: { cleaning: 40, service: 30, taxes: 35 },
      access_details: {
        checkin_type: 'keyless_smart_lock',
        superhost: true
      },
      safety_belonging: {
        host_sentiment: 'exceptional',
        neighborhood_safety: 'well_lit_secure',
        privacy_integrity: {
          private_entrance: true,
          undisclosed_cameras_reported: false,
          host_unannounced_entry_reported: false,
          keyless_security_verified: true
        },
        inclusive_badges: ['lgbtq_friendly', 'accessible_verified']
      }
    },
    {
      listing_id: 'shady-camera-loft-chicago',
      name: 'High-Rated Historic Loft (Chicago)',
      currency: 'USD',
      nightly_rate: 120, // Cheaper
      max_guests: 2,
      amenities: ['wifi'],
      rating: 4.82, // Appears high on paper!
      review_count: 104,
      fees: { cleaning: 50, service: 28, taxes: 30 },
      access_details: {
        checkin_type: 'keypad_lockbox'
      },
      safety_belonging: {
        host_sentiment: 'cautionary',
        neighborhood_safety: 'cautionary_at_night',
        privacy_integrity: {
          private_entrance: false,
          undisclosed_cameras_reported: true, // Fatal privacy violation!
          host_unannounced_entry_reported: true
        }
      }
    }
  ]
};

test('decision intelligence disqualifies listings with reported surveillance or host intrusion', () => {
  const result = decideLodging(soloTravelerRequest);

  // Secure Garden Suite must win
  assert.equal(result.recommended_listing_id, 'secure-garden-suite-chicago');

  const recommended = result.ranked_candidates[0];
  const disqualified = result.ranked_candidates[1];

  // Disqualified listing fails hard constraints
  assert.equal(disqualified.eligible, false);
  assert.ok(disqualified.hard_constraint_failures.includes('safety:undisclosed_cameras_reported'));
  assert.ok(disqualified.hard_constraint_failures.includes('safety:host_unannounced_entry_reported'));

  // Recommended listing has high Safety & Belonging score
  assert.ok(recommended.score_breakdown.safety_belonging! >= 9);

  // Risk flags report surveillance violation
  const cameraRisk = disqualified.hard_constraint_failures.some((f) => f.includes('undisclosed_cameras'));
  assert.ok(cameraRisk);

  // Tradeoff explicitly captures host sentiment & neighborhood safety
  const safetyTradeoff = result.tradeoffs.find((t) => t.description.includes('welcoming host sentiment'));
  assert.ok(safetyTradeoff, 'Tradeoffs must highlight superior host sentiment and boundary integrity');
});

// Test 3: Inclusivity & Host Demeanor Evaluation (Detects discriminatory scrutiny)
const diverseTravelerRequest: LodgingDecisionRequest = {
  traveler: {
    profile_id: 'family-getaway-03',
    traveler_type: 'family',
    preferences: ['welcoming environment', 'quiet']
  },
  trip: {
    purpose: 'family',
    group_size: 3,
    nights: 4,
    budget: { currency: 'USD', max_total: 800 },
    required_amenities: ['wifi', 'kitchen']
  },
  candidate_listings: [
    {
      listing_id: 'welcoming-family-cottage-austin',
      name: 'Welcoming Family Cottage (Austin)',
      currency: 'USD',
      nightly_rate: 140,
      max_guests: 4,
      amenities: ['wifi', 'kitchen'],
      rating: 4.90,
      review_count: 73,
      safety_belonging: {
        host_sentiment: 'exceptional',
        neighborhood_safety: 'well_lit_secure',
        inclusive_badges: ['family_ready', 'lgbtq_friendly']
      }
    },
    {
      listing_id: 'scrutiny-host-condo-austin',
      name: 'Central Urban Condo (Austin)',
      currency: 'USD',
      nightly_rate: 135,
      max_guests: 4,
      amenities: ['wifi', 'kitchen'],
      rating: 4.70,
      review_count: 51,
      safety_belonging: {
        host_sentiment: 'concerning', // Host discriminates or micromanages families/minorities
        neighborhood_safety: 'standard_residential'
      }
    }
  ]
};

test('decision intelligence penalizes and flags discriminatory host review signals', () => {
  const result = decideLodging(diverseTravelerRequest);

  assert.equal(result.recommended_listing_id, 'welcoming-family-cottage-austin');
  const scrutinyCondo = result.ranked_candidates[1];

  assert.equal(scrutinyCondo.eligible, false);
  assert.ok(scrutinyCondo.hard_constraint_failures.includes('safety:host_discrimination_risk'));
});
