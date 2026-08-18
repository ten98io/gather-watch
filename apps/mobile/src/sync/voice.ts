/**
 * The room's live-voice signal as a zustand selector, for the mobile Stage.
 *
 * E17 / docs/EXTENSION_FIRST.md Part 1, "Consequence B": while people are on
 * mic the elastic band has to tighten, or a spoken reaction lands seconds away
 * from the thing it is about. `DriftController.setVoiceActive` has always
 * implemented that; mobile never told it anything.
 *
 * PRESENCE, NOT SPEECH. The band's ramps are two seconds in and eight out, so
 * the signal that drives it has to be the slow one — who has a microphone
 * open — and never a measured "is sound happening right now". @gather/sync-core's
 * voiceActiveFrom carries the full argument. (The web additionally ducks the
 * content on the fast signal; mobile has no voice-activity measurement to duck
 * from yet, so it wires the band only — see apps/web/lib/player/ducking.ts.)
 *
 * A selector rather than an inline lambda so `useStore` gets a stable
 * reference, and so the decision is testable in a package whose vitest has no
 * renderer.
 */
import type { PresenceEntry, UserId } from '@gather/contracts';
import { voiceActiveFrom } from '@gather/sync-core';

/** Somebody in this room has an open mic (and there is somebody to hear it). */
export function roomVoiceActive(state: { presence: Record<UserId, PresenceEntry> }): boolean {
  return voiceActiveFrom(Object.values(state.presence));
}
