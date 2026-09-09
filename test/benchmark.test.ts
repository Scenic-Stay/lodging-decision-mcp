import assert from 'node:assert/strict';
import test from 'node:test';
import { recordBenchmarkTelemetry, getBenchmarkReport, type Env } from '../src/worker';

function makeMockKv(): { env: Env; store: Map<string, string> } {
  const store = new Map<string, string>();
  const kv = {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
  };
  return { env: { DI_001_A_ABUSE_CEILING: kv as any }, store };
}

test('getBenchmarkReport returns structured hospitality and decision metrics', async () => {
  const { env } = makeMockKv();
  const report = await getBenchmarkReport(env);

  assert.ok(report.report_title);
  assert.ok(report.summary);
  assert.ok(report.scenic_stay_gold_standard);
  assert.ok(report.monetization_and_ecosystem_services);

  const summary = report.summary as Record<string, number>;
  assert.equal(typeof summary.standing_desk_availability_pct, 'number');
  assert.equal(typeof summary.surveillance_boundary_violation_rate_pct, 'number');
  assert.equal(typeof summary.avg_cleaning_fee_to_nightly_rate_pct, 'number');
});

test('recordBenchmarkTelemetry handles empty and invalid candidate batches gracefully', async () => {
  const { env } = makeMockKv();
  await assert.doesNotReject(async () => {
    await recordBenchmarkTelemetry(env, []);
    await recordBenchmarkTelemetry(env, null as any);
  });
});
