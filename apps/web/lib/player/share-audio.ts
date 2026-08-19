/**
 * DID THE SHARE BRING ITS SOUND — and if not, the sentence that says so.
 *
 * `getDisplayMedia({ audio: true })` is a REQUEST, never a promise, and the
 * browser answers it by simply handing back a stream with no audio track. So
 * the failure is silent in both senses: the room hears nothing, and nobody is
 * told. Chrome only offers the "share tab audio" tick box for a TAB capture —
 * a whole screen has system audio on Windows/ChromeOS at best and none at all
 * on macOS, and a window has none anywhere — so a person who picks their screen
 * and expects the video they are playing to be heard gets a silent share and no
 * explanation.
 *
 * The extension has answered this honestly since it shipped (apps/extension/src
 * offscreen.ts `SILENT_NOTE`, background.ts `readShareReply`): it counts the
 * audio tracks it actually received and says one plain sentence when there are
 * none. This is the same answer for the web path, and it can be MORE specific,
 * because the capture itself names the surface the user picked.
 *
 * WHY IT LIVES BESIDE THE PLAYER. The rule this enforces is the room's audio
 * rule — the one lib/player/ducking.ts and lib/player/room-audio.ts already
 * own: sound that the room should be hearing, or an honest sentence about why
 * it isn't. The component that calls `getDisplayMedia` (components/stage/
 * ScreenShareStage.tsx) states it, and nothing here touches the DOM or React so
 * it can be decided and tested on its own.
 */

/** One captured video track, read only for which surface it came from. */
interface CapturedSurfaceTrack {
  getSettings?: () => { displaySurface?: string };
}

/** A real `MediaStream` satisfies this; so does a plain test double. */
export interface CapturedShare {
  getAudioTracks(): readonly unknown[];
  getVideoTracks(): readonly CapturedSurfaceTrack[];
}

/** What the user picked in the browser's own picker. 'unknown' is a real
 *  answer: not every browser reports `displaySurface`, and a share that never
 *  produced a video track cannot be asked. */
export type ShareSurface = 'tab' | 'window' | 'screen' | 'unknown';

/**
 * Which surface this capture came from, from the video track the browser
 * handed back — the one witness to what the user actually chose, since the
 * picker is the browser's and reports nothing else.
 *
 * The spec's spelling is 'browser' | 'window' | 'monitor'; this file speaks the
 * room's, which is what a sentence to a person has to be written in.
 */
export function shareSurfaceOf(stream: CapturedShare): ShareSurface {
  const surface = stream.getVideoTracks()[0]?.getSettings?.().displaySurface;
  if (surface === 'browser') return 'tab';
  if (surface === 'window') return 'window';
  if (surface === 'monitor') return 'screen';
  return 'unknown';
}

/**
 * No sentence below names an API, a constraint or a browser: what a person can
 * act on is which surface to pick next time, so that is what each one says.
 * The reassurance is the extension's, word for word — the fear a silent share
 * creates is "can they hear me either?", and the answer is yes.
 */
const SILENT_NOTE: Record<ShareSurface, string> = {
  tab: 'Sharing video without sound — this tab did not hand over its audio. Everyone can still hear you on the call.',
  window:
    'Sharing video without sound — a window has no sound to give. Share the tab instead if the sound matters; everyone can still hear you on the call.',
  screen:
    'Sharing video without sound — a whole screen has no sound to give. Share the tab instead if the sound matters; everyone can still hear you on the call.',
  unknown:
    'Sharing video without sound — no audio came with the picture. Share a tab if the sound matters; everyone can still hear you on the call.',
};

/**
 * The one sentence a silent share owes the person sharing it, or null when the
 * share has sound and there is nothing to say.
 *
 * A TRACK IS THE TEST, not what was asked for. A browser can refuse the audio
 * outright, honour the request and return no track anyway, or hand over a track
 * the user unticked — and the first two are indistinguishable from here, which
 * is fine, because they are the same fact to whoever is watching: this share is
 * silent.
 */
export function shareAudioNote(stream: CapturedShare): string | null {
  if (stream.getAudioTracks().length > 0) return null;
  return SILENT_NOTE[shareSurfaceOf(stream)];
}
