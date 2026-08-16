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

async function withinDailyCeiling(env: Env): Promise<boolean> {
  const dayKey = `count:${new Date().toISOString().slice(0, 10)}`;
  const current = Number((await env.DI_001_A_ABUSE_CEILING.get(dayKey)) ?? '0');
  if (current >= DAILY_REQUEST_CEILING) return false;
  if (Math.random() < SAMPLE_RATE) {
    await env.DI_001_A_ABUSE_CEILING.put(dayKey, String(current + SAMPLE_INCREMENT), { expirationTtl: 172800 });
  }
  return true;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response('ok', { status: 200 });
    }

    if (url.pathname !== '/mcp') {
      return new Response('Not found. MCP endpoint is /mcp.', { status: 404 });
    }

    const allowed = await withinDailyCeiling(env);
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
