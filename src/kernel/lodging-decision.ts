import { createHash } from 'node:crypto';

import type { BookingNextAction, ConstraintMatch, DecisionEvidence, DecisionRiskFlag, DecisionTradeoff, ListingCandidate, LodgingDecisionRequest, LodgingDecisionResponse, RankedCandidate, ScoreBreakdown } from './contracts';

type CandidateEvaluation = RankedCandidate & {
  candidate: ListingCandidate;
  constraints: ConstraintMatch[];
  evidence: DecisionEvidence[];
  risks: DecisionRiskFlag[];
  missing: string[];
};

const round = (value: number, places = 2) => {
  const multiplier = 10 ** places;
  return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
};
const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
const normalize = (value: string) => value.trim().toLocaleLowerCase('en-US');
const normalizedSet = (values: string[] | undefined) => new Set((values ?? []).map(normalize));

function feeTotal(candidate: ListingCandidate) {
  const fees = candidate.fees;
  return round((fees?.cleaning ?? 0) + (fees?.service ?? 0) + (fees?.taxes ?? 0) + (fees?.other ?? 0));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function constraint(listingId: string, name: string, status: ConstraintMatch['status'], evidence: string): ConstraintMatch {
  return { listing_id: listingId, constraint: name, status, evidence };
}

function evaluateCandidate(request: LodgingDecisionRequest, candidate: ListingCandidate): CandidateEvaluation {
  const { trip, traveler } = request;
  const listingId = candidate.listing_id;
  const fees = feeTotal(candidate);
  const estimatedTotal = round(candidate.nightly_rate * trip.nights + fees);
  const amenitySet = normalizedSet(candidate.amenities);
  const accessibilitySet = normalizedSet(candidate.accessibility_features);
  const workSet = normalizedSet(candidate.work_features);
  const nearbySet = normalizedSet(candidate.nearby);
  const requiredAmenities = trip.required_amenities ?? [];
  const preferredAmenities = [...(trip.preferred_amenities ?? []), ...(traveler.preferences ?? [])];
  const accessibilityConstraints = [...(trip.accessibility_constraints ?? []), ...(traveler.accessibility_needs ?? [])];
  const workConstraints = trip.work_constraints ?? [];
  const constraints: ConstraintMatch[] = [];
  const risks: DecisionRiskFlag[] = [];
  const evidence: DecisionEvidence[] = [];
  const missing: string[] = [];
  const hardFailures: string[] = [];

  const groupMet = candidate.max_guests >= trip.group_size;
  constraints.push(constraint(listingId, 'group_size', groupMet ? 'met' : 'unmet', `${candidate.max_guests} guest capacity for a group of ${trip.group_size}.`));
  if (!groupMet) hardFailures.push('group_size');

  const currencyMatches = normalize(candidate.currency) === normalize(trip.budget.currency);
  constraints.push(constraint(listingId, 'budget_currency', currencyMatches ? 'met' : 'unknown', currencyMatches ? `Both values use ${trip.budget.currency}.` : `Cannot compare ${candidate.currency} listing prices with a ${trip.budget.currency} budget.`));
  if (!currencyMatches) {
    hardFailures.push('budget_currency');
    risks.push({ listing_id: listingId, code: 'CURRENCY_MISMATCH', severity: 'high', message: 'Listing and traveler budget use different currencies.' });
  }

  const totalBudgetMet = currencyMatches && estimatedTotal <= trip.budget.max_total;
  constraints.push(constraint(listingId, 'max_total_budget', currencyMatches ? (totalBudgetMet ? 'met' : 'unmet') : 'unknown', `${estimatedTotal} ${candidate.currency} estimated total versus ${trip.budget.max_total} ${trip.budget.currency} maximum.`));
  if (currencyMatches && !totalBudgetMet) hardFailures.push('max_total_budget');

  if (trip.budget.max_nightly !== undefined) {
    const nightlyMet = currencyMatches && candidate.nightly_rate <= trip.budget.max_nightly;
    constraints.push(constraint(listingId, 'max_nightly_budget', currencyMatches ? (nightlyMet ? 'met' : 'unmet') : 'unknown', `${candidate.nightly_rate} ${candidate.currency} nightly versus ${trip.budget.max_nightly} ${trip.budget.currency} maximum.`));
    if (currencyMatches && !nightlyMet) hardFailures.push('max_nightly_budget');
  }

  for (const amenity of requiredAmenities) {
    const met = amenitySet.has(normalize(amenity));
    constraints.push(constraint(listingId, `required_amenity:${amenity}`, met ? 'met' : 'unmet', met ? `${amenity} is listed.` : `${amenity} is not listed.`));
    if (!met) hardFailures.push(`required_amenity:${amenity}`);
  }
  for (const feature of accessibilityConstraints) {
    const met = accessibilitySet.has(normalize(feature));
    constraints.push(constraint(listingId, `accessibility:${feature}`, met ? 'met' : 'unmet', met ? `${feature} is explicitly supported.` : `${feature} is not confirmed.`));
    if (!met) hardFailures.push(`accessibility:${feature}`);
  }
  for (const feature of workConstraints) {
    const met = workSet.has(normalize(feature));
    constraints.push(constraint(listingId, `work:${feature}`, met ? 'met' : 'unmet', met ? `${feature} is explicitly supported.` : `${feature} is not confirmed.`));
    if (!met) hardFailures.push(`work:${feature}`);
  }

  const minimumNights = candidate.policy?.minimum_nights;
  if (minimumNights !== undefined) {
    const met = trip.nights >= minimumNights;
    constraints.push(constraint(listingId, 'minimum_nights', met ? 'met' : 'unmet', `${trip.nights}-night trip versus ${minimumNights}-night minimum.`));
    if (!met) hardFailures.push('minimum_nights');
  } else {
    constraints.push(constraint(listingId, 'minimum_nights', 'unknown', 'Minimum-stay policy was not supplied.'));
    missing.push('minimum_nights policy');
  }

  const location = trip.location_preferences;
  if (location?.max_distance_km !== undefined) {
    if (candidate.distance_to_preference_km === undefined) {
      constraints.push(constraint(listingId, 'max_distance', 'unknown', 'Distance to the preferred location was not supplied.'));
      missing.push('distance to preferred location');
    } else {
      const met = candidate.distance_to_preference_km <= location.max_distance_km;
      constraints.push(constraint(listingId, 'max_distance', met ? 'met' : 'unmet', `${candidate.distance_to_preference_km} km away versus ${location.max_distance_km} km maximum.`));
      if (!met) hardFailures.push('max_distance');
    }
  }

  const budgetRatio = currencyMatches ? estimatedTotal / trip.budget.max_total : 2;
  const budgetScore = currencyMatches ? budgetRatio <= 1 ? 12 + 8 * (1 - budgetRatio) : Math.max(0, 12 - 20 * (budgetRatio - 1)) : 0;
  let locationScore = 0;
  if (!location) {
    locationScore = 15;
  } else {
    const preferredAreas = normalizedSet(location.preferred_areas);
    locationScore += preferredAreas.size === 0 ? 6 : candidate.area && preferredAreas.has(normalize(candidate.area)) ? 6 : 1;
    locationScore += location.max_distance_km === undefined ? 5 : candidate.distance_to_preference_km === undefined ? 1.5 : 5 * clamp(1 - candidate.distance_to_preference_km / Math.max(location.max_distance_km, 0.1), 0, 1);
    const nearTargets = location.near ?? [];
    locationScore += nearTargets.length === 0 ? 4 : 4 * (nearTargets.filter((target) => nearbySet.has(normalize(target))).length / nearTargets.length);
  }

  const requiredMatches = requiredAmenities.filter((amenity) => amenitySet.has(normalize(amenity))).length;
  const preferredMatches = preferredAmenities.filter((amenity) => amenitySet.has(normalize(amenity))).length;
  const amenitiesScore = (requiredAmenities.length ? 12 * requiredMatches / requiredAmenities.length : 12) + (preferredAmenities.length ? 3 * preferredMatches / preferredAmenities.length : 3);
  const accessibilityMatches = accessibilityConstraints.filter((item) => accessibilitySet.has(normalize(item))).length;
  const accessibilityScore = accessibilityConstraints.length ? 10 * accessibilityMatches / accessibilityConstraints.length : 10;
  const workMatches = workConstraints.filter((item) => workSet.has(normalize(item))).length;
  const workScore = workConstraints.length ? 10 * workMatches / workConstraints.length : 10;

  let qualityScore = 6;
  if (candidate.rating === undefined) missing.push('rating');
  else qualityScore = 16 * clamp((candidate.rating - 3) / 2, 0, 1);
  if (candidate.review_count === undefined) missing.push('review_count');
  else qualityScore += Math.min(3, Math.log10(candidate.review_count + 1) * 1.25);
  qualityScore += Math.min(1, (candidate.quality_signals?.length ?? 0) * 0.5);
  qualityScore -= Math.min(2, (candidate.review_signals ?? []).filter((item) => /negative|noise|dirty|cancel/i.test(item)).length);
  qualityScore = clamp(qualityScore, 0, 20);

  const cancellation = candidate.policy?.cancellation;
  let policyScore = cancellation === 'flexible' ? 4 : cancellation === 'moderate' ? 3 : cancellation === 'strict' ? 1 : 2;
  if (candidate.policy?.instant_book) policyScore += 1;
  policyScore = Math.min(5, policyScore);
  if (!cancellation || cancellation === 'unknown') missing.push('cancellation policy');

  let feesScore = 2.5;
  if (!candidate.fees) {
    missing.push('fee breakdown');
    risks.push({ listing_id: listingId, code: 'FEES_UNCONFIRMED', severity: 'medium', message: 'The estimate excludes any fees not supplied by the candidate.' });
  } else {
    const roomSubtotal = candidate.nightly_rate * trip.nights;
    const feeRatio = roomSubtotal > 0 ? fees / roomSubtotal : 1;
    feesScore = feeRatio <= 0.1 ? 5 : feeRatio <= 0.2 ? 3.5 : feeRatio <= 0.35 ? 2 : 0.5;
    if (feeRatio > 0.35) risks.push({ listing_id: listingId, code: 'HIGH_FEE_LOAD', severity: 'medium', message: 'Fees exceed 35% of the room subtotal.' });
  }

  if (candidate.rating !== undefined && candidate.rating < 4.2) risks.push({ listing_id: listingId, code: 'LOW_RATING', severity: 'medium', message: `Rating is ${candidate.rating}, below the 4.2 quality caution threshold.` });
  if (candidate.review_count !== undefined && candidate.review_count < 10) risks.push({ listing_id: listingId, code: 'LIMITED_REVIEW_HISTORY', severity: 'low', message: 'The listing has fewer than 10 reviews.' });
  if (candidate.review_signals?.length) risks.push({ listing_id: listingId, code: 'REVIEW_CAUTION', severity: 'medium', message: candidate.review_signals.join(' ') });
  if (hardFailures.length) risks.push({ listing_id: listingId, code: 'HARD_CONSTRAINT_FAILURE', severity: 'high', message: `Fails: ${hardFailures.join(', ')}.` });

  evidence.push({ listing_id: listingId, signal: 'estimated_total', value: estimatedTotal, impact: totalBudgetMet ? 'positive' : 'negative', explanation: `${trip.nights} nights plus supplied fees, compared with the trip budget.` });
  evidence.push({ listing_id: listingId, signal: 'required_amenities', value: `${requiredMatches}/${requiredAmenities.length}`, impact: requiredMatches === requiredAmenities.length ? 'positive' : 'negative', explanation: 'Explicit match count for required amenities.' });
  if (candidate.rating !== undefined) evidence.push({ listing_id: listingId, signal: 'rating', value: candidate.rating, impact: candidate.rating >= 4.7 ? 'positive' : candidate.rating < 4.2 ? 'negative' : 'neutral', explanation: `Quality signal backed by ${candidate.review_count ?? 'an unknown number of'} reviews.` });
  if (candidate.distance_to_preference_km !== undefined) evidence.push({ listing_id: listingId, signal: 'distance_to_preference_km', value: candidate.distance_to_preference_km, impact: location?.max_distance_km !== undefined && candidate.distance_to_preference_km > location.max_distance_km ? 'negative' : 'positive', explanation: 'Candidate-provided distance to the traveler location preference.' });

  const scoreBreakdown: ScoreBreakdown = {
    budget: round(budgetScore), location: round(locationScore), amenities: round(amenitiesScore),
    accessibility: round(accessibilityScore), work: round(workScore), quality: round(qualityScore),
    policy: round(policyScore), fees: round(feesScore)
  };
  const rawScore = Object.values(scoreBreakdown).reduce((sum, score) => sum + score, 0);
  const score = round(clamp(rawScore - hardFailures.length * 12, 0, 100));
  const eligible = hardFailures.length === 0;

  return {
    rank: 0, listing_id: listingId, score, eligible, estimated_total: estimatedTotal, currency: candidate.currency,
    score_breakdown: scoreBreakdown,
    summary: eligible ? `Meets all confirmed hard constraints with a ${score}/100 deterministic score.` : `Fallback only: fails ${hardFailures.join(', ')} with a ${score}/100 deterministic score.`,
    hard_constraint_failures: hardFailures, candidate, constraints, evidence, risks, missing: [...new Set(missing)]
  };
}

function buildTradeoffs(recommended: CandidateEvaluation, runnerUp: CandidateEvaluation | undefined): DecisionTradeoff[] {
  const tradeoffs: DecisionTradeoff[] = [];
  if (runnerUp) {
    if (recommended.estimated_total > runnerUp.estimated_total) tradeoffs.push({ listing_id: recommended.listing_id, description: `Costs ${round(recommended.estimated_total - runnerUp.estimated_total)} ${recommended.currency} more than ${runnerUp.listing_id}.` });
    if ((recommended.candidate.rating ?? 0) < (runnerUp.candidate.rating ?? 0)) tradeoffs.push({ listing_id: recommended.listing_id, description: `Has a lower supplied rating than ${runnerUp.listing_id}.` });
    if ((recommended.candidate.distance_to_preference_km ?? 0) > (runnerUp.candidate.distance_to_preference_km ?? Number.POSITIVE_INFINITY)) tradeoffs.push({ listing_id: recommended.listing_id, description: `Is farther from the stated location preference than ${runnerUp.listing_id}.` });
  }
  if (recommended.missing.length) tradeoffs.push({ listing_id: recommended.listing_id, description: `Recommendation relies on incomplete information: ${recommended.missing.join(', ')}.` });
  if (!tradeoffs.length) tradeoffs.push({ listing_id: recommended.listing_id, description: 'No material tradeoff was found in the supplied candidate signals.' });
  return tradeoffs;
}

function buildNextAction(recommended: CandidateEvaluation, confidence: number): BookingNextAction {
  if (!recommended.eligible) return { action: 'expand_search', listing_id: recommended.listing_id, instructions: 'Do not book yet. No candidate satisfies every hard constraint; expand the search or relax constraints explicitly.', checks: recommended.hard_constraint_failures };
  if (confidence < 0.55) return { action: 'collect_information', listing_id: recommended.listing_id, instructions: 'Collect the missing decision signals before booking.', checks: recommended.missing };
  if (recommended.missing.length || recommended.risks.some((risk) => risk.severity !== 'low')) return { action: 'verify_then_book', listing_id: recommended.listing_id, instructions: 'Verify the unresolved signals, then book this listing if they are confirmed.', checks: [...recommended.missing, ...recommended.risks.map((risk) => risk.message)] };
  return { action: 'book', listing_id: recommended.listing_id, instructions: 'Book the recommended listing using the supplied terms, then retain this decision record.', checks: ['Confirm live price and availability before purchase.'] };
}

export function decideLodging(request: LodgingDecisionRequest): LodgingDecisionResponse {
  const evaluations = request.candidate_listings.map((candidate) => evaluateCandidate(request, candidate));
  evaluations.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score || a.estimated_total - b.estimated_total || a.listing_id.localeCompare(b.listing_id));
  evaluations.forEach((evaluation, index) => { evaluation.rank = index + 1; });
  const recommended = evaluations[0];
  const runnerUp = evaluations[1];
  const margin = runnerUp ? recommended.score - runnerUp.score : 10;
  const completeness = 1 - Math.min(recommended.missing.length, 5) / 5;
  const confidence = round(clamp(0.5 + clamp(margin, 0, 30) / 100 * 0.25 + completeness * 0.25 - (recommended.eligible ? 0 : 0.2), 0.2, 0.95));
  const tradeoffs = buildTradeoffs(recommended, runnerUp);
  const nextAction = buildNextAction(recommended, confidence);
  const eligibleText = recommended.eligible ? 'It satisfies every confirmed hard constraint.' : 'No candidate satisfies every hard constraint, so this is only the highest-ranked fallback.';
  const decisionReason = `${recommended.candidate.name} ranks first at ${recommended.score}/100. ${eligibleText}`;
  const agentExplanation = `Recommend ${recommended.candidate.name} (${recommended.listing_id}). ${decisionReason} Estimated trip total is ${recommended.estimated_total} ${recommended.currency}. Confidence is ${confidence}. Main tradeoff: ${tradeoffs[0].description} Next action: ${nextAction.instructions}`;
  const decisionId = `sg_${createHash('sha256').update(stableStringify(request)).digest('hex').slice(0, 16)}`;
  return {
    decision_id: decisionId,
    recommended_listing_id: recommended.listing_id,
    ranked_candidates: evaluations.map(({ candidate: _candidate, constraints: _constraints, evidence: _evidence, risks: _risks, missing: _missing, ...ranked }) => ranked),
    decision_reason: decisionReason,
    evidence: recommended.evidence,
    tradeoffs,
    risk_flags: recommended.risks,
    constraint_matches: recommended.constraints,
    confidence,
    missing_information: recommended.missing,
    agent_explanation: agentExplanation,
    booking_next_action: nextAction
  };
}
