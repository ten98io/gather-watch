/**
 * The two room-audio signals the content player has to answer to, published
 * out of the call surface and consumed by the player.
 *
 * WHY A MODULE-LEVEL BUS AND NOT CONTEXT. The call session and the content
 * player are siblings, mounted by the room shell on opposite sides of the
 * tree: <CallSessionProvider> owns the microphones, <StagePane> owns the
 * adapter. Threading either signal through React would mean re-rendering the
 * stage — the single most expensive subtree in the room, the one that owns an
 * iframe — twice a second because somebody is talking. This is the same
 * out-of-React registry shape lib/call-mesh.ts already uses for audio-sink
 * claims, for the same reason: a fact about media, not about markup.
 *
 * THE TWO SIGNALS ARE NOT THE SAME SIGNAL, and swapping them would make both
 * features worse:
 *
 *   • SPEECH (`speechActive`) — is a peer producing sound RIGHT NOW, measured
 *     off the live tracks by CallSurface's analyser at 150 ms. Fast, noisy,
 *     flips several times a sentence. It drives audio ducking, where being
 *     late is the whole failure: a duck that arrives after the word did not
 *     help anybody hear it.
 *   • VOICE (`voiceActive`) — does anybody in the room have a microphone open,
 *     read from PRESENCE. Slow: it changes when somebody joins or leaves a
 *     call. It drives the drift band (`DriftController.setVoiceActive`), whose
 *     ramps are measured in seconds — see @gather/sync-core's voiceActiveFrom
 *     for why feeding it the fast signal would be worse than not feeding it
 *     at all.
 *
 * Both default to false, and both are explicitly republished as false when the
 * call surface unmounts, so a room can never be left ducked or tightened by a
 * signal whose publisher is gone.
 */

type Listener = (active: boolean) => void;

interface Signal {
  active: boolean;
  listeners: Set<Listener>;
}

const speech: Signal = { active: false, listeners: new Set() };
const voice: Signal = { active: false, listeners: new Set() };

function publish(signal: Signal, active: boolean): void {
  if (signal.active === active) return;
  signal.active = active;
  // Copied: a subscriber that unsubscribes from its own callback (the ducking
  // hook does exactly that on teardown) must not skip the next listener.
  for (const listener of [...signal.listeners]) {
    listener(active);
  }
}

/**
 * Subscribes and IMMEDIATELY calls back with the current value, so a consumer
 * that mounts mid-conversation is not stuck on the default until the next
 * edge. Returns the unsubscribe.
 */
function subscribe(signal: Signal, listener: Listener): () => void {
  signal.listeners.add(listener);
  listener(signal.active);
  return () => {
    signal.listeners.delete(listener);
  };
}

/** A peer is producing sound right now (fast, measured). Drives ducking. */
export function publishSpeechActive(active: boolean): void {
  publish(speech, active);
}

export function getSpeechActive(): boolean {
  return speech.active;
}

export function subscribeSpeechActive(listener: Listener): () => void {
  return subscribe(speech, listener);
}

/** Somebody in the room has a mic open (slow, presence). Drives the band. */
export function publishVoiceActive(active: boolean): void {
  publish(voice, active);
}

export function getVoiceActive(): boolean {
  return voice.active;
}

export function subscribeVoiceActive(listener: Listener): () => void {
  return subscribe(voice, listener);
}

/** Test seam: drop both signals and every subscriber. */
export function resetRoomAudio(): void {
  speech.active = false;
  speech.listeners.clear();
  voice.active = false;
  voice.listeners.clear();
}
