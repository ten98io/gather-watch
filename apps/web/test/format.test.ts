import { describe, expect, it } from 'vitest';
import { formatBytes, formatDurationMs, formatTimestamp, initials, pluralize } from '@/lib/format';

describe('formatDurationMs', () => {
  it('formats minutes and seconds', () => {
    expect(formatDurationMs(372_000)).toBe('6:12');
    expect(formatDurationMs(0)).toBe('0:00');
    expect(formatDurationMs(59_999)).toBe('0:59');
  });

  it('formats hours', () => {
    expect(formatDurationMs(3_723_000)).toBe('1:02:03');
  });

  it('guards invalid input', () => {
    expect(formatDurationMs(Number.NaN)).toBe('0:00');
    expect(formatDurationMs(-5)).toBe('0:00');
    expect(formatDurationMs(Number.POSITIVE_INFINITY)).toBe('0:00');
  });
});

describe('formatBytes', () => {
  it('picks sensible units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(10 * 1024 ** 3)).toBe('10 GB');
  });

  it('guards invalid input', () => {
    expect(formatBytes(-1)).toBe('0 B');
  });
});

describe('formatTimestamp', () => {
  it('shows time today', () => {
    const now = new Date('2026-08-15T20:00:00').getTime();
    const ts = new Date('2026-08-15T14:05:00').getTime();
    expect(formatTimestamp(ts, now)).toBe('14:05');
  });

  it('shows weekday within the last week', () => {
    const now = new Date('2026-08-15T20:00:00').getTime();
    const ts = new Date('2026-08-13T14:05:00').getTime();
    expect(formatTimestamp(ts, now)).toBe('Thu 14:05');
  });
});

describe('initials', () => {
  it('derives initials from names', () => {
    expect(initials('Ari Kim')).toBe('AK');
    expect(initials('zed')).toBe('Z');
    expect(initials('  ')).toBe('?');
    expect(initials('anna maria lee')).toBe('AL');
  });
});

describe('pluralize', () => {
  it('pluralizes', () => {
    expect(pluralize(1, 'message')).toBe('1 message');
    expect(pluralize(4, 'message')).toBe('4 messages');
    expect(pluralize(2, 'person', 'people')).toBe('2 people');
  });
});
