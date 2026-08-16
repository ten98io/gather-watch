/**
 * Content script: finds the page's main media element and keeps it glued to
 * the room while this tab is the "driven" tab. All decisions come from
 * mediaDriver (pure); this file is DOM plumbing only.
 *
 * Protocol with the background worker:
 *   ← { kind: 'drive', playing, positionMs, rate }   apply room state
 *   ← { kind: 'driveOff' }                            release the element
 *   → { kind: 'telemetry', positionMs, durationMs, playing, rate }
 *   → { kind: 'provider', provider }                  (on load)
 */
import { applyDecision, decideDrive, pickMainMedia, readTelemetry } from './mediaDriver';
import type { MediaElementLike } from './mediaDriver';
import { providerForUrl } from './providers';

let driven = false;
let lastCommand: { playing: boolean; positionMs: number; rate: number } | null = null;

function findMainMedia(): HTMLMediaElement | null {
  const candidates = [...document.querySelectorAll('video, audio')]
    .map((el) => {
      const rect = el.getBoundingClientRect();
      return { el: el as HTMLMediaElement, area: rect.width * rect.height };
    })
    .filter((c) => c.area > 0);
  return pickMainMedia(candidates)?.el ?? null;
}

function drive(): void {
  if (!driven || lastCommand === null) return;
  const el = findMainMedia();
  if (el === null) return;
  const telemetry = readTelemetry(el as MediaElementLike);
  const decision = decideDrive(telemetry, lastCommand.positionMs, {
    playing: lastCommand.playing,
    rate: lastCommand.rate,
  });
  applyDecision(el as MediaElementLike, decision);
}

chrome.runtime.onMessage.addListener((msg: { kind?: string } & Record<string, unknown>) => {
  if (msg.kind === 'drive') {
    driven = true;
    lastCommand = {
      playing: msg.playing === true,
      positionMs: typeof msg.positionMs === 'number' ? msg.positionMs : 0,
      rate: typeof msg.rate === 'number' ? msg.rate : 1,
    };
    drive();
  } else if (msg.kind === 'driveOff') {
    driven = false;
    lastCommand = null;
  }
});

// Telemetry upstream (1 Hz) — the popup shows it; the room doesn't consume it
// (the room's own player is authoritative; this tab is a follower).
setInterval(() => {
  const el = findMainMedia();
  if (el === null) return;
  const t = readTelemetry(el as MediaElementLike);
  void chrome.runtime.sendMessage({ kind: 'telemetry', ...t }).catch(() => undefined);
}, 1000);

void chrome.runtime
  .sendMessage({ kind: 'provider', provider: providerForUrl(location.href) })
  .catch(() => undefined);
