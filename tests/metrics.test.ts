import { describe, expect, it } from 'vitest';
import { computeDeltaQps, computeMetrics } from '../server/db/metrics';

describe('delta-based QPS', () => {
  it('returns zero for the first sample', () => {
    expect(computeDeltaQps(null, { questions: 1_000, at: 10_000 })).toBe(0);
  });

  it('divides the question delta by the elapsed seconds', () => {
    expect(
      computeDeltaQps(
        { questions: 1_000, at: 10_000 },
        { questions: 1_250, at: 15_000 },
      ),
    ).toBe(50);
  });

  it('clamps a counter reset to zero', () => {
    expect(
      computeDeltaQps(
        { questions: 5_000, at: 10_000 },
        { questions: 10, at: 15_000 },
      ),
    ).toBe(0);
  });

  it('returns zero when the clock does not advance', () => {
    expect(
      computeDeltaQps(
        { questions: 1_000, at: 10_000 },
        { questions: 1_200, at: 10_000 },
      ),
    ).toBe(0);
  });

  it('returns zero when no questions were executed', () => {
    expect(
      computeDeltaQps(
        { questions: 1_000, at: 10_000 },
        { questions: 1_000, at: 15_000 },
      ),
    ).toBe(0);
  });
});

describe('computeMetrics QPS sampling', () => {
  it('tracks a previous sample per profile', () => {
    const status = { Uptime: '500', Questions: '5000', Threads_connected: '3' };

    const first = computeMetrics(status, 'profile-qps-a', 1_000);
    expect(first.qps).toBe(0);
    expect(first.queries).toBe(5000);

    const second = computeMetrics(
      { ...status, Questions: '6000' },
      'profile-qps-a',
      3_000,
    );
    expect(second.qps).toBe(500);

    // A different profile starts over at zero.
    const other = computeMetrics(status, 'profile-qps-b', 3_000);
    expect(other.qps).toBe(0);
  });

  it('keeps the snapshot shape and reports zero without a profile', () => {
    const metrics = computeMetrics({ Uptime: '100', Questions: '900' });
    expect(metrics.qps).toBe(0);
    expect(metrics.uptimeSeconds).toBe(100);
    expect(metrics).toHaveProperty('bufferPoolHitRatio');
  });
});
