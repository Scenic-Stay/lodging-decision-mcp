# Lodging Decision MCP Server (alpha)

Narrow, agent-facing MCP server wrapping PR #25's (`Scenic-Stay/staygraph`, branch
`agent/scenicgraph-lodging-decision-api`) lodging-decision kernel unmodified. Governed by
[`gauntlet/projects/decision-intelligence-v0.1/WORK-ORDERS.yaml`](https://github.com/Scenic-Stay/scenic-intelligence/blob/brain/v1.1-rc1-bootstrap/gauntlet/projects/decision-intelligence-v0.1/WORK-ORDERS.yaml)
(`DI-001-A`) in `Scenic-Stay/scenic-intelligence`. Read that Work Order before changing scope.

Live: `https://di-001-a-lodging-decision-mcp.scenicstay.workers.dev/mcp`

Extracted from `Scenic-Stay/staygraph` (`services/di-001-a-mcp-decision-server/`, branch
`agent/di-001-a-mcp-decision-server`, commits `8c8f4c7`/`f7df7b3`) into its own public repo so
GitHub-based MCP discovery (the Official MCP Registry, Glama's crawler) can find it without
exposing the rest of `staygraph`'s code. That branch is preserved as historical record; deploy
from this repo going forward.

## What this is

One MCP tool, `lodging_decision`. Callers supply a traveler profile, trip context, and
a list of candidate listings; the tool returns a deterministic, evidence-backed
recommendation with score breakdown, tradeoffs, risk flags, missing information, and
confidence. It does not search inventory, book, transact, or persist anything.

## Scope

Non-sensitive categories only: budget, location, amenities, quality/reviews,
cancellation policy, fees, remote-work/family/business/relocation/event trip framing,
and stated accessibility needs. No Safety & Belonging, Medical Recovery, or
protected-characteristic-adjacent input is accepted — see `src/guard.ts`, a
defense-in-depth denylist that rejects (does not silently strip) free-text fields
referencing a protected characteristic or discriminatory steering criterion, on top of
the fact that the underlying kernel has no such fields to begin with.

## Structure

- `src/kernel/` — PR #25's contracts, scorer, validation, and fixtures, copied
  byte-for-byte (`test/kernel-parity.test.ts` proves this against PR #25's own six
  tests and committed example fixtures).
- `src/guard.ts` — the denylist guard described above.
- `src/worker.ts` — Cloudflare Worker entrypoint: MCP `WebStandardStreamableHTTPServerTransport`
  at `POST /mcp`, plus a KV-backed soft daily request ceiling and a `/health` check.
- `test/` — kernel parity tests, guard tests.

## Local development

```bash
npm install
npm test        # kernel parity + guard tests
npm run typecheck
npm run dev      # wrangler dev, serves http://127.0.0.1:8787/mcp
```

## Deploy

```bash
npm run deploy   # wrangler deploy
```

Requires the `DI_001_A_ABUSE_CEILING` KV namespace bound in `wrangler.jsonc` (already
provisioned; see the Work Order's execution_result for the namespace ID and actual
Cloudflare cost recorded at deploy time).

## Known limitations (carried over from PR #25, unresolved here)

Unauthenticated, unversioned, no rate limiting beyond the soft daily ceiling, not
calibrated against real human booking decisions. Do not expose to untrusted
high-volume traffic without a further hardening decision — see the Work Order's
circuit breakers for the manual kill-switch (pull the Worker; delist from all
directories) if abuse signals appear.
