import { describe, expect, it } from 'vitest';
import { ApiError } from '@gather/api-client';
import { describeError } from '@/lib/describe-error';
import { RELAY_LABEL, RELAY_SHORT_LABEL, ROLE_LABEL, UPLINK_LABEL } from '@/lib/labels';

const FALLBACK = 'Could not do the thing';

describe('describeError', () => {
  it('maps every ApiError code to friendly copy', () => {
    const cases: Array<[Parameters<typeof makeError>[0], string]> = [
      ['UNAUTHORIZED', 'Please sign in again.'],
      ['FORBIDDEN', 'You don’t have permission to do that here.'],
      ['ROOM_POLICY', 'You don’t have permission to do that here.'],
      ['NOT_FOUND', 'That no longer exists.'],
      ['RATE_LIMITED', 'You’re doing that too fast — give it a moment.'],
      ['VALIDATION', 'That didn’t look right — check it and try again.'],
      ['QUOTA_EXCEEDED', 'Storage limit reached.'],
      ['CONFLICT', 'That changed while you were editing — try again.'],
    ];
    for (const [code, copy] of cases) {
      expect(describeError(makeError(code), FALLBACK)).toBe(copy);
    }
  });

  it('never answers with a plan gate — nothing in Gather is paid for', () => {
    // 402 used to short-circuit to "This needs the Premium plan."; there are no
    // plans, so an unmapped status is just the caller's fallback.
    expect(describeError(new ApiError('INTERNAL', 'plan required', 402), FALLBACK)).toBe(FALLBACK);
    expect(describeError(new ApiError('FORBIDDEN', 'nope', 402), FALLBACK)).toBe(
      'You don’t have permission to do that here.',
    );
  });

  it('never leaks the raw HTTP body of an unmapped ApiError', () => {
    const err = new ApiError('INTERNAL', '<html>Internal Server Error at /rooms/x</html>', 500);
    expect(describeError(err, FALLBACK)).toBe(FALLBACK);
  });

  it('explains blocked browser permissions and falls back for everything else', () => {
    expect(describeError(new DOMException('Denied', 'NotAllowedError'), FALLBACK)).toBe(
      'Permission was blocked — check browser permissions.',
    );
    expect(describeError(new Error('upload ticket carried no part URL'), FALLBACK)).toBe(FALLBACK);
    expect(describeError('HTTP 500', FALLBACK)).toBe(FALLBACK);
    expect(describeError(null, FALLBACK)).toBe(FALLBACK);
  });
});

function makeError(code: ConstructorParameters<typeof ApiError>[0]): ApiError {
  return new ApiError(code, 'raw server body text', 500);
}

describe('enum display labels', () => {
  it('never renders a raw enum value', () => {
    const labels = [
      ...Object.values(ROLE_LABEL),
      ...Object.values(RELAY_LABEL),
      ...Object.values(RELAY_SHORT_LABEL),
      ...Object.values(UPLINK_LABEL),
    ];
    for (const label of labels) {
      expect(label[0]).toBe(label[0]?.toUpperCase());
      expect(label).not.toMatch(/cf-sfu|livekit|degraded|moderator/);
    }
  });

  it('keeps the relay badge wording the privacy policy quotes', () => {
    expect(RELAY_LABEL.mesh).toBe('Private · device-to-device');
  });

  it('tells a legacy cf-sfu room the truth: it meshes like everything else', () => {
    // Older rooms were flipped to 'cf-sfu' by the theater toggle, which no
    // longer touches transport. The client only ever joins the mesh, so the
    // badge must not claim a relay carries the media.
    expect(RELAY_LABEL['cf-sfu']).toBe(RELAY_LABEL.mesh);
    expect(RELAY_SHORT_LABEL['cf-sfu']).toBe(RELAY_SHORT_LABEL.mesh);
  });

  it('never offers a plan, a tier or an upgrade anywhere in the label copy', () => {
    const copy = [
      ...Object.values(ROLE_LABEL),
      ...Object.values(RELAY_LABEL),
      ...Object.values(RELAY_SHORT_LABEL),
      ...Object.values(UPLINK_LABEL),
      describeError(new ApiError('INTERNAL', 'plan required', 402), FALLBACK),
    ];
    for (const line of copy) {
      expect(line).not.toMatch(/premium|upgrade|billing|subscription|free plan/i);
    }
  });
});
