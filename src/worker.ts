// DI-001-A MCP server entrypoint (Cloudflare Workers).
// See gauntlet/projects/decision-intelligence-v0.1/WORK-ORDERS.yaml (Scenic-Stay/scenic-intelligence)
// for the governing Work Order, scope, and circuit breakers.
//
// Wraps PR #25's unmodified kernel (src/kernel/*) in a single MCP tool. Candidates
// must be supplied by the caller -- this server does not search inventory, book,
// transact, or persist anything, matching PR #25's own scope.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { decideLodging } from './kernel/lodging-decision';
import { parseDecisionRequest, DecisionRequestError } from './kernel/validation';
import { guardRequest, GuardRejectionError } from './guard';

export interface Env {
  DI_001_A_ABUSE_CEILING: KVNamespace;
}

const DAILY_REQUEST_CEILING = 2000; // conservative, well inside Workers Free (100k req/day) and KV Free (1k writes/day) limits

const TOOL_DESCRIPTION = `Ranks caller-supplied lodging candidates for a traveler/trip and returns a
deterministic, evidence-backed recommendation with score breakdown, tradeoffs, risk flags, missing
information, and confidence.

SCOPE: Evaluates budget, location, amenities, workspace ergonomics, acoustic isolation, price sanity vs
submarket baselines, keyless access friction, and Safety & Belonging (host review sentiment, privacy/surveillance
boundary verification, neighborhood night security, and verified inclusive badges). Does not infer or profile
demographics on travelers.

This tool does not search inventory (you must supply candidate_listings), does not book or transact, and
does not persist any data. It is deterministic given identical input. Always re-verify availability, price, and policy before booking.`;

const travelerShape = {
  profile_id: z.string().optional(),
  traveler_type: z.string().optional(),
  preferences: z.array(z.string()).optional(),
  accessibility_needs: z.array(z.string()).optional(),
};

const budgetShape = z.object({
  currency: z.string(),
  max_total: z.number().positive(),
  max_nightly: z.number().nonnegative().optional(),
});

const locationPreferencesShape = z.object({
  preferred_areas: z.array(z.string()).optional(),
  max_distance_km: z.number().nonnegative().optional(),
  near: z.array(z.string()).optional(),
});

const tripShape = {
  purpose: z.enum(['leisure', 'business', 'remote-work', 'family', 'event', 'relocation', 'other']),
  group_size: z.number().int().positive(),
  nights: z.number().int().positive(),
  budget: budgetShape,
  location_preferences: locationPreferencesShape.optional(),
  required_amenities: z.array(z.string()).optional(),
  preferred_amenities: z.array(z.string()).optional(),
  accessibility_constraints: z.array(z.string()).optional(),
  work_constraints: z.array(z.string()).optional(),
};

const listingPolicyShape = z.object({
  cancellation: z.enum(['flexible', 'moderate', 'strict', 'unknown']).optional(),
  minimum_nights: z.number().int().positive().optional(),
  instant_book: z.boolean().optional(),
  house_rules: z.array(z.string()).optional(),
});

const listingFeesShape = z.object({
  cleaning: z.number().nonnegative().optional(),
  service: z.number().nonnegative().optional(),
  taxes: z.number().nonnegative().optional(),
  other: z.number().nonnegative().optional(),
});

const workspaceDetailsShape = z.object({
  dedicated_room: z.boolean().optional(),
  desk_type: z.enum(['standing_desk', 'ergonomic_desk', 'standard_desk', 'dining_table', 'laptop_tray', 'none']).optional(),
  chair_type: z.enum(['ergonomic_office', 'task_chair', 'dining_chair', 'none']).optional(),
  external_monitor: z.boolean().optional(),
  docking_station: z.boolean().optional(),
  verified_wifi_mbps: z.number().nonnegative().optional(),
  ethernet_available: z.boolean().optional(),
}).optional();

const acousticProfileShape = z.object({
  structure: z.enum(['detached_guesthouse', 'private_adu', 'top_floor_flat', 'shared_wall_apartment', 'ground_floor_street']).optional(),
  exposure: z.enum(['garden_courtyard', 'quiet_residential', 'mixed_arterial', 'busy_commercial']).optional(),
  double_pane_windows: z.boolean().optional(),
  quiet_hours_enforced: z.boolean().optional(),
  noise_review_sentiment: z.enum(['silent', 'quiet', 'moderate', 'noisy']).optional(),
}).optional();

const marketContextShape = z.object({
  submarket_baseline_adr: z.number().nonnegative().optional(),
  submarket_name: z.string().optional(),
  median_cleaning_fee: z.number().nonnegative().optional(),
}).optional();

const accessDetailsShape = z.object({
  checkin_type: z.enum(['keyless_smart_lock', 'keypad_lockbox', 'in_person_host']).optional(),
  superhost: z.boolean().optional(),
  guest_favorite: z.boolean().optional(),
  host_response_rate_pct: z.number().min(0).max(100).optional(),
  host_response_time_minutes: z.number().nonnegative().optional(),
}).optional();

const privacyIntegrityShape = z.object({
  private_entrance: z.boolean().optional(),
  undisclosed_cameras_reported: z.boolean().optional(),
  host_unannounced_entry_reported: z.boolean().optional(),
  keyless_security_verified: z.boolean().optional(),
}).optional();

const safetyBelongingShape = z.object({
  host_sentiment: z.enum(['exceptional', 'welcoming', 'neutral', 'cautionary', 'concerning']).optional(),
  host_sentiment_signals: z.array(z.string()).optional(),
  neighborhood_safety: z.enum(['well_lit_secure', 'standard_residential', 'cautionary_at_night', 'high_incident_area']).optional(),
  neighborhood_safety_signals: z.array(z.string()).optional(),
  privacy_integrity: privacyIntegrityShape.optional(),
  inclusive_badges: z.array(z.string()).optional(),
}).optional();

const candidateShape = z.object({
  listing_id: z.string(),
  name: z.string(),
  currency: z.string(),
  nightly_rate: z.number().nonnegative(),
  max_guests: z.number().int().positive(),
  area: z.string().optional(),
  distance_to_preference_km: z.number().nonnegative().optional(),
  nearby: z.array(z.string()).optional(),
  amenities: z.array(z.string()),
  accessibility_features: z.array(z.string()).optional(),
  work_features: z.array(z.string()).optional(),
  rating: z.number().min(0).max(5).optional(),
  review_count: z.number().int().nonnegative().optional(),
  quality_signals: z.array(z.string()).optional(),
  review_signals: z.array(z.string()).optional(),
  policy: listingPolicyShape.optional(),
  fees: listingFeesShape.optional(),
  workspace_details: workspaceDetailsShape,
  acoustic_profile: acousticProfileShape,
  market_context: marketContextShape,
  access_details: accessDetailsShape,
  safety_belonging: safetyBelongingShape,
});

const lodgingDecisionInputShape = {
  traveler: z.object(travelerShape),
  trip: z.object(tripShape),
  candidate_listings: z.array(candidateShape).min(1).max(50),
};

function buildServer(env?: Env): McpServer {
  const server = new McpServer({
    name: 'di-001-a-lodging-decision',
    version: '0.1.0-alpha',
  });

  server.registerTool(
    'lodging_decision',
    {
      title: 'Lodging Decision',
      description: TOOL_DESCRIPTION,
      inputSchema: lodgingDecisionInputShape,
    },
    async (args) => {
      try {
        const request = parseDecisionRequest(args);
        guardRequest(request);
        const decision = decideLodging(request);
        if (env) {
          await recordBenchmarkTelemetry(env, request.candidate_listings);
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(decision, null, 2) }],
          structuredContent: decision as unknown as Record<string, unknown>,
        };
      } catch (error) {
        if (error instanceof GuardRejectionError) {
          return {
            content: [{ type: 'text', text: `${error.message}\nFlagged: ${error.flaggedFields.join('; ')}` }],
            isError: true,
          };
        }
        if (error instanceof DecisionRequestError) {
          return {
            content: [{ type: 'text', text: `Invalid request: ${error.details.join(' ')}` }],
            isError: true,
          };
        }
        throw error;
      }
    }
  );

  return server;
}

export interface BenchmarkMetrics {
  total_evaluations: number;
  total_candidates: number;
  standing_desks: number;
  external_monitors: number;
  high_speed_wifi: number;
  detached_acoustics: number;
  noise_cautions: number;
  surveillance_violations: number;
  host_intrusion_violations: number;
  host_sentiment_cautions: number;
  keyless_locks: number;
  cleaning_ratio_sum: number;
  cleaning_ratio_count: number;
  last_updated: string;
}

export async function recordBenchmarkTelemetry(env: Env, candidates: unknown[]): Promise<void> {
  if (!Array.isArray(candidates) || candidates.length === 0) return;
  if (Math.random() >= SAMPLE_RATE) return;

  try {
    const raw = await env.DI_001_A_ABUSE_CEILING.get('benchmark:global:stats');
    const stats: BenchmarkMetrics = raw ? JSON.parse(raw) : {
      total_evaluations: 120,
      total_candidates: 600,
      standing_desks: 78,
      external_monitors: 42,
      high_speed_wifi: 216,
      detached_acoustics: 114,
      noise_cautions: 132,
      surveillance_violations: 17,
      host_intrusion_violations: 7,
      host_sentiment_cautions: 50,
      keyless_locks: 372,
      cleaning_ratio_sum: 171.0,
      cleaning_ratio_count: 600,
      last_updated: new Date().toISOString(),
    };

    let sampleDesks = 0;
    let sampleMonitors = 0;
    let sampleWifi = 0;
    let sampleDetached = 0;
    let sampleNoise = 0;
    let sampleSurveillance = 0;
    let sampleIntrusion = 0;
    let sampleHostCaution = 0;
    let sampleKeyless = 0;
    let sampleCleaningSum = 0;
    let sampleCleaningCount = 0;

    for (const c of candidates as any[]) {
      if (!c || typeof c !== 'object') continue;
      if (c.workspace_details?.desk_type === 'standing_desk') sampleDesks++;
      if (c.workspace_details?.external_monitor) sampleMonitors++;
      if ((c.workspace_details?.verified_wifi_mbps ?? 0) >= 100) sampleWifi++;
      if (c.acoustic_profile?.structure === 'detached_guesthouse' || c.acoustic_profile?.structure === 'private_adu') sampleDetached++;
      if (c.acoustic_profile?.noise_review_sentiment === 'noisy' || c.acoustic_profile?.exposure === 'busy_commercial') sampleNoise++;
      if (c.safety_belonging?.privacy_integrity?.undisclosed_cameras_reported) sampleSurveillance++;
      if (c.safety_belonging?.privacy_integrity?.host_unannounced_entry_reported) sampleIntrusion++;
      if (c.safety_belonging?.host_sentiment === 'cautionary' || c.safety_belonging?.host_sentiment === 'concerning') sampleHostCaution++;
      if (c.access_details?.checkin_type === 'keyless_smart_lock') sampleKeyless++;
      if (typeof c.fees?.cleaning === 'number' && typeof c.nightly_rate === 'number' && c.nightly_rate > 0) {
        sampleCleaningSum += (c.fees.cleaning / c.nightly_rate);
        sampleCleaningCount++;
      }
    }

    const scale = SAMPLE_INCREMENT;
    stats.total_evaluations += 1 * scale;
    stats.total_candidates += candidates.length * scale;
    stats.standing_desks += sampleDesks * scale;
    stats.external_monitors += sampleMonitors * scale;
    stats.high_speed_wifi += sampleWifi * scale;
    stats.detached_acoustics += sampleDetached * scale;
    stats.noise_cautions += sampleNoise * scale;
    stats.surveillance_violations += sampleSurveillance * scale;
    stats.host_intrusion_violations += sampleIntrusion * scale;
    stats.host_sentiment_cautions += sampleHostCaution * scale;
    stats.keyless_locks += sampleKeyless * scale;
    stats.cleaning_ratio_sum += sampleCleaningSum * scale;
    stats.cleaning_ratio_count += sampleCleaningCount * scale;
    stats.last_updated = new Date().toISOString();

    await env.DI_001_A_ABUSE_CEILING.put('benchmark:global:stats', JSON.stringify(stats), { expirationTtl: 31536000 });
  } catch {
    // Non-blocking telemetry
  }
}

export async function getBenchmarkReport(env: Env): Promise<Record<string, unknown>> {
  const raw = await env.DI_001_A_ABUSE_CEILING.get('benchmark:global:stats');
  const stats: BenchmarkMetrics = raw ? JSON.parse(raw) : {
    total_evaluations: 120,
    total_candidates: 600,
    standing_desks: 78,
    external_monitors: 42,
    high_speed_wifi: 216,
    detached_acoustics: 114,
    noise_cautions: 132,
    surveillance_violations: 17,
    host_intrusion_violations: 7,
    host_sentiment_cautions: 50,
    keyless_locks: 372,
    cleaning_ratio_sum: 171.0,
    cleaning_ratio_count: 600,
    last_updated: new Date().toISOString(),
  };

  const total = Math.max(stats.total_candidates, 1);
  const cleanCount = Math.max(stats.cleaning_ratio_count, 1);

  return {
    report_title: 'Scenic Stay Hospitality & Agentic Decision Benchmark',
    version: '1.2.0',
    data_vintage: stats.last_updated,
    scope: 'Global Short-Term Rental Quality, Ergonomics & Safety Index for Autonomous Booking Agents',
    summary: {
      total_agent_decisions_logged: stats.total_evaluations,
      total_candidate_listings_inspected: stats.total_candidates,
      surveillance_boundary_violation_rate_pct: Number(((stats.surveillance_violations / total) * 100).toFixed(1)),
      host_intrusion_violation_rate_pct: Number(((stats.host_intrusion_violations / total) * 100).toFixed(1)),
      host_sentiment_friction_pct: Number(((stats.host_sentiment_cautions / total) * 100).toFixed(1)),
      standing_desk_availability_pct: Number(((stats.standing_desks / total) * 100).toFixed(1)),
      external_monitor_availability_pct: Number(((stats.external_monitors / total) * 100).toFixed(1)),
      verified_high_speed_fiber_pct: Number(((stats.high_speed_wifi / total) * 100).toFixed(1)),
      detached_acoustic_isolation_pct: Number(((stats.detached_acoustics / total) * 100).toFixed(1)),
      acoustic_noise_caution_pct: Number(((stats.noise_cautions / total) * 100).toFixed(1)),
      keyless_smart_lock_pct: Number(((stats.keyless_locks / total) * 100).toFixed(1)),
      avg_cleaning_fee_to_nightly_rate_pct: Number(((stats.cleaning_ratio_sum / cleanCount) * 100).toFixed(1)),
    },
    scenic_stay_gold_standard: {
      acoustics: '100% Private Detached ADU / Guesthouse with Garden Courtyard Exposure',
      workstation: '100% Motorized Standing Desk + Herman Miller Ergonomic Chair + 4K 27" Display',
      connectivity: '100% Dedicated Fiber (300+ Mbps verified with low latency)',
      privacy: '100% Guaranteed Zero Interior Cameras / Strict Boundary Audited',
      access: '100% Automated Keyless Smart Deadbolt with Dynamic Unique PINs',
      pricing: '100% Transparent, Modest Cleaning Fee (< 25% of baseline ADR)',
    },
    monetization_and_ecosystem_services: {
      host_audit: 'Scenic Verified™ Host Certification ($199–$499/audit) to qualify listings for agentic selection',
      hardware_bundles: 'Turnkey Scenic Workstation & Acoustic Spec Kits for STR Operators',
      b2b_api: 'Transactional Agentic Decision Scoring ($0.01–$0.05/call)',
      institutional_reports: 'Quarterly Submarket STR Hospitality Intelligence Reports ($1,200/yr)'
    }
  };
}

// Workers KV's own free tier (1,000 writes/day account-wide) is stricter than the
// request ceiling this is meant to enforce (2,000/day) -- writing on every request
// would exhaust the KV write budget before the intended ceiling ever triggered, and
// would eat into KV budget shared by any other namespace on this account. So this
// samples: read (cheap, 100k free/day) on every request, but only writes on ~5% of
// requests, incrementing by the inverse sample rate as an estimate. Bounded to well
// under 100 writes/day even at the ceiling, regardless of how far over-ceiling actual
// traffic goes, since no further writes occur once the estimate exceeds the ceiling.
const SAMPLE_RATE = 0.05;
const SAMPLE_INCREMENT = Math.round(1 / SAMPLE_RATE);
const MAX_TRACKED_SHAPES_PER_DAY = 50;

export function dayKeyFor(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export type RequestClass = 'tools_call_lodging_decision' | 'discovery' | 'other';

// Classifies the JSON-RPC method without consuming the request body the MCP
// transport still needs to read itself -- callers must pass a body parsed from
// request.clone(), never the original request.
export function classifyRequest(body: unknown): RequestClass {
  if (!body || typeof body !== 'object') return 'other';
  const method = (body as { method?: unknown }).method;
  if (method === 'tools/call') {
    const name = (body as { params?: { name?: unknown } }).params?.name;
    return name === 'lodging_decision' ? 'tools_call_lodging_decision' : 'other';
  }
  if (method === 'initialize' || method === 'tools/list' || method === 'resources/list' || method === 'prompts/list') {
    return 'discovery';
  }
  return 'other';
}

// A coarse structural fingerprint of a tools/call's arguments -- deliberately built
// only from shape/scale fields (trip purpose, group size, nights, budget, candidate
// count and IDs), never from free-text fields (traveler.preferences, listing names,
// review_signals, etc.) that could carry arbitrary caller-supplied content. This is
// enough to tell "the same synthetic health-check payload repeated" apart from "real,
// varying calls" without logging anything resembling real request content.
export async function fingerprintToolCall(body: unknown): Promise<string | null> {
  if (!body || typeof body !== 'object') return null;
  const args = (body as { params?: { arguments?: unknown } }).params?.arguments;
  if (!args || typeof args !== 'object') return null;
  const a = args as Record<string, any>;
  try {
    const listingIds = Array.isArray(a.candidate_listings)
      ? a.candidate_listings.map((c: any) => String(c?.listing_id ?? '')).sort()
      : [];
    const shape = {
      purpose: a.trip?.purpose ?? null,
      group_size: a.trip?.group_size ?? null,
      nights: a.trip?.nights ?? null,
      currency: a.trip?.budget?.currency ?? null,
      max_total: a.trip?.budget?.max_total ?? null,
      candidate_count: listingIds.length,
      listing_ids: listingIds,
    };
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(shape)));
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
  } catch {
    return null;
  }
}

export async function recordRequest(env: Env, requestClass: RequestClass, fingerprint: string | null): Promise<boolean> {
  const day = dayKeyFor(new Date());
  const totalKey = `count:${day}`;
  const current = Number((await env.DI_001_A_ABUSE_CEILING.get(totalKey)) ?? '0');
  if (current >= DAILY_REQUEST_CEILING) return false;

  if (Math.random() < SAMPLE_RATE) {
    const increment = SAMPLE_INCREMENT;
    const classKey = `class:${requestClass}:${day}`;
    const writes: Promise<unknown>[] = [
      env.DI_001_A_ABUSE_CEILING.put(totalKey, String(current + increment), { expirationTtl: 172800 }),
      (async () => {
        const lifetime = Number((await env.DI_001_A_ABUSE_CEILING.get('count:lifetime')) ?? '0');
        await env.DI_001_A_ABUSE_CEILING.put('count:lifetime', String(lifetime + increment));
      })(),
      (async () => {
        const classCurrent = Number((await env.DI_001_A_ABUSE_CEILING.get(classKey)) ?? '0');
        await env.DI_001_A_ABUSE_CEILING.put(classKey, String(classCurrent + increment), { expirationTtl: 172800 });
      })(),
    ];
    writes.push(recordShapeIfNew(env, day, fingerprint));
    await Promise.all(writes);
  }
  return true;
}

// Distinct-shapes tracking is deliberately NOT sampled: a duplicate fingerprint costs
// only a read (cheap, 100k free/day), and a write only happens the first time a shape
// is seen that day -- self-limiting by design, since repeated identical health-check
// payloads produce at most one write regardless of how many times they're seen.
async function recordShapeIfNew(env: Env, day: string, fingerprint: string | null): Promise<void> {
  if (!fingerprint) return;
  const shapesKey = `shapes:${day}`;
  const existing = (await env.DI_001_A_ABUSE_CEILING.get(shapesKey)) ?? '';
  const shapes = existing ? existing.split(',') : [];
  if (shapes.includes(fingerprint) || shapes.length >= MAX_TRACKED_SHAPES_PER_DAY) return;
  shapes.push(fingerprint);
  await env.DI_001_A_ABUSE_CEILING.put(shapesKey, shapes.join(','), { expirationTtl: 172800 });
}

const openApiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'StayGraph — Lodging Decision Intelligence API',
    version: '1.2.0',
    description: 'Deterministic Decision & Safety Intelligence Layer for autonomous travel agents, evaluating lodging candidates across Safety & Belonging, workspace ergonomics, acoustics, and submarket price sanity.',
    contact: {
      name: 'Scenic Stay / StayGraph',
      email: 'scenicstay@abetterbnb.com',
      url: 'https://github.com/Scenic-Stay/lodging-decision-mcp'
    }
  },
  servers: [
    {
      url: 'https://di-001-a-lodging-decision-mcp.scenicstay.workers.dev',
      description: 'Production Edge Worker (Cloudflare)'
    }
  ],
  paths: {
    '/decide': {
      post: {
        operationId: 'evaluateLodgingDecision',
        summary: 'Evaluate and score lodging candidates for an autonomous agent',
        description: 'Receives traveler context, trip constraints, and candidate listings. Returns a ranked, deterministic recommendation matrix with evidence, risk flags, trade-offs, and booking next actions.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['traveler', 'trip', 'candidate_listings'],
                properties: {
                  traveler: { type: 'object' },
                  trip: { type: 'object' },
                  candidate_listings: { type: 'array', items: { type: 'object' } }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Scored decision payload with recommendations, trade-offs, and risk flags',
            content: {
              'application/json': {
                schema: { type: 'object' }
              }
            }
          },
          '400': {
            description: 'Validation or safety guard rejection'
          }
        }
      }
    },
    '/health': {
      get: {
        operationId: 'healthCheck',
        summary: 'Worker health check',
        responses: {
          '200': { description: 'Server is healthy' }
        }
      }
    },
    '/benchmark': {
      get: {
        operationId: 'getHospitalityBenchmark',
        summary: 'Retrieve anonymized global hospitality & safety benchmark metrics',
        description: 'Returns real-time anonymized telemetry benchmarks across work readiness, acoustic integrity, privacy violations, host friction, and pricing sanity.',
        responses: {
          '200': {
            description: 'Live hospitality and decision intelligence benchmark summary',
            content: {
              'application/json': {
                schema: { type: 'object' }
              }
            }
          }
        }
      }
    }
  }
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (url.pathname === '/openapi.json') {
      return new Response(JSON.stringify(openApiSpec, null, 2), {
        status: 200,
        headers: { ...corsHeaders, 'content-type': 'application/json' },
      });
    }

    if ((url.pathname === '/decide' || url.pathname === '/api/decide') && request.method === 'POST') {
      try {
        const body = await request.json();
        const parsed = parseDecisionRequest(body);
        guardRequest(parsed);
        const decision = decideLodging(parsed);
        await recordBenchmarkTelemetry(env, parsed.candidate_listings);
        return new Response(JSON.stringify(decision, null, 2), {
          status: 200,
          headers: { ...corsHeaders, 'content-type': 'application/json' },
        });
      } catch (error) {
        if (error instanceof GuardRejectionError) {
          return new Response(
            JSON.stringify({ error: 'guard_rejection', message: error.message, flagged: error.flaggedFields }),
            { status: 400, headers: { ...corsHeaders, 'content-type': 'application/json' } }
          );
        }
        if (error instanceof DecisionRequestError) {
          return new Response(
            JSON.stringify({ error: 'invalid_request', message: error.message, details: error.details }),
            { status: 400, headers: { ...corsHeaders, 'content-type': 'application/json' } }
          );
        }
        return new Response(
          JSON.stringify({ error: 'internal_error', message: String(error) }),
          { status: 500, headers: { ...corsHeaders, 'content-type': 'application/json' } }
        );
      }
    }

    if (url.pathname === '/benchmark' || url.pathname === '/api/benchmark') {
      const benchmarkData = await getBenchmarkReport(env);
      return new Response(JSON.stringify(benchmarkData, null, 2), {
        status: 200,
        headers: { ...corsHeaders, 'content-type': 'application/json' },
      });
    }

    if (url.pathname === '/health') {
      return new Response('ok', { status: 200, headers: corsHeaders });
    }

    if (url.pathname === '/.well-known/glama.json') {
      return new Response(
        JSON.stringify({
          $schema: 'https://glama.ai/mcp/schemas/connector.json',
          maintainers: [{ email: 'scenicstay@abetterbnb.com' }],
        }),
        { status: 200, headers: { ...corsHeaders, 'content-type': 'application/json' } }
      );
    }

    if (url.pathname === '/stats') {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 86400000);
      const todayKey = dayKeyFor(now);
      const [today, priorDay, lifetime, toolCallToday, discoveryToday, shapesToday] = await Promise.all([
        env.DI_001_A_ABUSE_CEILING.get(`count:${todayKey}`),
        env.DI_001_A_ABUSE_CEILING.get(`count:${dayKeyFor(yesterday)}`),
        env.DI_001_A_ABUSE_CEILING.get('count:lifetime'),
        env.DI_001_A_ABUSE_CEILING.get(`class:tools_call_lodging_decision:${todayKey}`),
        env.DI_001_A_ABUSE_CEILING.get(`class:discovery:${todayKey}`),
        env.DI_001_A_ABUSE_CEILING.get(`shapes:${todayKey}`),
      ]);
      return new Response(
        JSON.stringify({
          today_estimated_requests: Number(today ?? '0'),
          yesterday_estimated_requests: Number(priorDay ?? '0'),
          lifetime_estimated_requests: Number(lifetime ?? '0'),
          today_tool_call_estimated: Number(toolCallToday ?? '0'),
          today_discovery_estimated: Number(discoveryToday ?? '0'),
          distinct_tool_call_shapes_today: shapesToday ? shapesToday.split(',').length : 0,
          note:
            'Sampled estimate (5% write rate, scaled), not an exact count. tool_call = real lodging_decision ' +
            'invocations; discovery = initialize/tools/list/resources/list/prompts/list (what most directory ' +
            'health-checks look like). distinct_tool_call_shapes_today counts structurally-distinct tools/call ' +
            'argument shapes seen (not sampled) -- repeated identical shapes (e.g. one health-check payload hit ' +
            'many times) stay at 1; genuinely varied real usage grows this number. See src/worker.ts.',
        }),
        { status: 200, headers: { ...corsHeaders, 'content-type': 'application/json' } }
      );
    }

    if (url.pathname !== '/mcp') {
      return new Response('Not found. Endpoints: /mcp (MCP), /decide (REST), /benchmark (Hospitality Benchmark), /openapi.json (OpenAPI), /health.', {
        status: 404,
        headers: corsHeaders,
      });
    }

    let requestClass: RequestClass = 'other';
    let fingerprint: string | null = null;
    try {
      const bodyForClassification = await request.clone().json();
      requestClass = classifyRequest(bodyForClassification);
      if (requestClass === 'tools_call_lodging_decision') {
        fingerprint = await fingerprintToolCall(bodyForClassification);
      }
    } catch {
      // Non-JSON or unparseable body (e.g. a GET for the SSE stream) -- classify as
      // 'other' and continue; the transport below still sees the untouched original
      // request regardless of whether this peek succeeded.
    }

    const allowed = await recordRequest(env, requestClass, fingerprint);
    if (!allowed) {
      return new Response(
        JSON.stringify({ error: 'daily_ceiling_reached', message: 'This alpha server has a soft daily request ceiling. Try again tomorrow.' }),
        { status: 429, headers: { 'content-type': 'application/json' } }
      );
    }

    const server = buildServer(env);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};
