import type { ListingCandidate, LodgingDecisionRequest } from './contracts';

export const sampleListingCandidates: ListingCandidate[] = [
  {
    listing_id: 'harbor-work-studio', name: 'Harbor Work Studio', currency: 'USD', nightly_rate: 180, max_guests: 2,
    area: 'Waterfront', distance_to_preference_km: 1.2, nearby: ['convention center', 'light rail'],
    amenities: ['wifi', 'kitchen', 'quiet', 'air conditioning'], accessibility_features: ['step-free entry', 'walk-in shower'],
    work_features: ['dedicated workspace', 'ethernet', 'video-call lighting'], rating: 4.88, review_count: 214,
    quality_signals: ['verified host', 'consistent cleanliness'],
    policy: { cancellation: 'flexible', minimum_nights: 2, instant_book: true }, fees: { cleaning: 55, service: 42, taxes: 38 }
  },
  {
    listing_id: 'garden-value-flat', name: 'Garden Value Flat', currency: 'USD', nightly_rate: 145, max_guests: 3,
    area: 'Garden District', distance_to_preference_km: 3.8, nearby: ['bus line'], amenities: ['wifi', 'kitchen', 'quiet', 'washer'],
    accessibility_features: ['step-free entry'], work_features: ['dedicated workspace'], rating: 4.95, review_count: 61,
    quality_signals: ['verified host'], policy: { cancellation: 'moderate', minimum_nights: 2, instant_book: false },
    fees: { cleaning: 75, service: 44, taxes: 31 }
  },
  {
    listing_id: 'old-town-design-loft', name: 'Old Town Design Loft', currency: 'USD', nightly_rate: 205, max_guests: 4,
    area: 'Old Town', distance_to_preference_km: 0.4, nearby: ['convention center', 'light rail', 'restaurants'],
    amenities: ['wifi', 'kitchen', 'air conditioning', 'washer'], accessibility_features: [],
    work_features: ['dedicated workspace', 'ethernet'], rating: 4.72, review_count: 132,
    review_signals: ['Some recent reviews mention street noise.'],
    policy: { cancellation: 'strict', minimum_nights: 3, instant_book: true }, fees: { cleaning: 90, service: 58, taxes: 42 }
  }
];

export const remoteWorkSampleRequest: LodgingDecisionRequest = {
  traveler: { profile_id: 'sample-remote-worker', traveler_type: 'remote worker', preferences: ['quiet'], accessibility_needs: ['step-free entry'] },
  trip: {
    purpose: 'remote-work', group_size: 2, nights: 3, budget: { currency: 'USD', max_total: 900, max_nightly: 225 },
    location_preferences: { preferred_areas: ['Waterfront', 'Old Town'], max_distance_km: 3, near: ['convention center', 'light rail'] },
    required_amenities: ['wifi', 'kitchen'], preferred_amenities: ['air conditioning'], accessibility_constraints: [],
    work_constraints: ['dedicated workspace', 'ethernet']
  },
  candidate_listings: sampleListingCandidates
};

export const familySampleRequest: LodgingDecisionRequest = {
  traveler: { profile_id: 'sample-family', traveler_type: 'family', preferences: ['quiet'] },
  trip: {
    purpose: 'family', group_size: 3, nights: 4, budget: { currency: 'USD', max_total: 950, max_nightly: 190 },
    location_preferences: { preferred_areas: ['Garden District'], max_distance_km: 5 }, required_amenities: ['wifi', 'kitchen'],
    preferred_amenities: ['washer'], accessibility_constraints: ['step-free entry'], work_constraints: []
  },
  candidate_listings: sampleListingCandidates
};

export const sampleTravelerTripContexts = [remoteWorkSampleRequest, familySampleRequest];
