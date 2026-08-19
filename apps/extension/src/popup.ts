/**
 * Popup: connect this tab to a room (guest identity), show live status, choose
 * what to share with the room, stop that share, disconnect. It talks ONLY to
 * the background worker — it owns no room state and calls no capture API
 * itself.
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
  /**
   * Why the last share stopped, when the ROOM stopped it — refused it, or a
   * moderator ended it. Nothing else on this page would say: the share was
   * reported as started, because locally it had, and the buttons simply come
   * back. '' whenever there is nothing to explain.
   */
  shareEnded?: string;
}

/** Surface whose request is in flight; nothing else may be started meanwhile. */
let sharePending: ShareSurface | null = null;
/** What THIS popup started — the fallback truth for a background too old to
 *  report share state of its own. */
let sharedSurface: ShareSurface | null = null;
/** The background's sentence about the live share. It has to outlive the
 *  re-render on every poll, and a popup opened mid-share never has one. */
let shareNote = '';
/**
 * What the last cast press came back with.
 *
 * A site Gather CAN cast from has no standing reason of its own, so the poll
 * two seconds later re-rendered this slot as empty — and the one sentence that
 * matters, "couldn't find the cast control on this page", is produced by
 * exactly those sites, when they have been reskinned since the selectors in
 * providers.ts were written. It was on screen for under two seconds and then
 * vanished, which reads as a button that does nothing at all. Remembered here
 * so every re-render puts it back.
 */
let castNote = '';

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

/* ── What the share request came back as ── */

/** Everything the popup shows about one answered share request. */
export interface ShareView {
  /** Something is being captured because of this request. */
  live: boolean;
  /** The sentence to show while it runs; '' when nothing is running. */
  note: string;
  /** The error slot; '' when there is nothing to apologise for. */
  error: string;
}

/** Only for a background that answered with a shape this popup cannot read. */
const SHARE_FAILED = 'That share could not start.';
/** A share this popup did not start has no sentence of its own to show. */
const SHARING_NOW = 'Sharing with the room now.';

/**
 * The background reports the outcome; it does not throw one. Closing the
 * picker resolves, and so does a capture that failed, so the two are told
 * apart by the fields and never by matching the words of an error — which
 * read a genuine refusal ("no tab selected") as a dismissed picker and left a
 * failed share claiming the room could see something.
 *
 * `note` is written by the only party that knows what the picker answered
 * about sound, so it is shown exactly as written.
 */
export function shareView(value: unknown): ShareView {
  const bag = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const note = typeof bag['note'] === 'string' ? bag['note'] : '';
  if (bag['shared'] === true) return { live: true, note, error: '' };
  // Choosing nothing is an answer, not a fault: there is nothing to explain.
  if (bag['cancelled'] === true) return { live: false, note: '', error: '' };
  return { live: false, note: '', error: note.length > 0 ? note : SHARE_FAILED };
}

/** A rejection is one of the states the user can fix, so it is shown as sent. */
export function refusalView(message: string): ShareView {
  return { live: false, note: '', error: message.length > 0 ? message : SHARE_FAILED };
}

/* ── Rendering ── */

/**
 * True share state. The background is the authority, because a share ends in
 * ways this document never sees: Chrome's own stop bar, the shared tab
 * closing, the room ending, or this popup being destroyed and reopened. What
 * is remembered here is therefore dropped the moment it disagrees.
 */
function liveShare(status: Status): boolean {
  if (typeof status.sharing !== 'boolean') return sharedSurface !== null;
  if (!status.sharing) {
    sharedSurface = null;
    shareNote = '';
  }
  return status.sharing;
}

function renderShare(live: boolean): void {
  for (const choice of SHARE_CHOICES) {
    const btn = $<HTMLButtonElement>(choice.id);
    btn.disabled = sharePending !== null || live;
    btn.textContent = sharePending === choice.surface ? 'Starting…' : choice.label;
  }
  $<HTMLButtonElement>('share-stop').hidden = !live;
  const line = live ? (shareNote.length > 0 ? shareNote : SHARING_NOW) : '';
  const note = $('share-note');
  note.textContent = line;
  note.hidden = line.length === 0;
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

  renderShare(liveShare(status));

  // Written, never cleared, from here: the request's own outcome owns this
  // slot (see applyShare), and a poll two seconds later must not wipe the
  // sentence a refused click just put in it.
  const ended = typeof status.shareEnded === 'string' ? status.shareEnded : '';
  if (ended.length > 0) {
    $('share-error').textContent = ended;
    $('share-error').hidden = false;
  }

  // The cast control is always visible: when Gather cannot act it says why,
  // instead of disappearing (docs/EXTENSION_FIRST.md, Part 3).
  const affordance = castAffordanceFor(status.provider);
  const castBtn = $<HTMLButtonElement>('cast');
  castBtn.textContent = affordance.label;
  castBtn.disabled = !affordance.enabled;
  // The site's own standing reason wins: it describes the tab in front of the
  // user, while the remembered one is about a press that already happened.
  const reason = affordance.reason.length > 0 ? affordance.reason : castNote;
  $('cast-reason').textContent = reason;
  $('cast-reason').hidden = reason.length === 0;
}

/* ── Actions ── */

/** The outcome as the background reported it, never a guess made from here. */
function applyShare(view: ShareView, surface: ShareSurface): void {
  sharedSurface = view.live ? surface : null;
  shareNote = view.note;
  const errEl = $('share-error');
  errEl.textContent = view.error;
  errEl.hidden = view.error.length === 0;
}

/**
 * One share request. Every exit path — started, refused, dismissed, or this
 * document dying while the picker is open — has to end with buttons a user can
 * press again; a stuck 'Starting…' would be indistinguishable from a hang.
 */
function requestShare(choice: ShareChoice): void {
  if (sharePending !== null) return;
  sharePending = choice.surface;
  sharedSurface = null;
  shareNote = '';
  $('share-error').hidden = true;
  renderShare(false);

  send<unknown>({ kind: 'popup:share', surface: choice.surface })
    .then((value) => applyShare(shareView(value), choice.surface))
    .catch((err: unknown) => {
      applyShare(refusalView(err instanceof Error ? err.message : ''), choice.surface);
    })
    .finally(() => {
      sharePending = null;
      renderShare(sharedSurface !== null);
      void refresh();
    });
}

/** Stopping is answered even when nothing was being captured, so the button
 *  cannot fail in a way the user could act on; it always returns to itself. */
function stopShare(): void {
  const btn = $<HTMLButtonElement>('share-stop');
  btn.disabled = true;
  btn.textContent = 'Stopping…';
  void send({ kind: 'popup:stopShare' })
    .catch(() => undefined)
    .finally(() => {
      sharedSurface = null;
      shareNote = '';
      btn.disabled = false;
      btn.textContent = 'Stop sharing';
      $('share-error').hidden = true;
      renderShare(false);
      void refresh();
    });
}

/* ── Wiring ── */

function mount(): void {
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

  for (const choice of SHARE_CHOICES) {
    $(choice.id).addEventListener('click', () => requestShare(choice));
  }

  $('share-stop').addEventListener('click', () => stopShare());

  $('cast').addEventListener('click', () => {
    const btn = $<HTMLButtonElement>('cast');
    btn.disabled = true;
    castNote = '';
    send<{ clicked: boolean; reason: string }>({ kind: 'popup:cast' })
      .then((res) => {
        castNote = res.reason;
      })
      .catch((err: unknown) => {
        castNote = err instanceof Error ? err.message : 'Cast failed';
      })
      .finally(() => {
        btn.disabled = false;
        $('cast-reason').textContent = castNote;
        $('cast-reason').hidden = castNote.length === 0;
      });
  });

  void refresh();
  // The only way a share that ended elsewhere becomes visible here: the
  // background reports it on the next poll, ~2s after Chrome's stop bar.
  setInterval(() => void refresh(), 2000);
}

// Reading this module for its decisions must not require a popup document.
if (typeof document !== 'undefined') mount();
