export type TripPurpose = 'leisure' | 'business' | 'remote-work' | 'family' | 'event' | 'relocation' | 'other';

export type TravelerProfile = {
  profile_id?: string;
  traveler_type?: string;
  preferences?: string[];
  accessibility_needs?: string[];
};

export type Budget = { currency: string; max_total: number; max_nightly?: number };

export type LocationPreferences = {
  preferred_areas?: string[];
  max_distance_km?: number;
  near?: string[];
};

export type TripContext = {
  purpose: TripPurpose;
  group_size: number;
  nights: number;
  budget: Budget;
  location_preferences?: LocationPreferences;
  required_amenities?: string[];
  preferred_amenities?: string[];
  accessibility_constraints?: string[];
  work_constraints?: string[];
};

export type ListingPolicy = {
  cancellation?: 'flexible' | 'moderate' | 'strict' | 'unknown';
  minimum_nights?: number;
  instant_book?: boolean;
  house_rules?: string[];
};

export type ListingFees = { cleaning?: number; service?: number; taxes?: number; other?: number };

export type ListingCandidate = {
  listing_id: string;
  name: string;
  currency: string;
  nightly_rate: number;
  max_guests: number;
  area?: string;
  distance_to_preference_km?: number;
  nearby?: string[];
  amenities: string[];
  accessibility_features?: string[];
  work_features?: string[];
  rating?: number;
  review_count?: number;
  quality_signals?: string[];
  review_signals?: string[];
  policy?: ListingPolicy;
  fees?: ListingFees;
};

export type LodgingDecisionRequest = {
  traveler: TravelerProfile;
  trip: TripContext;
  candidate_listings: ListingCandidate[];
};

export type ConstraintStatus = 'met' | 'unmet' | 'unknown';
export type ConstraintMatch = { listing_id: string; constraint: string; status: ConstraintStatus; evidence: string };
export type DecisionEvidence = { listing_id: string; signal: string; value: string | number | boolean; impact: 'positive' | 'negative' | 'neutral'; explanation: string };
export type DecisionTradeoff = { listing_id: string; description: string };
export type DecisionRiskFlag = { listing_id: string; code: string; severity: 'low' | 'medium' | 'high'; message: string };

export type ScoreBreakdown = {
  budget: number;
  location: number;
  amenities: number;
  accessibility: number;
  work: number;
  quality: number;
  policy: number;
  fees: number;
};

export type RankedCandidate = {
  rank: number;
  listing_id: string;
  score: number;
  eligible: boolean;
  estimated_total: number;
  currency: string;
  score_breakdown: ScoreBreakdown;
  summary: string;
  hard_constraint_failures: string[];
};

export type BookingNextAction = {
  action: 'book' | 'verify_then_book' | 'collect_information' | 'expand_search';
  listing_id: string;
  instructions: string;
  checks: string[];
};

export type LodgingDecisionResponse = {
  decision_id: string;
  recommended_listing_id: string;
  ranked_candidates: RankedCandidate[];
  decision_reason: string;
  evidence: DecisionEvidence[];
  tradeoffs: DecisionTradeoff[];
  risk_flags: DecisionRiskFlag[];
  constraint_matches: ConstraintMatch[];
  confidence: number;
  missing_information: string[];
  agent_explanation: string;
  booking_next_action: BookingNextAction;
};

export type ScenicGraphApiError = {
  error: 'invalid_request' | 'invalid_json';
  message: string;
  details: string[];
};
