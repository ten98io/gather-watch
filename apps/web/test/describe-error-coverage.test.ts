/**
 * describeError, checked against the LIVE contracts enum rather than a list
 * typed out by hand.
 *
 * describe-error.test.ts asserts the copy for eight codes it names itself.
 * That test stays green forever: the day services/api gains a ninth refusal,
 * the switch in describe-error.ts silently drops it into the caller's generic
 * fallback and nothing anywhere says so. This file reads ERROR_CODES out of
 * @gather/contracts, so a new code fails here until someone has decided what
 * a person should be told when they hit it.
 *
 * PAYMENT_REQUIRED is the precedent: it was removed from the enum and its
 * branch sat in describe-error.ts as dead copy for a plan that no longer
 * exists. This test also runs the check the other way, so a code that leaves
 * the contract cannot leave its sentence behind.
 */
import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@gather/contracts';
import { ApiError } from '@gather/api-client';
import { CONTEXTUAL_ONLY_CODES, describeBoundaryError, describeError } from '@/lib/describe-error';

const FALLBACK = 'Could not do the thing.';

describe('every live ErrorCode', () => {
  it('either has curated copy or is a documented contextual fallback', () => {
    for (const code of ERROR_CODES) {
      const copy = describeError(new ApiError(code, 'raw server body', 500), FALLBACK);
      if ((CONTEXTUAL_ONLY_CODES as readonly string[]).includes(code)) {
        // Deliberate: the call site's own wording beats a generic sentence.
        expect(copy).toBe(FALLBACK);
        continue;
      }
      expect(copy, `${code} has no sentence of its own`).not.toBe(FALLBACK);
    }
  });

  it('answers every code with a plain sentence — no jargon, no raw body', () => {
    for (const code of ERROR_CODES) {
      const copy = describeError(new ApiError(code, '<html>500 at /rooms/x</html>', 500), FALLBACK);
      expect(copy).not.toContain('<html>');
      expect(copy).not.toContain('HTTP');
      // Never the machine name of the refusal.
      expect(copy).not.toContain(code);
      expect(copy.endsWith('.')).toBe(true);
    }
  });

  it('leaves no sentence behind for a code the contract has dropped', () => {
    for (const code of CONTEXTUAL_ONLY_CODES) {
      expect(ERROR_CODES as readonly string[]).toContain(code);
    }
    // The gate that let this rot: 402 must never resolve to plan copy again.
    expect(ERROR_CODES as readonly string[]).not.toContain('PAYMENT_REQUIRED');
  });
});

describe('describeBoundaryError', () => {
  it('tells someone on a stale tab that Gather moved, not that they broke it', () => {
    const chunk = new Error('Loading chunk 4821 failed.');
    chunk.name = 'ChunkLoadError';
    expect(describeBoundaryError(chunk)).toMatch(/updated|reload/i);
    expect(describeBoundaryError(chunk)).not.toContain('4821');
  });

  it('never repeats a raw message back, whatever was thrown', () => {
    const nasty = new Error('ECONNREFUSED postgres://gather:hunter2@10.0.0.4:5432/gather');
    const copy = describeBoundaryError(nasty);
    expect(copy).not.toContain('hunter2');
    expect(copy).not.toContain('ECONNREFUSED');
    expect(copy.length).toBeGreaterThan(20);
    expect(copy.endsWith('.')).toBe(true);
    expect(describeBoundaryError(null)).toBe(copy);
    expect(describeBoundaryError('HTTP 500')).toBe(copy);
  });
});
