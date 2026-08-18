/**
 * Live-voice detection from PRESENCE — the slow half of "someone is talking
 * while the content plays".
 *
 * docs/EXTENSION_FIRST.md Part 1, Consequence B: the call does NOT travel the
 * content's path. Voice is ~50–150 ms peer-to-peer while viewers may be eight
 * seconds apart in the content, so a live mic is the one spoiler vector that
 * media-anchored chat cannot close. When anybody is on mic the elastic band
 * tightens ({@link DriftController.setVoiceActive}).
 *
 * WHY THIS READS PRESENCE AND NOT SPEECH. There are two "someone is talking"
 * signals in the product and they are not interchangeable:
 *
 *   • PRESENCE mic state — who has their microphone open. It changes when a
 *     person joins or leaves a call, i.e. a few times an hour. This is the
 *     signal the drift band wants: retuning a controller with a two-second
 *     attack and an eight-second release every time somebody drew breath would
 *     leave the band permanently mid-ramp, converging on nothing. The tightened
 *     band exists so that a REPLY lands in the same second as the moment it is
 *     about — which is true for the whole time the mic is open, not only while
 *     air is moving.
 *   • Actual measured speech — the fast signal. It drives audio ducking, where
 *     responsiveness is the entire point. It must never reach this function.
 *
 * Note that the local user's OWN mic counts. If I am the only one talking, my
 * reactions still have to make sense to the people hearing them, so my playback
 * is the one that has to stay in step. What does NOT count is talking to
 * nobody: one member alone in a room has nothing to stay in step with.
 *
 * Structural on purpose: the web passes contracts' PresenceEntry, the mobile
 * app passes the same, and the extension passes its own leaner presence row.
 */

/** The two presence fields live-voice detection reads. */
export interface VoicePresenceLike {
  /** Presence state; 'offline' rows are ignored (they are tombstones). */
  state: string;
  /** Whether that member's microphone is open. */
  micOn?: boolean | undefined;
}

/**
 * Is live voice happening in this room right now?
 *
 * True when at least one non-offline member has their mic open AND there is
 * more than one non-offline member present.
 */
export function voiceActiveFrom(entries: Iterable<VoicePresenceLike>): boolean {
  let present = 0;
  let mics = 0;
  for (const entry of entries) {
    if (entry.state === 'offline') continue;
    present += 1;
    if (entry.micOn === true) mics += 1;
  }
  return mics > 0 && present > 1;
}
