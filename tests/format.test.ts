import { describe, expect, it } from 'vitest';
import { formatDuration } from '../src/lib/format';

describe('formatDuration', () => {
  it('returns a dash for a missing value', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(undefined)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
  });

  it('keeps sub-millisecond precision', () => {
    expect(formatDuration(0.25)).toBe('250 µs');
  });

  it('keeps milliseconds readable', () => {
    expect(formatDuration(4.25)).toBe('4.3 ms');
    expect(formatDuration(250)).toBe('250 ms');
  });

  it('switches to seconds past a second', () => {
    expect(formatDuration(1500)).toBe('1.50 s');
  });

  it('switches to minutes past a minute', () => {
    expect(formatDuration(125_000)).toBe('2m 5s');
  });

  it('switches to hours past an hour instead of counting minutes', () => {
    // 2h 3m 4s used to print as "123m 4s".
    expect(formatDuration((2 * 3600 + 3 * 60 + 4) * 1000)).toBe('2h 3m');
  });

  it('switches to days past a day', () => {
    // An uptime of 34h 32m used to print as "2072m 41s".
    expect(formatDuration((34 * 3600 + 32 * 60 + 41) * 1000)).toBe('1d 11h');
  });

  it('never carries a rounded unit into the next one', () => {
    // 59m 59.6s rounds up to 60 minutes, which must stay "60m 0s".
    expect(formatDuration(3_599_600)).toBe('60m 0s');
    // 23h 59m 40s rounds up to 24 hours, which must stay "24h 0m".
    expect(formatDuration(86_380_000)).toBe('24h 0m');
  });
});
