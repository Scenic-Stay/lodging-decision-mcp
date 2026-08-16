import type { ListingCandidate, LodgingDecisionRequest, ScenicGraphApiError, TravelerProfile, TripContext } from './contracts';

export class DecisionRequestError extends Error {
  readonly details: string[];

  constructor(details: string[]) {
    super('The lodging decision request is invalid.');
    this.name = 'DecisionRequestError';
    this.details = details;
  }

  toResponse(): ScenicGraphApiError {
    return { error: 'invalid_request', message: this.message, details: this.details };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validateStringArray(value: unknown, path: string, errors: string[]) {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    errors.push(`${path} must be an array of non-empty strings.`);
  }
}

function validateTraveler(value: unknown, errors: string[]): value is TravelerProfile {
  if (!isRecord(value)) {
    errors.push('traveler must be an object.');
    return false;
  }
  validateStringArray(value.preferences, 'traveler.preferences', errors);
  validateStringArray(value.accessibility_needs, 'traveler.accessibility_needs', errors);
  if (value.profile_id !== undefined && typeof value.profile_id !== 'string') errors.push('traveler.profile_id must be a string when provided.');
  if (value.traveler_type !== undefined && typeof value.traveler_type !== 'string') errors.push('traveler.traveler_type must be a string when provided.');
  return true;
}

function validateTrip(value: unknown, errors: string[]): value is TripContext {
  if (!isRecord(value)) {
    errors.push('trip must be an object.');
    return false;
  }
  const allowedPurposes = new Set(['leisure', 'business', 'remote-work', 'family', 'event', 'relocation', 'other']);
  if (typeof value.purpose !== 'string' || !allowedPurposes.has(value.purpose)) errors.push('trip.purpose must be a supported trip purpose.');
  if (!Number.isInteger(value.group_size) || Number(value.group_size) < 1) errors.push('trip.group_size must be a positive integer.');
  if (!Number.isInteger(value.nights) || Number(value.nights) < 1) errors.push('trip.nights must be a positive integer.');
  if (!isRecord(value.budget)) {
    errors.push('trip.budget must be an object.');
  } else {
    if (typeof value.budget.currency !== 'string' || value.budget.currency.trim() === '') errors.push('trip.budget.currency must be a non-empty string.');
    if (!isFiniteNonNegative(value.budget.max_total) || value.budget.max_total === 0) errors.push('trip.budget.max_total must be greater than zero.');
    if (value.budget.max_nightly !== undefined && !isFiniteNonNegative(value.budget.max_nightly)) errors.push('trip.budget.max_nightly must be a non-negative number when provided.');
  }
  if (value.location_preferences !== undefined) {
    if (!isRecord(value.location_preferences)) {
      errors.push('trip.location_preferences must be an object.');
    } else {
      validateStringArray(value.location_preferences.preferred_areas, 'trip.location_preferences.preferred_areas', errors);
      validateStringArray(value.location_preferences.near, 'trip.location_preferences.near', errors);
      if (value.location_preferences.max_distance_km !== undefined && !isFiniteNonNegative(value.location_preferences.max_distance_km)) errors.push('trip.location_preferences.max_distance_km must be a non-negative number.');
    }
  }
  validateStringArray(value.required_amenities, 'trip.required_amenities', errors);
  validateStringArray(value.preferred_amenities, 'trip.preferred_amenities', errors);
  validateStringArray(value.accessibility_constraints, 'trip.accessibility_constraints', errors);
  validateStringArray(value.work_constraints, 'trip.work_constraints', errors);
  return true;
}

function validateCandidate(value: unknown, index: number, errors: string[]): value is ListingCandidate {
  const path = `candidate_listings[${index}]`;
  if (!isRecord(value)) {
    errors.push(`${path} must be an object.`);
    return false;
  }
  for (const field of ['listing_id', 'name', 'currency'] as const) {
    if (typeof value[field] !== 'string' || value[field].trim() === '') errors.push(`${path}.${field} must be a non-empty string.`);
  }
  if (!isFiniteNonNegative(value.nightly_rate)) errors.push(`${path}.nightly_rate must be a non-negative number.`);
  if (!Number.isInteger(value.max_guests) || Number(value.max_guests) < 1) errors.push(`${path}.max_guests must be a positive integer.`);
  validateStringArray(value.amenities, `${path}.amenities`, errors);
  if (!Array.isArray(value.amenities)) errors.push(`${path}.amenities is required.`);
  validateStringArray(value.accessibility_features, `${path}.accessibility_features`, errors);
  validateStringArray(value.work_features, `${path}.work_features`, errors);
  validateStringArray(value.quality_signals, `${path}.quality_signals`, errors);
  validateStringArray(value.review_signals, `${path}.review_signals`, errors);
  validateStringArray(value.nearby, `${path}.nearby`, errors);
  if (value.distance_to_preference_km !== undefined && !isFiniteNonNegative(value.distance_to_preference_km)) errors.push(`${path}.distance_to_preference_km must be non-negative.`);
  if (value.rating !== undefined && (!isFiniteNonNegative(value.rating) || value.rating > 5)) errors.push(`${path}.rating must be between 0 and 5.`);
  if (value.review_count !== undefined && (!Number.isInteger(value.review_count) || Number(value.review_count) < 0)) errors.push(`${path}.review_count must be a non-negative integer.`);
  if (value.fees !== undefined) {
    if (!isRecord(value.fees)) {
      errors.push(`${path}.fees must be an object.`);
    } else {
      for (const key of ['cleaning', 'service', 'taxes', 'other'] as const) {
        if (value.fees[key] !== undefined && !isFiniteNonNegative(value.fees[key])) errors.push(`${path}.fees.${key} must be non-negative.`);
      }
    }
  }
  if (value.policy !== undefined) {
    if (!isRecord(value.policy)) {
      errors.push(`${path}.policy must be an object.`);
    } else {
      if (value.policy.cancellation !== undefined && !['flexible', 'moderate', 'strict', 'unknown'].includes(String(value.policy.cancellation))) errors.push(`${path}.policy.cancellation is invalid.`);
      if (value.policy.minimum_nights !== undefined && (!Number.isInteger(value.policy.minimum_nights) || Number(value.policy.minimum_nights) < 1)) errors.push(`${path}.policy.minimum_nights must be a positive integer.`);
      if (value.policy.instant_book !== undefined && typeof value.policy.instant_book !== 'boolean') errors.push(`${path}.policy.instant_book must be boolean.`);
      validateStringArray(value.policy.house_rules, `${path}.policy.house_rules`, errors);
    }
  }
  return true;
}

export function parseDecisionRequest(input: unknown): LodgingDecisionRequest {
  const errors: string[] = [];
  if (!isRecord(input)) throw new DecisionRequestError(['Request body must be a JSON object.']);
  validateTraveler(input.traveler, errors);
  validateTrip(input.trip, errors);
  if (!Array.isArray(input.candidate_listings) || input.candidate_listings.length === 0) {
    errors.push('candidate_listings must contain at least one listing.');
  } else {
    if (input.candidate_listings.length > 50) errors.push('candidate_listings cannot contain more than 50 listings.');
    input.candidate_listings.forEach((candidate, index) => validateCandidate(candidate, index, errors));
    const ids = input.candidate_listings.filter(isRecord).map((candidate) => candidate.listing_id).filter((id): id is string => typeof id === 'string');
    if (new Set(ids).size !== ids.length) errors.push('candidate_listings listing_id values must be unique.');
  }
  if (errors.length > 0) throw new DecisionRequestError(errors);
  return input as LodgingDecisionRequest;
}
