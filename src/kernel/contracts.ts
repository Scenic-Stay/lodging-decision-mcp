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

export type WorkspaceDeskType = 'standing_desk' | 'ergonomic_desk' | 'standard_desk' | 'dining_table' | 'laptop_tray' | 'none';
export type WorkspaceChairType = 'ergonomic_office' | 'task_chair' | 'dining_chair' | 'none';

export type WorkspaceDetails = {
  dedicated_room?: boolean;
  desk_type?: WorkspaceDeskType;
  chair_type?: WorkspaceChairType;
  external_monitor?: boolean;
  docking_station?: boolean;
  verified_wifi_mbps?: number;
  ethernet_available?: boolean;
};

export type PropertyStructure = 'detached_guesthouse' | 'private_adu' | 'top_floor_flat' | 'shared_wall_apartment' | 'ground_floor_street';
export type AcousticExposure = 'garden_courtyard' | 'quiet_residential' | 'mixed_arterial' | 'busy_commercial';

export type AcousticProfile = {
  structure?: PropertyStructure;
  exposure?: AcousticExposure;
  double_pane_windows?: boolean;
  quiet_hours_enforced?: boolean;
  noise_review_sentiment?: 'silent' | 'quiet' | 'moderate' | 'noisy';
};

export type MarketContext = {
  submarket_baseline_adr?: number;
  submarket_name?: string;
  median_cleaning_fee?: number;
};

export type CheckinType = 'keyless_smart_lock' | 'keypad_lockbox' | 'in_person_host';

export type AccessDetails = {
  checkin_type?: CheckinType;
  superhost?: boolean;
  guest_favorite?: boolean;
  host_response_rate_pct?: number;
  host_response_time_minutes?: number;
};

export type HostSentimentRating = 'exceptional' | 'welcoming' | 'neutral' | 'cautionary' | 'concerning';
export type NeighborhoodSafetyRating = 'well_lit_secure' | 'standard_residential' | 'cautionary_at_night' | 'high_incident_area';

export type PrivacyIntegrity = {
  private_entrance?: boolean;
  undisclosed_cameras_reported?: boolean;
  host_unannounced_entry_reported?: boolean;
  keyless_security_verified?: boolean;
};

export type SafetyBelongingProfile = {
  host_sentiment?: HostSentimentRating;
  host_sentiment_signals?: string[];
  neighborhood_safety?: NeighborhoodSafetyRating;
  neighborhood_safety_signals?: string[];
  privacy_integrity?: PrivacyIntegrity;
  inclusive_badges?: string[];
};

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
  workspace_details?: WorkspaceDetails;
  acoustic_profile?: AcousticProfile;
  market_context?: MarketContext;
  access_details?: AccessDetails;
  safety_belonging?: SafetyBelongingProfile;
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
  ergonomics?: number;
  acoustics?: number;
  price_sanity?: number;
  access_reliability?: number;
  safety_belonging?: number;
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
