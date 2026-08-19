/**
 * A SILENT SHARE HAS TO SAY SO.
 *
 * `getDisplayMedia({ audio: true })` is a request, and a browser answers "no"
 * by handing back a stream with no audio track — no error, no warning. Chrome
 * only offers the sound tick box for a TAB capture: a window has no audio to
 * give anywhere, and a whole screen only where the OS has system-audio capture
 * (never on macOS). So the person who picks their screen to show everyone a
 * video gets a share nobody can hear, and used to be told nothing at all.
 *
 * The extension has answered this honestly since it shipped (apps/extension/src
 * offscreen.ts `SILENT_NOTE` — count the tracks you actually received, then say
 * one plain sentence). This is the same answer for the web path, and it can be
 * more specific, because the capture names the surface the user picked.
 */
import { describe, expect, it } from 'vitest';
import type { CapturedShare } from '@/lib/player/share-audio';
import { shareAudioNote, shareSurfaceOf } from '@/lib/player/share-audio';

/** The two facts this decision is made of: what came back, and from where. */
function capture(opts: { audio: boolean; surface?: string }): CapturedShare {
  const settings = opts.surface === undefined ? {} : { displaySurface: opts.surface };
  return {
    getAudioTracks: () => (opts.audio ? [{}] : []),
    getVideoTracks: () => [{ getSettings: () => settings }],
  };
}

describe('shareSurfaceOf', () => {
  it('speaks the room’s words for the spec’s', () => {
    expect(shareSurfaceOf(capture({ audio: true, surface: 'browser' }))).toBe('tab');
    expect(shareSurfaceOf(capture({ audio: true, surface: 'window' }))).toBe('window');
    expect(shareSurfaceOf(capture({ audio: true, surface: 'monitor' }))).toBe('screen');
  });

  /** Not every browser reports it, and a capture with no video track cannot be
   *  asked. Both are 'unknown' — a real answer, not a guess at 'tab'. */
  it('does not guess when nothing says', () => {
    expect(shareSurfaceOf(capture({ audio: true }))).toBe('unknown');
    expect(
      shareSurfaceOf({ getAudioTracks: () => [], getVideoTracks: () => [] }),
    ).toBe('unknown');
    expect(shareSurfaceOf({ getAudioTracks: () => [], getVideoTracks: () => [{}] })).toBe(
      'unknown',
    );
  });
});

describe('shareAudioNote', () => {
  it('says nothing when the share has sound', () => {
    expect(shareAudioNote(capture({ audio: true, surface: 'browser' }))).toBeNull();
    expect(shareAudioNote(capture({ audio: true, surface: 'monitor' }))).toBeNull();
  });

  /** The case the whole file is about: a whole screen, picked to show a video,
   *  with nothing to hear. */
  it('tells a screen sharer their share is silent, and what to do instead', () => {
    const note = shareAudioNote(capture({ audio: false, surface: 'monitor' }));
    expect(note).not.toBeNull();
    expect(note).toContain('without sound');
    // The only thing they can act on: pick the tab next time.
    expect(note).toContain('tab');
  });

  it('says it for a window too', () => {
    expect(shareAudioNote(capture({ audio: false, surface: 'window' }))).toContain(
      'without sound',
    );
  });

  /** A tab share CAN be silent — the sound tick box is the user's to untick —
   *  and the sentence for it does not tell them to share a tab. */
  it('does not tell a tab sharer to share a tab', () => {
    const note = shareAudioNote(capture({ audio: false, surface: 'browser' }));
    expect(note).toContain('this tab did not hand over its audio');
    expect(note).not.toContain('Share the tab instead');
  });

  it('still says something when the browser will not name the surface', () => {
    expect(shareAudioNote(capture({ audio: false }))).toContain('without sound');
  });

  /**
   * Nobody is left wondering whether the room can hear them EITHER: a silent
   * picture is the moment that fear arrives, and every sentence answers it.
   */
  it('always says the call itself is unaffected', () => {
    for (const surface of ['browser', 'window', 'monitor', undefined]) {
      const note = shareAudioNote(
        capture(surface === undefined ? { audio: false } : { audio: false, surface }),
      );
      expect(note).toContain('can still hear you on the call');
    }
  });

  /** No sentence names an API, a constraint, or a browser: none of the three is
   *  something the person reading it can do anything about. */
  it('says none of it in the language of the platform', () => {
    for (const surface of ['browser', 'window', 'monitor']) {
      const note = shareAudioNote(capture({ audio: false, surface })) ?? '';
      expect(/getDisplayMedia|MediaStream|track|Chrome|constraint/i.test(note)).toBe(false);
    }
  });
});
