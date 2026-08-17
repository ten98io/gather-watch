import { describe, expect, it } from 'vitest';
import { canAct, formatMs } from '@/lib/permissions';

describe('canAct', () => {
  it('ranks host > moderator > member > guest against policy levels', () => {
    expect(canAct('everyone', 'guest')).toBe(true);
    expect(canAct('everyone', 'host')).toBe(true);
    expect(canAct('mods', 'member')).toBe(false);
    expect(canAct('mods', 'moderator')).toBe(true);
    expect(canAct('mods', 'host')).toBe(true);
    expect(canAct('host', 'moderator')).toBe(false);
    expect(canAct('host', 'host')).toBe(true);
  });
});

describe('formatMs', () => {
  it('formats m:ss', () => {
    expect(formatMs(0)).toBe('0:00');
    expect(formatMs(61_500)).toBe('1:02');
    expect(formatMs(-5)).toBe('0:00');
  });
});
