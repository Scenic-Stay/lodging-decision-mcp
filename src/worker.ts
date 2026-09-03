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

SCOPE (alpha, non-sensitive categories only): budget, location, amenities, quality/reviews, cancellation
policy, fees, remote-work and family and business/relocation/event trip framing, and stated accessibility
needs. This tool does NOT accept, infer, or act on race, color, national origin, religion, sex, gender
identity, sexual orientation, familial status, or any other protected characteristic or Safety & Belonging
signal -- requests containing such content in free-text fields are rejected, not silently filtered.

This tool does not search inventory (you must supply candidate_listings), does not book or transact, and
does not persist any data. It is unauthenticated, unversioned, alpha-quality: recommendations are
deterministic given identical input but are not calibrated against real human booking outcomes. Always
re-verify availability, price, and policy before booking.`;

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
});

const lodgingDecisionInputShape = {
  traveler: z.object(travelerShape),
  trip: z.object(tripShape),
  candidate_listings: z.array(candidateShape).min(1).max(50),
};

function buildServer(): McpServer {
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response('ok', { status: 200 });
    }

    if (url.pathname === '/.well-known/glama.json') {
      return new Response(
        JSON.stringify({
          $schema: 'https://glama.ai/mcp/schemas/connector.json',
          maintainers: [{ email: 'scenicstay@abetterbnb.com' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
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
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (url.pathname !== '/mcp') {
      return new Response('Not found. MCP endpoint is /mcp.', { status: 404 });
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

    const server = buildServer();
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};
