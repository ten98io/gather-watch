/**
 * Popup: connect this tab to a room (guest identity), show live status, start
 * Mode B tab share, disconnect. Talks only to the background worker.
 */

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`#${id} missing`);
  return el as T;
};

import { castAffordanceFor } from './cast';
import type { TabProvider } from './providers';

interface Status {
  connected: boolean;
  roomName: string | null;
  playing: boolean;
  telemetry: { positionMs: number; durationMs: number; playing: boolean } | null;
  provider: TabProvider | null;
}

async function send<T>(msg: Record<string, unknown>): Promise<T> {
  const res = (await chrome.runtime.sendMessage(msg)) as
    | { ok: true; value: T }
    | { ok: false; error: string };
  if (!res.ok) throw new Error(res.error);
  return res.value;
}

function fmt(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

async function refresh(): Promise<void> {
  const status = await send<Status>({ kind: 'popup:status' });
  const dot = $('livedot');
  dot.className = `dot ${status.connected ? 'ok' : 'off'}`;
  $('status').textContent = status.connected
    ? `Connected to ${status.roomName ?? 'room'}${status.playing ? ' · playing' : ' · paused'}`
    : 'Not connected';
  $('provider').textContent = status.provider
    ? `This tab: ${status.provider.name}${status.provider.drm === true ? ' (protected — your own player)' : ''}`
    : '';
  $('connect-card').hidden = status.connected;
  $('live-card').hidden = !status.connected;
  if (status.telemetry !== null && status.telemetry.durationMs > 0) {
    $('provider').textContent += ` — ${fmt(status.telemetry.positionMs)} / ${fmt(status.telemetry.durationMs)}`;
  }

  // The cast control is always visible: when Playin cannot act it says why,
  // instead of disappearing (docs/EXTENSION_FIRST.md, Part 3).
  const affordance = castAffordanceFor(status.provider);
  const castBtn = $<HTMLButtonElement>('cast');
  castBtn.textContent = affordance.label;
  castBtn.disabled = !affordance.enabled;
  $('cast-reason').textContent = affordance.reason;
  $('cast-reason').hidden = affordance.reason.length === 0;
}

$('connect').addEventListener('click', () => {
  const code = $<HTMLInputElement>('code').value.trim();
  if (code.length === 0) return;
  const errEl = $('error');
  errEl.hidden = true;
  $('connect').textContent = 'Connecting…';
  ($('connect') as HTMLButtonElement).disabled = true;
  send<{ roomName: string }>({ kind: 'popup:connect', code })
    .then(() => refresh())
    .catch((err: unknown) => {
      errEl.textContent = err instanceof Error ? err.message : 'Connect failed';
      errEl.hidden = false;
    })
    .finally(() => {
      $('connect').textContent = 'Connect this tab';
      ($('connect') as HTMLButtonElement).disabled = false;
    });
});

$('disconnect').addEventListener('click', () => {
  void send({ kind: 'popup:disconnect' }).then(() => refresh());
});

$('share').addEventListener('click', () => {
  const btn = $('share') as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = 'Sharing…';
  send({ kind: 'popup:share' })
    .catch((err: unknown) => {
      btn.textContent = err instanceof Error ? err.message : 'Share failed';
    })
    .finally(() => {
      btn.disabled = false;
      if (btn.textContent === 'Sharing…') btn.textContent = 'Sharing — stop from the room';
    });
});

$('cast').addEventListener('click', () => {
  const btn = $<HTMLButtonElement>('cast');
  btn.disabled = true;
  send<{ clicked: boolean; reason: string }>({ kind: 'popup:cast' })
    .then((res) => {
      $('cast-reason').textContent = res.reason;
      $('cast-reason').hidden = res.reason.length === 0;
    })
    .catch((err: unknown) => {
      $('cast-reason').textContent = err instanceof Error ? err.message : 'Cast failed';
      $('cast-reason').hidden = false;
    })
    .finally(() => {
      btn.disabled = false;
    });
});

void refresh();
setInterval(() => void refresh(), 2000);
