// Defense-in-depth guard for DI-001-A (see gauntlet/projects/decision-intelligence-v0.1/WORK-ORDERS.yaml).
//
// PR #25's kernel (src/kernel/*) already has no protected-characteristic fields --
// this guard exists because DI-001-A exposes the kernel to untrusted external MCP
// callers, unlike PR #25's original internal-only design assumption. It is a coarse
// substring heuristic on free-text fields, not a substitute for Doc 36's
// ethical-sourcing pipeline or named counsel review. It intentionally does NOT scan
// accessibility fields (traveler.accessibility_needs, trip.accessibility_constraints,
// candidate accessibility_features) -- those are the approved, structured
// Accessibility category, not discriminatory steering text.

import type { LodgingDecisionRequest } from './kernel/contracts';

export class GuardRejectionError extends Error {
  readonly flaggedFields: string[];

  constructor(flaggedFields: string[]) {
    super(
      'This request was rejected because one or more free-text fields appear to reference a ' +
        'protected characteristic or discriminatory steering criterion. This tool only supports ' +
        'non-sensitive categories (budget, location, amenities, quality, policy, fees, remote-work/' +
        'family/business framing, and stated accessibility needs). It does not accept or act on ' +
        'race, color, national origin, religion, sex, gender identity, sexual orientation, familial ' +
        'status, or similar signals in any field.'
    );
    this.name = 'GuardRejectionError';
    this.flaggedFields = flaggedFields;
  }
}

// Coarse, intentionally narrow starter list. Extend only after review -- broadening
// this list is a content decision, not a routine code change, given what it is meant
// to prevent.
const DENYLIST_TERMS = [
  'race', 'racial', 'ethnicity', 'ethnic', 'black', 'white', 'asian', 'hispanic', 'latino', 'latina',
  'national origin', 'immigrant', 'citizenship',
  'religion', 'religious', 'christian', 'muslim', 'jewish', 'hindu', 'atheist',
  'sexual orientation', 'gay', 'lesbian', 'lgbt', 'transgender', 'gender identity',
  'familial status', 'no children', 'no kids', 'adults only', 'no families', 'singles only',
  'disability status', 'disabled people', 'able-bodied only',
  'sex', 'gender', 'male only', 'female only', 'men only', 'women only',
];

function containsDenylistedTerm(value: string): string | null {
  const lower = value.toLowerCase();
  for (const term of DENYLIST_TERMS) {
    if (lower.includes(term)) return term;
  }
  return null;
}

function scanStringArray(values: string[] | undefined, path: string, flagged: string[]) {
  if (!values) return;
  for (const value of values) {
    const hit = containsDenylistedTerm(value);
    if (hit) flagged.push(`${path} contains "${hit}"`);
  }
}

function scanString(value: string | undefined, path: string, flagged: string[]) {
  if (!value) return;
  const hit = containsDenylistedTerm(value);
  if (hit) flagged.push(`${path} contains "${hit}"`);
}

/**
 * Scans the free-text (non-accessibility) fields of a decision request for
 * protected-characteristic / discriminatory-steering terms. Throws
 * GuardRejectionError if any are found; the caller must not silently strip and
 * proceed, so the exclusion stays legible to the calling agent.
 */
export function guardRequest(request: LodgingDecisionRequest): void {
  const flagged: string[] = [];

  scanString(request.traveler.traveler_type, 'traveler.traveler_type', flagged);
  scanStringArray(request.traveler.preferences, 'traveler.preferences', flagged);

  request.candidate_listings.forEach((candidate, index) => {
    scanString(candidate.name, `candidate_listings[${index}].name`, flagged);
    scanStringArray(candidate.quality_signals, `candidate_listings[${index}].quality_signals`, flagged);
    scanStringArray(candidate.review_signals, `candidate_listings[${index}].review_signals`, flagged);
    scanStringArray(candidate.policy?.house_rules, `candidate_listings[${index}].policy.house_rules`, flagged);
  });

  if (flagged.length > 0) {
    throw new GuardRejectionError(flagged);
  }
}
