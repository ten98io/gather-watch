/**
 * Popup: connect this tab to a room (guest identity), show live status, choose
 * what to share with the room, disconnect. It talks ONLY to the background
 * worker — it owns no room state and calls no capture API itself.
 *
 * Why the surface is *named* here and captured there: choosing a window or a
 * screen opens Chrome's own picker, and the picker taking focus CLOSES this
 * popup. A picker started from this document would therefore be cancelled by
 * its own appearance. So the background starts it and this file only says
 * which surface the user asked for — and, as a consequence, must survive being
 * destroyed mid-share: it keeps nothing that matters and re-reads everything
 * when it opens again.
 */

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`#${id} missing`);
  return el as T;
};

import { castAffordanceFor } from './cast';
import type { TabProvider } from './providers';

/** What the user picked, in the user's terms — never a capture API name. */
type ShareSurface = 'tab' | 'window' | 'screen';

interface ShareChoice {
  id: string;
  surface: ShareSurface;
  label: string;
}

const SHARE_CHOICES: readonly ShareChoice[] = [
  { id: 'share-tab', surface: 'tab', label: 'This tab' },
  { id: 'share-window', surface: 'window', label: 'A window' },
  { id: 'share-screen', surface: 'screen', label: 'Your whole screen' },
];

interface Status {
  connected: boolean;
  roomName: string | null;
  playing: boolean;
  telemetry: { positionMs: number; durationMs: number; playing: boolean } | null;
  provider: TabProvider | null;
  /** Optional: older backgrounds do not report it, so it is never required. */
  sharing?: boolean;
}

/** Surface whose request is in flight; nothing else may be started meanwhile. */
let sharePending: ShareSurface | null = null;
/** What THIS popup managed to start — the fallback truth while the background
 *  does not report share state of its own. */
let sharedSurface: ShareSurface | null = null;

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

/* ── What the user is about to hear (or not) ── */

/** 'macOS' / 'Windows' from UA-CH where present, else the raw user agent —
 *  both spell Windows the same way, which is all the check below needs. */
function platformName(): string {
  const hinted = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform;
  return typeof hinted === 'string' && hinted.length > 0 ? hinted : navigator.userAgent;
}

/**
 * Chrome hands over sound from a TAB reliably, from a window never, and from a
 * whole screen only where the OS has system-audio capture — which macOS does
 * not, at all. Video-only is a normal outcome there, not a failure, so the one
 * thing the user needs is to be told before the silence surprises them.
 */
function audioNoteFor(surface: ShareSurface, platform: string): string {
  if (surface === 'tab') return '';
  if (surface === 'window') return 'A window goes over without its sound. Share a tab if the sound matters.';
  return /windows/i.test(platform)
    ? ''
    : 'Your screen goes over without its sound — this computer cannot pass it on. Share a tab if the sound matters.';
}

/** A picker the user dismissed is not a failure, so it is not shown as one. */
function isCancelled(message: string): boolean {
  return /cancel|dismiss|no (source|screen|window|tab) (selected|chosen)|nothing selected/i.test(
    message,
  );
}

/* ── Rendering ── */

/** True share state: the background's answer when it has one, ours otherwise. */
function shareIsLive(status: Status): boolean {
  return typeof status.sharing === 'boolean' ? status.sharing : sharedSurface !== null;
}

function renderShare(live: boolean): void {
  for (const choice of SHARE_CHOICES) {
    const btn = $<HTMLButtonElement>(choice.id);
    btn.disabled = sharePending !== null || live;
    btn.textContent = sharePending === choice.surface ? 'Starting…' : choice.label;
  }
  $('share-live').hidden = !live;
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

  renderShare(shareIsLive(status));

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

/**
 * One share request. Every exit path — started, refused, dismissed, or this
 * document dying while the picker is open — has to end with buttons a user can
 * press again; a stuck 'Starting…' would be indistinguishable from a hang.
 */
function requestShare(choice: ShareChoice): void {
  if (sharePending !== null) return;
  sharePending = choice.surface;

  const note = $('share-note');
  const audio = audioNoteFor(choice.surface, platformName());
  note.textContent = audio;
  note.hidden = audio.length === 0;
  const errEl = $('share-error');
  errEl.hidden = true;
  renderShare(false);

  send({ kind: 'popup:share', surface: choice.surface })
    .then(() => {
      sharedSurface = choice.surface;
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : '';
      if (isCancelled(message)) {
        // Chose nothing: back to where they were, with nothing to explain.
        note.textContent = '';
        note.hidden = true;
        return;
      }
      errEl.textContent = message.length > 0 ? message : 'That share could not start.';
      errEl.hidden = false;
    })
    .finally(() => {
      sharePending = null;
      renderShare(sharedSurface !== null);
      void refresh();
    });
}

for (const choice of SHARE_CHOICES) {
  $(choice.id).addEventListener('click', () => requestShare(choice));
}

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
