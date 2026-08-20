'use client';

/**
 * StagePane — the room's sun (DESIGN.md §1).
 *
 * Three things can hold the stage, in this order of precedence:
 *   1. a member's SCREEN SHARE (restream.state active) → ScreenShareStage;
 *   2. the browser EXTENSION driving the user's own content tab, in which case
 *      this page deliberately builds no player at all and says where the
 *      picture went;
 *   3. this page's own player — real <video>/<audio>/YouTube-iframe adapters
 *      drift-corrected by sync-core via useSyncEngine, with
 *      server-authoritative transport, wait-for-all buffering, captions and
 *      MediaSession.
 *
 * Ambient glow samples the playing media (§5.1) with an aurora fallback; emote
 * bursts float above.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { motion } from '@gather/design';
import type { RoomId } from '@gather/contracts';
import { useRoom, useRoomConnection } from '@/lib/room-context';
import { setImmersive, toggleImmersive, useImmersive } from '@/components/room/ImmersiveStage';
import { canAct } from '@/lib/permissions';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { adapterKindFor, isFullSyncKind, mediaKey, stageGate } from '@/lib/player/adapter';
import { endedQueueItemId } from '@/lib/player/advance';
import { mediaKindFor } from '@/lib/media-kind';
import type { PlayerAdapter, StageGate } from '@/lib/player/adapter';
import { NativeAdapter } from '@/lib/player/native';
import { YouTubeAdapter } from '@/lib/player/youtube';
import { SoundCloudAdapter } from '@/lib/player/soundcloud';
import { VimeoAdapter } from '@/lib/player/vimeo';
import { EmbedAdapter } from '@/lib/player/embed';
import { useSyncEngine } from '@/lib/player/useSyncEngine';
import {
  EXTENSION_DOCS_PATH,
  drivenIsDrm,
  extensionInstallUrl,
  isHandheldBrowser,
  useExtensionDriver,
} from '@/lib/player/extension-driver';
import type { ExtensionDriverState } from '@/lib/player/extension-driver';
import { ExtensionGate } from '@/components/extension/ExtensionGate';
import type { ExtensionGateStatus } from '@/components/extension/ExtensionGate';
import { extensionMediaKey, onEnded } from '@/lib/extension-bridge';
import type { ProviderSummary } from '@/lib/extension-bridge';
import { API_URL, getAccessToken } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button, buttonClasses } from '@/components/ui/button';
import { PlayIcon, TheaterIcon } from '@/components/ui/icons';
import { Tooltip } from '@/components/ui/tooltip';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/cn';
import { EmoteOverlay } from './EmoteOverlay';
import { ListenStage } from './ListenStage';
import { PlayerControls } from './PlayerControls';
import { ScreenShareStage } from './ScreenShareStage';

/**
 * ── The two ambient washes, and why they are numbers and not classes ─────
 *
 * The stage's own conic aurora (§5.5) and the bloom the EMPTY stage adds under
 * it (§5.1's fallback, which is what an artwork-less room has) both sit behind
 * `--text-low` — the floor of the whole palette — so they are a contrast
 * budget, not a styling choice, and they are spent together.
 *
 * Composited in paint order — the worst drift stop onto the void, the bloom
 * onto that — `--text-low` holds 5.36:1 on dark and 4.68:1 on light at these
 * two values. Push the pair to 0.08 / 0.16 and light falls to 4.33:1, under
 * AA, on the one screen every room shows first.
 * test/stage-ambient-contrast.test.ts measures both claims and fails the build.
 *
 * The drift is 0.05 rather than the 0.06 it shipped at because DESIGN.md §5.5
 * pins `.void-aurora` at 5% and this is the same wash: one value, written
 * twice, is one of them being wrong.
 */
export const AMBIENT_AURORA_OPACITY = 0.05;
export const IDLE_BLOOM_OPACITY = 0.12;

/** Ambient stage glow (§5.1): dominant color sampled off the video at 1 fps,
 *  bled into the void behind the stage. Cross-origin video without CORS
 *  taints the canvas — we catch that and keep the aurora fallback. */
function useAmbientGlow(
  adapter: PlayerAdapter | null,
  playing: boolean,
  reducedMotion: boolean,
): string | null {
  const [color, setColor] = useState<string | null>(null);

  useEffect(() => {
    if (reducedMotion || adapter === null || adapter.kind !== 'native' || !playing) return;
    const el = (adapter as NativeAdapter).mediaElement;
    if (!(el instanceof HTMLVideoElement)) return;
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 8;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx === null) return;

    const sample = (): void => {
      try {
        ctx.drawImage(el, 0, 0, 8, 8);
        const data = ctx.getImageData(0, 0, 8, 8).data;
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let i = 0; i < data.length; i += 4) {
          r += data[i] ?? 0;
          g += data[i + 1] ?? 0;
          b += data[i + 2] ?? 0;
          n += 1;
        }
        if (n > 0) setColor(`rgb(${Math.round(r / n)}, ${Math.round(g / n)}, ${Math.round(b / n)})`);
      } catch {
        // Tainted canvas (cross-origin media) — keep the aurora fallback.
      }
    };
    const handle = setInterval(sample, 1000);
    return () => clearInterval(handle);
  }, [adapter, playing, reducedMotion]);

  return color;
}

interface StageFullscreen {
  /** This browser can fullscreen an ordinary element. False hides the control
   *  outright — an affordance that throws is worse than no affordance. */
  supported: boolean;
  active: boolean;
  toggle(): void;
  exit(): void;
}

/**
 * TWO ANSWERS, and both are required. iOS Safari on iPhone fullscreens only
 * <video> (`webkitEnterFullscreen`): `Element.prototype.requestFullscreen` does
 * not exist there at all, so calling it throws rather than degrading.
 * `document.fullscreenEnabled` is the other half — false inside an iframe whose
 * embedder withheld `allow="fullscreen"`, where the method exists and every
 * call rejects.
 */
function fullscreenAvailable(): boolean {
  return (
    document.fullscreenEnabled === true &&
    typeof Element.prototype.requestFullscreen === 'function' &&
    typeof document.exitFullscreen === 'function'
  );
}

/** The element holding the top layer, or null. Where the API is absent the
 *  property is UNDEFINED rather than null, and `undefined !== null` would read
 *  as "we are already fullscreen". */
function fullscreenElement(): Element | null {
  return document.fullscreenElement ?? null;
}

/**
 * TRUE BROWSER FULLSCREEN for one element (DESIGN.md §11 D1.1: "true browser
 * fullscreen, not just maximized", `F` to enter and exit). Until this there was
 * no `requestFullscreen` call anywhere in apps/web — the only mention of the
 * word was youtube.ts claiming the room's chrome handled it.
 *
 * Constraints this shape exists for:
 *
 *  - `supported` settles in an EFFECT, not during render: the server pass has
 *    no `document`, and reading one during render makes the first client paint
 *    disagree with the markup it is hydrating.
 *  - `active` is read back from `document.fullscreenElement` on
 *    `fullscreenchange` and never assumed from our own call. That event is the
 *    only way we learn about the exits we did not perform — Escape, F11, the
 *    browser's own overlay button, another element taking the top layer.
 *  - ESCAPE IS THE BROWSER'S, and is deliberately not bound. The spec already
 *    leaves fullscreen on it and then fires `fullscreenchange`, which the
 *    listener below picks up; a binding would additionally eat the key that
 *    dismisses every dialog and sheet in the room.
 */
function useFullscreen(targetRef: RefObject<HTMLElement | null>): StageFullscreen {
  const [supported, setSupported] = useState(false);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const available = fullscreenAvailable();
    setSupported(available);
    if (!available) return undefined;
    const sync = (): void => setActive(fullscreenElement() !== null);
    sync();
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  const exit = useCallback((): void => {
    if (!fullscreenAvailable() || fullscreenElement() === null) return;
    // Rejections (a document that already left the top layer) are not ours to
    // report: `fullscreenchange` remains the single source of `active`.
    void document.exitFullscreen().catch(() => undefined);
  }, []);

  const toggle = useCallback((): void => {
    if (!fullscreenAvailable()) return;
    if (fullscreenElement() !== null) {
      exit();
      return;
    }
    const el = targetRef.current;
    if (el === null) return;
    // Rejects when the browser will not honour the gesture. Nothing is latched
    // optimistically, so a refusal simply leaves the control as it was.
    void el.requestFullscreen().catch(() => undefined);
  }, [targetRef, exit]);

  return { supported, active, toggle, exit };
}

/** Sync pulse (§5.4): one soft ring expands when a seek/track-change lands. */
function SyncPulse({ pulseKey }: { pulseKey: number }) {
  const reduced = useReducedMotion();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (pulseKey === 0) return;
    setVisible(true);
    const h = setTimeout(() => setVisible(false), reduced ? 150 : 900);
    return () => clearTimeout(h);
  }, [pulseKey, reduced]);
  if (!visible) return null;
  return (
    <span
      aria-hidden
      className={cn(
        // `--accent`, not `--aurora-2`. A ring is a standalone non-text
        // graphic and only the tokens in STANDALONE_UI_TOKENS are measured as
        // one; `aurora-2` is a GRADIENT STOP and is excluded by rule (§2). It
        // also has to retint with the artwork in a listen room, which is what
        // `--accent` does and a raw stop cannot.
        'pointer-events-none absolute inset-0 z-10 m-auto h-24 w-24 rounded-full border-2 border-accent',
        reduced && 'opacity-40',
      )}
      style={reduced ? undefined : { animation: 'sync-pulse 0.9s ease-out forwards' }}
    />
  );
}

/**
 * StageShield — the single control surface over a full-sync provider
 * (UX_OVERHAUL B2). It always covers the whole stage so the provider's own
 * chrome (YouTube's centre play overlay in the unstarted AND paused states,
 * SoundCloud's transport, Vimeo's big button) can never be clicked; while the
 * room is paused or this browser refused to start, it also covers it visually
 * with our own backdrop.
 *
 * Exactly one play affordance is ever offered here — the centre ring — and it
 * only exists while playback is not running. It sits BELOW the room's own
 * chrome (badges/transport z-20, call overlay z-30), so nothing above it is
 * blocked.
 *
 * ── The stage's one gradient ─────────────────────────────────────────────
 * The ring is `.aurora-gradient` at 96px with the signature glow under it, and
 * it is the ONLY place on this stage the gradient is spent (§2 budgets the
 * whole product at three, a screen region at one). That is why the transport
 * bar's play button is `secondary`: the two are the same action, and the one
 * worth colouring is the oversized "everyone starts together" moment, not a
 * 32px square in a bar that also holds nine other 32px squares.
 *
 * Everything inside is a <span>. A <button>'s content model is phrasing
 * content, so the artwork primitive (a <div>) may not come in here — the
 * paused composition says what this is in words instead, and the picture is
 * the thing behind the backdrop.
 */
function StageShield({
  gate,
  title,
  listen,
  canControl,
  onActivate,
}: {
  gate: StageGate;
  title: string | null;
  listen: boolean;
  /** Room policy: may this member drive playback? */
  canControl: boolean;
  onActivate(): void;
}) {
  const reduced = useReducedMotion();
  // Starting your own blocked player is a local act — never policy-gated.
  const actionable = canControl || gate === 'blocked';
  const verb = listen ? 'listening' : 'watching';
  const label =
    gate === 'blocked'
      ? `Start ${verb} together`
      : gate === 'paused'
        ? 'Play'
        : 'Pause';
  const overline = gate === 'blocked' ? 'Ready when you are' : 'Paused';
  const hint =
    gate === 'blocked'
      ? `Tap to start ${verb} together`
      : actionable
        ? 'Press play — everyone starts together'
        : 'Waiting for the host to press play';

  const backdrop =
    gate === 'none' ? null : (
      <span
        className={cn(
          // `headline`, never `display`: a failed load draws its own title in
          // this same slot, one layer down, and two display settings can
          // therefore be in the DOM at once (§3, §10).
          'grain absolute inset-0 flex flex-col items-center justify-center bg-surface-0 px-6 py-12',
          !reduced && 'animate-fade-in',
        )}
      >
        <span className="flex max-w-lg flex-col items-center gap-3 text-center">
          <span className="text-caption text-low">{overline}</span>
          {title !== null && title !== '' && (
            <span className="line-clamp-2 text-headline text-hi">{title}</span>
          )}
        </span>
        {actionable && (
          <span className="aurora-gradient mt-8 grid h-24 w-24 place-items-center rounded-full shadow-glow">
            <PlayIcon size={28} />
          </span>
        )}
        <span className="mt-6 text-label text-low">{hint}</span>
      </span>
    );

  return (
    <button
      type="button"
      // Transparent (or view-only) state: a pointer trap, not an affordance.
      // Keeping it out of the a11y tree and the tab order leaves the transport
      // bar as the single play control; when the backdrop is up and this
      // member may act, the centre ring becomes that control instead.
      {...(gate !== 'none' && actionable ? {} : { 'aria-hidden': true, tabIndex: -1 })}
      aria-label={label}
      className={cn(
        'absolute inset-0 z-10 h-full w-full',
        actionable ? 'cursor-pointer' : 'cursor-default',
      )}
      onClick={onActivate}
    >
      {backdrop}
    </button>
  );
}

/**
 * Anything the stage says instead of showing a picture, wearing the system's
 * one page transition: fade + a 12 px rise (DESIGN.md §6, `motion.pageRisePx`
 * — which had no consumer anywhere until this).
 *
 * The fade is the CSS class, so it works before hydration and is already
 * clamped by the global `prefers-reduced-motion` rule in globals.css. The rise
 * is the inline transition, flipped one frame after mount, and is dropped
 * outright under reduced motion — a rise is exactly the kind of positional
 * motion §9 says to remove, and the fade alone still reads as a transition.
 *
 * Deliberately restrained: a room where content is playing must not have
 * things moving around it. This animates only in the gaps where there IS no
 * content — an empty queue, the handover to the extension, the moment between
 * two items.
 *
 * It owns the motion and the box, and NOTHING about the layout inside it: the
 * two shapes below decide that, and they decide it differently on purpose.
 */
function StageMessage({ children }: { children: ReactNode }) {
  const reduced = useReducedMotion();
  const [risen, setRisen] = useState(false);
  useEffect(() => {
    if (reduced) return undefined;
    const handle = requestAnimationFrame(() => setRisen(true));
    return () => cancelAnimationFrame(handle);
  }, [reduced]);
  return (
    <div
      className={cn(
        'relative flex h-full w-full items-center justify-center px-6 py-12',
        !reduced && 'animate-fade-in',
      )}
      style={
        reduced
          ? undefined
          : {
              transform: risen ? 'none' : `translateY(${String(motion.pageRisePx)}px)`,
              transition: `transform ${String(motion.microMs)}ms ease-out`,
            }
      }
    >
      {children}
    </div>
  );
}

/**
 * ── The two shapes a picture-less stage takes ────────────────────────────
 *
 * Which one a state gets is decided by whether it OWNS the stage, and that is
 * a structural fact rather than a taste: it is what decides how much type the
 * state may spend.
 *
 *  · A POSTER owns the stage — nothing else can be on screen with it — so it
 *    is laid out like one: an overline, the display step, one sentence and at
 *    most two actions, set left in a measure, on a grained plate. `EmptyStage`,
 *    `PageLinkStage` and `ExtensionDrivingStage` are posters, and each one is
 *    reachable only when every other state is impossible (no media at all / a
 *    ref no player can be built for / the extension holding the whole branch).
 *    That exclusivity is what lets them each take `text-display`.
 *  · A NOTICE sits over a picture that is paused, arriving or broken. It is
 *    centred, it is momentary, and it stops at `headline`, because two of them
 *    genuinely can be in the DOM together — a load failure under a shield's
 *    backdrop — and a screen gets exactly one display setting (§3, §10).
 *
 * Left-aligned is not decoration either. A sentence centred in a 900×700 void
 * reads as an apology; the same sentence set against a left edge, under a
 * display line, reads as a page that meant to be there.
 */
function StagePoster({
  overline,
  title,
  children,
  actions,
}: {
  /** A word or two of category — or, once, the live indicator (§2). */
  overline: ReactNode;
  title: string;
  /** One sentence. Two at the outside — this is a poster, not a page. */
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <StageMessage>
      {/* Grain belongs to large quiet surfaces and carries nothing (§4): a host
          page with a strict `img-src` drops the data URI and the poster is
          still complete. */}
      <span aria-hidden className="grain pointer-events-none absolute inset-0" />
      {/* The rhythm is the composition. 12 between an overline and the title it
          labels, 24 to the sentence, 32 to the actions — three rungs, so the
          reader is told what belongs to what before reading a word. */}
      <div className="relative flex w-full max-w-xl flex-col items-start">
        <p className="flex items-center gap-2 text-caption text-low">{overline}</p>
        {/* `display` is a DESKTOP display setting. 44px of it swamps a 375px
            stage — "The room is ready" came down as two lines with a sentence
            underneath and no picture left to be about. One rung down below
            `md` keeps the poster a poster; the step above is unchanged from
            768 up, which is where the composition was already right. */}
        <h2 className="mt-3 line-clamp-3 text-headline text-hi md:text-display">{title}</h2>
        <div className="mt-6 flex max-w-md flex-col gap-3 text-body text-low">{children}</div>
        {actions !== undefined && (
          <div className="mt-8 flex flex-wrap items-center gap-3">{actions}</div>
        )}
      </div>
    </StageMessage>
  );
}

/** A notice over a picture: centred, momentary, `headline` at the most. */
function StageNotice({ title, children }: { title: string | null; children: ReactNode }) {
  return (
    <StageMessage>
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        {title !== null && title !== '' && (
          <p className="line-clamp-2 text-headline text-hi">{title}</p>
        )}
        {children}
      </div>
    </StageMessage>
  );
}

/**
 * An empty room — and this is the FIRST thing anyone ever sees of one, which
 * is the whole argument for spending the display step and the aurora bloom on
 * it (the bloom itself lives in the pane's ambient layer, so the light fills
 * the stage rather than a box inside it).
 *
 * No action. The queue lives in the rail and this surface cannot open it, and
 * an `<EmptyState>` action that scrolls nowhere is worse than a sentence that
 * says where to go — DESIGN.md §12's budget counts interactions, so inventing
 * one here would cost a step and buy nothing.
 */
function EmptyStage() {
  return (
    // "Nothing playing yet" was the display line here, and at 44px an apology
    // is simply a louder apology. The stage is not broken and it is not waiting
    // for us — it is waiting for THEM, which is a different sentence and the
    // one worth setting large. The body still says what to do; what changed is
    // that the biggest words on the first screen of every room now state the
    // promise instead of the absence.
    <StagePoster overline="The stage" title="The room is ready">
      <p>
        Paste any link into the Queue tab — a video, a track, or a page you already pay
        for. Everyone’s player follows this room, to the same second.
      </p>
    </StagePoster>
  );
}

/**
 * The gap between two items. Until now this was the bare void: a track change
 * across kinds tears the old adapter down and builds a new one, and for that
 * whole stretch — plus however long the new source takes to start — the stage
 * showed nothing at all, with EmptyStage reserved for "no media" and the
 * shield's backdrop only for paused/blocked. This is the honest third state:
 * the room is playing this item, and this device has not begun it yet.
 */
function CueingStage({ title }: { title: string | null }) {
  return (
    <StageNotice title={title}>
      <p className="text-caption text-low">Starting…</p>
    </StageNotice>
  );
}

/**
 * The one extra sentence a page item owes THIS browser, or null.
 *
 * Chosen from the driver's phase, never inferred from the install URL: the URL
 * can no longer distinguish anything (`extensionInstallUrl()` always answers,
 * falling back to the app's own /extension page), and only the phase knows
 * whether the extension is already here, absent, or impossible on this
 * browser. Saying nothing is allowed; saying something untrue is not.
 */
function pageItemNote(state: ExtensionDriverState): string | null {
  if (state.phase === 'ready') {
    return 'You already have the extension — open the link and it picks the page up from there.';
  }
  if (state.phase === 'unavailable' && state.reason === 'unsupported-browser') {
    return 'The extension needs Chrome on a computer. On a phone, the Gather app plays these.';
  }
  return null;
}

/**
 * The gate's vocabulary for the driver's phase, or null when the driver is
 * ready and there is nothing to gate. A pure translation: both unions are
 * closed, and this is the single place they meet.
 */
function gateStatusFor(state: ExtensionDriverState): ExtensionGateStatus | null {
  if (state.phase === 'detecting') return 'detecting';
  if (state.phase === 'incompatible') return 'incompatible';
  if (state.phase === 'unavailable') {
    return state.reason === 'unsupported-browser' ? 'unsupported-browser' : 'not-installed';
  }
  return null;
}

/**
 * A `page` item on a browser that cannot play one.
 *
 * The queue accepts ANY link — that is the promise QueuePane makes at the paste
 * box — but a page is a LINK, not media bytes: only the extension can play it,
 * by driving whatever video the page itself mounts, in the viewer's own tab.
 * `adapterKindFor` correctly refuses to build a player for one, so this state
 * owns the whole stage whenever it is up.
 *
 * It is also about to be COMMON rather than rare: protected rows (Netflix,
 * Disney+) became queueable, and this is what everyone without the extension
 * sees for one. So it says the three things that actually settle it — what the
 * item is, that each person plays their own copy from their own account, and
 * how to get the extension when there is honestly somewhere to send them.
 */
function PageLinkStage({
  url,
  title,
  installUrl,
  note,
  installHandledBelow = false,
}: {
  url: string;
  title: string | null;
  /** Null when there is nothing to send anyone to — see `pageItemNote`. */
  installUrl: string | null;
  /** The browser-specific sentence, or null when there is nothing true to say. */
  note: string | null;
  /** True when the gate below carries the region's primary (its install CTA):
   *  "Open the link" then stays secondary, so the region keeps one gradient
   *  (DESIGN.md §2) and one offer. */
  installHandledBelow?: boolean;
}) {
  return (
    <StagePoster
      overline="Plays in your own browser"
      title={title !== null && title !== '' ? title : 'A link to a page'}
      actions={
        <>
          {installUrl !== null && (
            <a
              href={installUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonClasses({ variant: 'primary', size: 'lg' })}
            >
              Add the extension
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          )}
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonClasses({
              variant: installUrl === null && !installHandledBelow ? 'primary' : 'secondary',
              size: 'lg',
            })}
          >
            Open the link
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        </>
      }
    >
      <p>
        This is a link to a page, not a file the room can hand you. The Gather extension
        plays it in the tab you are already signed in to — everyone plays their own copy,
        from their own account, and the room keeps you all on the same second.
      </p>
      {note !== null && <p className="text-label">{note}</p>}
    </StagePoster>
  );
}

/**
 * The source refused to load on THIS device. The adapters have always emitted
 * 'error' — a dead <video>, an HLS manifest that will not parse, a provider
 * iframe that never comes up — and nothing on the stage was listening, so the
 * room sat on CueingStage's "Starting…" for as long as it stayed open.
 */
function LoadFailedStage({ title }: { title: string | null }) {
  return (
    <StageNotice title={title}>
      <p className="text-body text-low">
        This didn’t load on your device. Everyone else is unaffected, and the next item
        starts fresh.
      </p>
    </StageNotice>
  );
}

/**
 * What the stage says while the extension is the one playing. The video is in
 * the user's own tab on the content site, so this space explains where it went
 * rather than pretending to be a player — the room's transport, chat, queue and
 * call all keep working here.
 */
function ExtensionDrivingStage({
  provider,
  playing,
}: {
  provider: ProviderSummary | null;
  /** The room says playback is running. Gates the live indicator, which must
   *  never claim motion the room is not in. */
  playing: boolean;
}) {
  const name = provider?.name ?? null;
  // The capability stream's own answer, not one blanket promise for every tab.
  // On the eight protected services (`drivenIsDrm`) there is no shared picture
  // and there never can be: each viewer is playing their own copy from their
  // own account, and only the timing is common. Saying "everyone stays on the
  // same second" and stopping there read as though we were sending them video.
  const protectedSource = drivenIsDrm(provider);
  return (
    <StagePoster
      // The gradient's second sanctioned use on this stage, and it is
      // exclusive with the shield's ring — this branch replaces the player
      // outright. A dot that is on while the room is paused would be the
      // indicator lying, so it is gated on the room's own state.
      overline={
        playing ? (
          <>
            <span aria-hidden className="aurora-gradient h-2 w-2 rounded-full" />
            Live
          </>
        ) : (
          'Ready'
        )
      }
      title={name === null ? 'Playing in your other tab' : `Playing on ${name}`}
    >
      <p>
        {protectedSource
          ? 'Everyone plays their own copy, signed in with their own account — the room keeps you all on the same second.'
          : 'Everyone stays on the same second. Play, pause and skip from here or from the tab — the room follows either way.'}
      </p>
    </StagePoster>
  );
}

export function StagePane({
  roomId,
  pathBadge,
  overlay,
}: {
  roomId: RoomId;
  /** The live media-path badge (top-right cluster). Injected by the shell —
   *  it reads the call session, and a bare StagePane must stay mountable
   *  without one (every stage test mounts one). Absent means say nothing. */
  pathBadge?: ReactNode;
  /** The immersive-mode chrome. Mounted INSIDE this section on purpose: the
   *  fullscreen top layer paints over the whole document, so chrome the shell
   *  kept outside would simply not be on screen while fullscreen is active. */
  overlay?: ReactNode;
}) {
  const connection = useRoomConnection();
  const { room, member } = useRoom();
  const playback = connection.useRoomState((s) => s.playback);
  const restream = connection.useRoomState((s) => s.restream);
  const waitingOn = connection.useRoomState((s) => s.waitingOn);
  const queueItems = connection.useRoomState((s) => s.queue.items);
  const reduced = useReducedMotion();

  const mediaRef = playback?.mediaRef ?? null;

  /**
   * WEB_SLIMMING step 2 — the extension is the preferred driver when it is
   * there, and the web defers to it.
   *
   * "Defers" is the whole point: while the extension drives, this tab must not
   * ALSO create a player. Two players for one room means two things seeking
   * against one another and the room's own sync engine correcting a position
   * nobody is watching. So the adapter kind goes null and no adapter is built.
   *
   * When the extension is absent this is inert and the web plays as before —
   * deleting the web adapters is step 4, and it is gated on this path being
   * verified first.
   */
  const extension = useExtensionDriver();
  const extensionDriving = extension.driving;
  const adapterKind = extensionDriving ? null : adapterKindFor(mediaRef);
  /** The stage adapts to what is PLAYING: a music item gets the listen
   *  composition, a video item the video stage. The room's stored `kind` is
   *  deprecated wire ballast and drives nothing. */
  const listen = mediaKindFor(mediaRef) === 'music';
  /** A member is sharing their screen: that share owns the stage. */
  const shareOnStage = restream?.active === true;
  /** Room policy: may this member drive playback? */
  const controlEnabled = canAct(room.policies.playbackControl, member.role);

  const mediaElRef = useRef<HTMLVideoElement | null>(null);
  const embedContainerRef = useRef<HTMLDivElement | null>(null);
  /** The fullscreen element is the whole stage SECTION, not the video: the
   *  transport bar, the shield, the badges and the emote overlay all live
   *  inside it, and fullscreening the <video> alone would strand every one of
   *  them behind the top layer. */
  const stageRef = useRef<HTMLElement | null>(null);
  const [adapter, setAdapter] = useState<PlayerAdapter | null>(null);
  const [muted, setMuted] = useState(false);
  const [captionsOn, setCaptionsOn] = useState(true);
  const [captionsAvailable, setCaptionsAvailable] = useState(false);
  const [chromeAwake, setChromeAwake] = useState(true);
  const [driftMs, setDriftMs] = useState(0);
  const [shareOpen, setShareOpen] = useState(false);
  // What THIS device's player is actually doing — the room's playback state
  // says what it should be doing, and the two disagree when the browser
  // refuses to start (autoplay policy).
  const [localPlaying, setLocalPlaying] = useState(false);
  /** This device's source has run out. Distinct from "not playing": a finished
   *  player must not be restarted, and it is not waiting for a gesture either. */
  const [localEnded, setLocalEnded] = useState(false);
  const [localBuffering, setLocalBuffering] = useState(false);
  const [localReady, setLocalReady] = useState(false);
  /** This device's source refused to load. Distinct from every other wait: it
   *  is not going to arrive, so the stage must stop saying "Starting…". */
  const [loadFailed, setLoadFailed] = useState(false);
  const [playRefused, setPlayRefused] = useState(false);
  const [startStalled, setStartStalled] = useState(false);
  /** Bumped by every start gesture so the "did it actually start?" watchdog
   *  re-arms; without it a second refusal would go unnoticed. */
  const [startAttempt, setStartAttempt] = useState(0);

  const fullscreen = useFullscreen(stageRef);

  /**
   * THE ONE IMMERSIVE MODE (DESIGN.md §11 D1.1, unified 2026-08-20). Theater
   * and fullscreen are the same local latch now — see ImmersiveStage.tsx. This
   * pane wires the latch to the browser: the F key and both on-stage controls
   * flip it, and the two effects below keep the top layer in step with it.
   */
  const immersive = useImmersive((s) => s.active);

  /**
   * The MODE drives the ENHANCEMENT, never the other way round: flipping the
   * latch on asks for browser fullscreen where the platform grants it
   * (useFullscreen's own guards make this a no-op on iOS Safari and in
   * forbidden iframes — the layout is the mode there); flipping it off gives
   * the top layer back. Keyed on the latch alone, through a ref for the
   * previous value: keying on `fullscreen.active` too would re-request the
   * top layer in the very render after the browser's own Escape exit.
   */
  const wasImmersiveRef = useRef(false);
  useEffect(() => {
    const was = wasImmersiveRef.current;
    wasImmersiveRef.current = immersive;
    if (immersive && !was && !fullscreen.active) fullscreen.toggle();
    if (!immersive && was) fullscreen.exit();
    // fullscreen.active is deliberately read, not depended on (see above).
  }, [immersive, fullscreen.toggle, fullscreen.exit]);

  /**
   * …and an exit the BROWSER performed takes the mode with it. Escape, F11
   * and the browser's own overlay button never pass through our handlers —
   * they surface only as `fullscreenchange` — and a mode that stayed on after
   * them would be two modes again, which is the disease this replaced.
   *
   * EXCEPT an exit WE performed to show a dialog. Dialogs portal to
   * document.body and the fullscreen top layer paints over the whole
   * document, so opening one means leaving fullscreen first — and that exit
   * arrives here as the same `fullscreenchange` a user's Escape does. Reading
   * it as "the user left" collapsed the entire immersive mode the moment
   * anyone pressed Share screen inside it. The dialog gesture arms this
   * latch; one browser exit is then spent putting the LAYOUT through
   * unharmed, and fullscreen is re-requested when the dialog closes.
   */
  const wasFullscreenRef = useRef(false);
  const dialogExitRef = useRef(false);
  useEffect(() => {
    if (wasFullscreenRef.current && !fullscreen.active && immersive) {
      if (dialogExitRef.current) dialogExitRef.current = false;
      else setImmersive(false);
    }
    wasFullscreenRef.current = fullscreen.active;
  }, [fullscreen.active, immersive]);

  const debug = useMemo(
    () => typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('debug'),
    [],
  );

  /**
   * Hand this room to the extension once it is there, and hand it back when we
   * leave. The extension needs the room-scoped token to join the room's sync
   * stream itself; it goes only to the API origin this build already talks to,
   * and the extension re-checks that origin against its own build (see the
   * threat model in apps/extension/src/external.ts).
   *
   * `handoff`/`release` come from a module-level store, so their identities are
   * stable and this does not re-fire every render.
   */
  const { ready: extensionReady, handoff, release } = extension;
  useEffect(() => {
    if (!extensionReady) return undefined;
    const accessToken = getAccessToken();
    // Signed out, or the token has not been captured yet: the next render after
    // it arrives runs this again.
    if (accessToken === null) return undefined;
    void handoff({ roomId, roomName: room.name, accessToken, apiOrigin: API_URL });
    return () => {
      void release();
    };
  }, [extensionReady, roomId, room.name, handoff, release]);

  // ── adapter lifecycle (created per adapter kind; loaded per media identity)
  //
  // `listen` is a dependency ON PURPOSE, though the adapter kind does not
  // change with it: the music and video compositions mount their <video> in
  // DIFFERENT containers, so a native→native transition across the flip
  // (mp3 → mp4) swaps the element behind mediaElRef. An adapter keyed on kind
  // alone kept driving the detached old element — black stage, audio from a
  // node no longer in the document, and the sync engine correcting a player
  // nobody could see. Recreating on the flip binds the adapter to the element
  // that is actually mounted.
  useEffect(() => {
    if (adapterKind === 'native' && mediaElRef.current !== null) {
      const a = new NativeAdapter(mediaElRef.current);
      setAdapter(a);
      return () => {
        a.destroy();
        setAdapter(null);
      };
    }
    const el = embedContainerRef.current;
    if (adapterKind !== null && adapterKind !== 'native' && el !== null) {
      const a =
        adapterKind === 'youtube'
          ? new YouTubeAdapter(el)
          : adapterKind === 'soundcloud'
            ? new SoundCloudAdapter(el)
            : adapterKind === 'vimeo'
              ? new VimeoAdapter(el)
              : new EmbedAdapter(el);
      setAdapter(a);
      return () => {
        a.destroy();
        setAdapter(null);
      };
    }
    setAdapter(null);
    return undefined;
  }, [adapterKind, listen]);

  const mediaIdentity = useMemo(() => {
    if (mediaRef === null || mediaRef === undefined) return 'none';
    return mediaKey(mediaRef, undefined);
  }, [mediaRef]);

  /**
   * Identity of the ITEM on the stage — what the terminal latch and the
   * auto-advance guard below both hang on.
   *
   * NOT `mediaKey(mediaRef, playback.seq)`, which this used to be. `seq` is
   * minted by EVERY playback mutation (services/api sync/service.ts mutate():
   * play, pause, seek and rate all take a fresh one), not by a track change —
   * so a pause during the credits changed the key and cleared a latch whose
   * whole job is to say "this item is over here". The next play then restarted
   * a finished player and the room advanced a second time.
   *
   * `queueIndex` earns its place: the same media queued twice in a row is two
   * items, and `mediaIdentity` alone cannot tell them apart. What is left
   * uncovered is a `setTrack { kind: 'media' }` that re-sets the SAME ref with
   * no index — a replay of a one-off item, which carries nothing that
   * distinguishes it from the item already on the stage.
   */
  const trackKey = `${mediaIdentity}#${playback?.queueIndex ?? -1}`;

  /**
   * NOBODY IS ELECTED TO ADVANCE ANY MORE, and this is where the election used
   * to be: a presence roster, `isAdvancerClient` over the room's master seat
   * with a host fallback, and a staggered `sync.claimMaster` on mount to fill
   * the seat. All of it deleted.
   *
   * The seat was an inference — "who SHOULD advance this room" out of presence
   * plus role — and it was wrong in ordinary topologies. A host watching on
   * their phone beat presence every 15 s while mounting no advancer at all, so
   * they held the seat and the queue stopped. A host transfer left the seat
   * naming the old host. The claim gate here was narrower than the server's, so
   * the fallback it was supposed to cover was unreachable. Three patches, three
   * new ways to strand a room on a finished item.
   *
   * What replaced it is not a better inference, it is the absence of one: every
   * client reports the ending it saw, naming the item, and the server
   * compare-and-sets. See `advanceRef` below and lib/player/advance.ts.
   */

  // These two run FIRST on purpose: the subscribe/load pair below fires real
  // adapter events during the same commit, and a reset scheduled after them
  // would wipe the state those events just reported. A fresh player starts
  // un-ready ('ready' fires once per YouTube player, not once per video), and
  // every new track starts from "nothing is running here".
  useEffect(() => {
    setLocalReady(false);
    setLocalBuffering(false);
  }, [adapter]);
  useEffect(() => {
    setLocalPlaying(false);
    setPlayRefused(false);
    setStartStalled(false);
    setLoadFailed(false);
  }, [adapter, mediaIdentity]);
  /** Which item this client has already reported the end of. */
  const advancedKeyRef = useRef<string | null>(null);
  // The end latch and the advance guard belong to ONE ITEM, and only a new item
  // may clear them.
  //
  // CLEARED, not accumulated. The guard used to be a memo of every key it had
  // ever fired for, which meant a room that came BACK to an earlier item — a
  // replay, a queue reorder that restored a slot — could never leave it again,
  // because the key was already spent. Holding only the current item's key
  // keeps the de-duplication (a burst of 'ended' inside one commit still fires
  // once, without waiting for this effect) while leaving a later, legitimate
  // ending of the same item reportable.
  useEffect(() => {
    setLocalEnded(false);
    advancedKeyRef.current = null;
  }, [adapter, trackKey]);

  /**
   * Reporting the end, kept fresh in a ref so the subscription below stays
   * keyed on the adapter alone instead of re-arming on every queue or playback
   * change.
   */
  const advanceRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    advanceRef.current = (): void => {
      // ONE report per item, from any source. A local adapter can fire 'ended'
      // more than once (a correction landing on the end re-fires it), and the
      // extension deliberately does not de-duplicate at all
      // (apps/extension/src/background.ts, `case 'mediaEnded'`) because its
      // content script makes exactly one judgement per item.
      //
      // This is now tidiness rather than the last line of defence: a repeat
      // finds the room already off the item it names and the server drops it.
      // That is the same property that lets every client in the room fire this
      // without coordinating — which is why there is no advancer election here
      // any more.
      if (advancedKeyRef.current === trackKey) return;
      const endedItemId = endedQueueItemId({
        queueIndex: playback?.queueIndex ?? null,
        items: queueItems,
        mediaRef,
      });
      // null is a real answer: nothing in the queue matches what just ended, so
      // there is no item to move the room on from. See advance.ts.
      if (endedItemId === null) return;
      advancedKeyRef.current = trackKey;
      connection.syncAdvance(endedItemId);
    };
  });

  // Subscribed BEFORE the load below, or the adapters' first buffering edge
  // fires into an empty room and the server's wait-for-all never hears it.
  // Buffering reports drive that coordination; the same subscription tracks
  // what this device's player is really doing.
  useEffect(() => {
    if (adapter === null) return;
    const offs = [
      adapter.on('buffering', () => {
        setLocalBuffering(true);
        connection.syncBuffering(true);
      }),
      adapter.on('buffered', () => {
        setLocalBuffering(false);
        connection.syncBuffering(false);
      }),
      adapter.on('playing', () => {
        setLocalPlaying(true);
        setLocalBuffering(false);
        setPlayRefused(false);
      }),
      adapter.on('paused', () => setLocalPlaying(false)),
      // The source ran out. Latch it (nothing may restart a finished player)
      // and tell the room the item ended, so the queue can move on from it.
      adapter.on('ended', () => {
        setLocalPlaying(false);
        setLocalEnded(true);
        advanceRef.current();
      }),
      adapter.on('blocked', () => setPlayRefused(true)),
      // The one adapter event nothing on this page listened to. Every adapter
      // has emitted it since the interface was written (adapter.ts documents
      // it), and a failed load therefore left the stage on "Starting…" forever
      // AND left the room's wait-for-all holding for a member who is never
      // going to buffer — so the report and the release go together.
      adapter.on('error', () => {
        setLoadFailed(true);
        setLocalBuffering(false);
        setLocalPlaying(false);
        connection.syncBuffering(false);
      }),
      adapter.on('ready', () => {
        setLocalReady(true);
        if (adapter.kind === 'native') {
          const el = (adapter as NativeAdapter).mediaElement;
          setCaptionsAvailable(el.textTracks.length > 0);
        }
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [adapter, connection]);

  useEffect(() => {
    if (adapter === null || mediaRef === null) return;
    adapter.load(mediaRef);
  }, [adapter, mediaIdentity]);

  /**
   * THE SAME END, from the other driver. When the extension plays, this page
   * builds no adapter at all (see `adapterKind` above), so `adapter.on('ended')`
   * above can never fire and an extension-driven room used to run one item and
   * stop there forever — the extension reported the end, and nothing on this
   * side was listening.
   *
   * Subscribed unconditionally rather than only while `extension.driving`: the
   * bridge opens no port at all without an extension, and gating on a flag that
   * the end of an item can itself flip is how an end gets dropped.
   *
   * The payload names WHICH item ended, in the extension's own spelling, and it
   * has to match ours or we ignore it — a late end for something the room has
   * already moved past must not skip the item now playing. `advanceRef` then
   * de-duplicates per item, which is load-bearing here because nothing upstream
   * does.
   */
  const extensionKey = extensionMediaKey(mediaRef);
  useEffect(() => {
    return onEnded((ended) => {
      if (extensionKey === null || ended.mediaKey !== extensionKey) return;
      setLocalPlaying(false);
      setLocalEnded(true);
      advanceRef.current();
    });
  }, [extensionKey]);

  useSyncEngine({
    adapter: isFullSyncKind(adapterKind) ? adapter : null,
    playback,
    clock: connection.clock,
    onDriftSample: debug ? setDriftMs : undefined,
  });

  const wantsPlay = playback?.playing === true;
  /** Transport exists for this media at all (approximate-tier embeds have no
   *  play/pause we can drive, so none of the recovery below applies to them). */
  const fullSync = isFullSyncKind(adapterKind);

  // The sync engine snaps play/pause once per track change — but iframe player
  // APIs load asynchronously, so that snap can land while the player is still
  // a stub and be silently dropped. That is what leaves YouTube sitting in its
  // unstarted state behind its own centre overlay. Re-assert once the player
  // is genuinely usable.
  //
  // NOT once it has finished. `ended` clears localPlaying while the room still
  // says playing, so without the latch this fires instantly — and playVideo()
  // on an ENDED YouTube player restarts it from 0 (HTMLMediaElement.play() does
  // the same per spec, so a queued .mp4 looped identically). This effect exists
  // to rescue a stub that dropped a play command, never to resurrect an item
  // that is over.
  useEffect(() => {
    if (adapter === null || !fullSync || !localReady || !wantsPlay || localPlaying || localEnded)
      return;
    adapter.play();
  }, [adapter, fullSync, localReady, wantsPlay, localPlaying, localEnded, startAttempt]);

  // Autoplay reality (UX_OVERHAUL B2): browsers refuse playback nobody asked
  // for. NativeAdapter/VimeoAdapter report the refusal outright; the iframe
  // widgets can only be caught by noticing that a ready, un-buffering player
  // still is not running a beat after the room said play.
  // A player that has FINISHED is also ready, un-buffering and not running, so
  // it trips this watchdog too — and a follower waiting out the last seconds of
  // the room's copy would be told its browser refused to start. It did not.
  useEffect(() => {
    if (!fullSync || !wantsPlay || !localReady || localPlaying || localBuffering || localEnded) {
      setStartStalled(false);
      return undefined;
    }
    const h = setTimeout(() => setStartStalled(true), 1500);
    return () => clearTimeout(h);
  }, [
    fullSync,
    wantsPlay,
    localReady,
    localPlaying,
    localBuffering,
    localEnded,
    mediaIdentity,
    startAttempt,
  ]);

  /** Are we driving a player on this device at all? True for every full-sync
   *  source, music or video — it is what decides whether a refused start is
   *  worth recovering, independent of who draws the surface. Not while a
   *  member's screen share holds the stage, and not for approximate-tier
   *  embeds (their iframe is the only control they have). */
  const drivenSurface = !shareOnStage && playback !== null && mediaRef !== null && fullSync;

  /** Is there provider chrome on screen for us to shield? Only while video
   *  plays: a music item shows the artwork hero and keeps the provider's
   *  iframe mounted but invisible behind it, so there is nothing to cover —
   *  and a shield there would hide the very identity the hero is for. */
  const providerSurface = drivenSurface && !listen;

  /** A music item's full-sync provider: audible, never visible. Native audio
   *  is excluded because its element is already offscreen, and approximate
   *  embeds because their iframe is the only control surface they have. */
  const providerAudioOnly = listen && fullSync && adapterKind !== 'native';

  const gate = stageGate({
    active: drivenSurface,
    wantsPlay,
    localPlaying,
    blocked: playRefused || startStalled,
  });

  /**
   * The gap between two items (C11). `gate` already owns the two waits that
   * have their own affordance — the room is paused, or this browser refused to
   * start — so what is left over a video surface is exactly: the room is
   * playing this item and our player has not begun it. Across a kind change
   * that is the whole adapter teardown and rebuild, which showed the bare void.
   *
   * Video only. A music item's hero is already a picture of what is coming, and
   * an approximate-tier embed never reports playing at all, so a wait keyed on
   * `localPlaying` would sit on it forever.
   */
  const cueing = providerSurface && gate === 'none' && !localPlaying && !localEnded && !loadFailed;

  /** …and the failure itself, which is not a wait at all. Same slot, same
   *  precedence rules: below the shield, and only where we were driving. */
  const failed = drivenSurface && loadFailed && !localPlaying;

  /** Nothing is on this stage at all — not a share, not the extension, not an
   *  item. The one state that gets the aurora bloom, and the one that gets the
   *  display step, because it is also the only one with nothing to lose it to. */
  const idle = !shareOnStage && !extensionDriving && mediaRef === null;

  /** A pasted link with no extension to play it. `adapterKindFor` returns null
   *  for a page ref on purpose, so nothing else on this stage claims the space. */
  const pageRef = mediaRef !== null && mediaRef.kind === 'page' ? mediaRef : null;
  /**
   * Where "Add the extension" goes, or null where offering an install would be
   * a lie: the extension is already here, or this browser could never run it
   * (the driver leaves `installUrl` null there on purpose). Everywhere else
   * there is always somewhere honest to send people — the driver's own answer,
   * or `extensionInstallUrl()` while detection is still running, both of which
   * bottom out at the app's own /extension page.
   */
  const extensionInstall =
    extension.state.phase === 'unavailable' || extension.state.phase === 'incompatible'
      ? extension.state.installUrl
      : extension.state.phase === 'detecting'
        ? extensionInstallUrl()
        : null;
  const extensionNote = pageItemNote(extension.state);
  const gateStatus = gateStatusFor(extension.state);
  /**
   * When the gate below carries an install action of its own, the poster hands
   * the conversation over instead of repeating it: one offer, one gradient in
   * the region (DESIGN.md §2). 'detecting' and 'unsupported-browser' render an
   * actionless gate, so the poster keeps its link there.
   */
  const gateOwnsInstall = gateStatus === 'not-installed' || gateStatus === 'incompatible';

  /**
   * Phones and tablets never see the gate: its mobile branch funnels to an app
   * with no store listing, and a dead app link violates the gate's own rule.
   * Settled in an effect, not during render — the server pass has no browser
   * to sniff (same order `useFullscreen.supported` settles in), so SSR and the
   * first client paint agree on the desktop shape and hydration corrects it.
   */
  const [handheld, setHandheld] = useState(false);
  useEffect(() => {
    setHandheld(isHandheldBrowser());
  }, []);

  /** The stage's one action: recover a refused start locally, or drive the
   *  room's transport under the same policy gate as the keyboard map. */
  const activateStage = useCallback((): void => {
    if (adapter === null || playback === null) return;
    if (gate === 'blocked') {
      // This click IS the gesture the browser was holding out for; the drift
      // engine puts us back on the room's position within a tick.
      setPlayRefused(false);
      setStartStalled(false);
      setStartAttempt((n) => n + 1);
      adapter.play();
      return;
    }
    if (!controlEnabled) return;
    if (playback.playing) connection.syncPause(adapter.positionMs());
    else connection.syncPlay(adapter.positionMs());
  }, [adapter, playback, gate, controlEnabled, connection]);

  // Captions: HLS text tracks rendered by the element itself (§9).
  useEffect(() => {
    if (adapter === null || adapter.kind !== 'native') return;
    const el = (adapter as NativeAdapter).mediaElement;
    for (let i = 0; i < el.textTracks.length; i += 1) {
      const track = el.textTracks[i];
      if (track !== undefined) track.mode = captionsOn ? 'showing' : 'hidden';
    }
  }, [adapter, captionsOn, captionsAvailable]);

  // ── MediaSession (lock-screen / OS transport, spec §Casting & output) ──
  const currentItem =
    playback?.queueIndex !== null && playback?.queueIndex !== undefined
      ? queueItems[playback.queueIndex]
      : undefined;
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentItem?.title ?? room.name,
      artist: `${room.name} · Gather`,
      ...(currentItem?.artworkUrl != null
        ? { artwork: [{ src: currentItem.artworkUrl }] }
        : {}),
    });
    navigator.mediaSession.playbackState = wantsPlay ? 'playing' : 'paused';
    // Handlers are registered even for members who may not drive playback:
    // a registered no-op keeps the OS from playing the element locally and
    // desyncing them. The policy check mirrors the keyboard map exactly.
    navigator.mediaSession.setActionHandler('play', () => {
      if (controlEnabled) connection.syncPlay(adapter?.positionMs());
    });
    navigator.mediaSession.setActionHandler('pause', () => {
      if (controlEnabled) connection.syncPause(adapter?.positionMs());
    });
    navigator.mediaSession.setActionHandler('seekto', (d) => {
      if (controlEnabled && typeof d.seekTime === 'number')
        connection.syncSeek(Math.round(d.seekTime * 1000));
    });
    return () => {
      navigator.mediaSession.setActionHandler('play', null);
      navigator.mediaSession.setActionHandler('pause', null);
      navigator.mediaSession.setActionHandler('seekto', null);
    };
  }, [
    connection,
    adapter,
    controlEnabled,
    wantsPlay,
    currentItem?.title,
    currentItem?.artworkUrl,
    room.name,
  ]);

  // ── chrome auto-hide: 3 s of stillness (§7), but never while the stage is
  //    gated — the transport bar must stay visible next to the centre ring ──
  const wakeChrome = useCallback(() => setChromeAwake(true), []);
  useEffect(() => {
    if (!chromeAwake || gate !== 'none') return;
    const h = setTimeout(() => setChromeAwake(false), 3000);
    return () => clearTimeout(h);
  }, [chromeAwake, gate]);
  const chromeVisible = chromeAwake || gate !== 'none';

  // ── keyboard map (§9) ──
  useKeyboardShortcuts(
    useMemo(
      () => [
        { key: ' ', handler: activateStage },
        {
          key: 'ArrowLeft',
          handler: () => {
            if (controlEnabled && adapter !== null)
              connection.syncSeek(Math.max(0, Math.round(adapter.positionMs() - 10_000)));
          },
        },
        {
          key: 'ArrowRight',
          handler: () => {
            if (controlEnabled && adapter !== null)
              connection.syncSeek(Math.round(adapter.positionMs() + 10_000));
          },
        },
        {
          key: 'm',
          handler: () => {
            const next = !muted;
            adapter?.setMuted(next);
            setMuted(next);
          },
        },
        {
          key: 'c',
          handler: () => {
            if (captionsAvailable) setCaptionsOn((v) => !v);
          },
        },
        // F is the immersive mode (D1.1) — this viewer's own screen, so it is
        // never policy-gated the way the transport is: a guest who may not
        // press play may still fill their own display. It is not gated on
        // fullscreen support either, because the mode is the LAYOUT and works
        // where the platform cannot fullscreen (iOS Safari).
        {
          key: 'f',
          handler: toggleImmersive,
        },
        // Escape leaves the mode — but only where the browser is not already
        // doing exactly that. While the top layer is up, Escape is the
        // browser's own exit and reaches us as `fullscreenchange` (the sync
        // effect above), and a second handler would double-handle it. The
        // binding exists at all only for the layout-without-top-layer case,
        // so dialogs and sheets keep their Escape everywhere else.
        ...(immersive && !fullscreen.active
          ? [
              {
                key: 'Escape',
                handler: () => setImmersive(false),
              },
            ]
          : []),
      ],
      [
        activateStage,
        controlEnabled,
        adapter,
        connection,
        muted,
        captionsAvailable,
        immersive,
        fullscreen.active,
      ],
    ),
  );

  const glow = useAmbientGlow(adapter, playback?.playing === true, reduced);
  const pulseKey = playback?.seq ?? 0;

  /** One transport, mounted in one of two places: floating over a video item,
   *  or inline under a music item's hero (there is no moving picture there
   *  for it to get out of the way of). */
  const transportNode =
    !shareOnStage && playback !== null && adapterKind !== 'embed' ? (
      <PlayerControls
        adapter={adapter}
        playback={playback}
        enabled={controlEnabled}
        captionsOn={captionsOn}
        onToggleCaptions={() => setCaptionsOn((v) => !v)}
        captionsAvailable={captionsAvailable && adapter?.kind === 'native'}
        muted={muted}
        onMutedChange={setMuted}
        // The control reports and drives the MODE, not the raw top layer —
        // and it is offered even where the platform cannot fullscreen,
        // because the immersive layout is the mode and works there too.
        fullscreenActive={immersive}
        onToggleFullscreen={toggleImmersive}
      />
    ) : null;

  return (
    <section
      ref={stageRef}
      aria-label="Stage"
      data-room={roomId}
      className="relative flex h-full w-full flex-col overflow-hidden bg-void"
      onMouseMove={wakeChrome}
      onFocus={wakeChrome}
    >
      {/* Ambient light: a slow aurora wash, the colour sampled off the picture
          when there is one, and — when there is NOTHING on the stage — the
          bloom that makes signature moment §5.1 visible in the state every room
          shows first. An empty room is the only screen in the product with
          nothing to compete with the nebula, so it is the only one that gets to
          see it. Both values are measured; see the constants at the top. */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div
          className={cn('absolute inset-[-20%]', !reduced && 'animate-aurora-drift')}
          style={{
            opacity: AMBIENT_AURORA_OPACITY,
            background:
              'conic-gradient(from 0deg, var(--aurora-1), var(--aurora-2), var(--aurora-3), var(--aurora-1))',
          }}
        />
        {idle && (
          <div
            className="absolute inset-0"
            style={{
              background: `radial-gradient(58% 54% at 50% 46%, color-mix(in oklch, var(--aurora-2) ${String(
                IDLE_BLOOM_OPACITY * 100,
              )}%, transparent), transparent 72%)`,
            }}
          />
        )}
        {glow !== null && (
          <div
            className="absolute inset-0 transition-[background] duration-[800ms]"
            style={{
              background: `radial-gradient(60% 60% at 50% 45%, ${glow}33, transparent 70%)`,
            }}
          />
        )}
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center">
        {shareOnStage ? (
          <>
            <ScreenShareStage restream={restream} />
            {/* The transport bar is deliberately withheld during a share, and
                the fullscreen control lived in it — so the one moment a whole
                screen is exactly what a viewer wants was the one moment the
                button did not exist. The `f` binding worked the entire time;
                a key nobody is told about is not an affordance. Glass, because
                this genuinely floats over moving video (DESIGN.md §4).
                It drives the MODE, so it is no longer gated on the platform
                fullscreen API — the immersive layout works without one. */}
            <div className="absolute right-4 top-14 z-20">
              <Tooltip
                content={immersive ? 'Exit fullscreen (F)' : 'Fullscreen (F)'}
                align="end"
              >
                <Button
                  variant="ghost"
                  size="icon"
                  aria-pressed={immersive}
                  aria-label={immersive ? 'Exit fullscreen' : 'Fullscreen'}
                  onClick={toggleImmersive}
                  className="glass-panel"
                >
                  <TheaterIcon size={16} />
                </Button>
              </Tooltip>
            </div>
          </>
        ) : extensionDriving ? (
          <ExtensionDrivingStage
            provider={extension.state.phase === 'ready' ? extension.state.provider : null}
            playing={wantsPlay}
          />
        ) : (
          <>
            {/* All iframe adapters share one mount point. Full-sync providers
                (YouTube/SoundCloud/Vimeo) are INERT — pointer-events-none here,
                plus the adapters neutralise the iframe itself, plus the
                StageShield below owns every click — so the room's own transport
                is the only control surface. Approximate-tier embeds
                (Spotify/Apple/Tidal/Deezer) stay interactive because their
                iframe is the only control surface that exists. */}
            <div
              className={cn(
                'h-full w-full',
                adapterKind !== null && adapterKind !== 'native'
                  ? 'flex items-center justify-center'
                  : 'hidden',
                // For a music item a full-sync provider is an audio source, not
                // a picture. Its iframe stays mounted and playing but invisible
                // behind the hero — opacity rather than `hidden`, because
                // display:none suspends these players in some browsers.
                // `absolute` and `relative` are mutually exclusive here on
                // purpose: cn() is a plain joiner, and Tailwind emits
                // `.relative` after `.absolute`, so emitting both loses.
                providerAudioOnly
                  ? 'pointer-events-none absolute inset-0 opacity-0'
                  : 'relative',
              )}
            >
              <div
                ref={embedContainerRef}
                className={cn(
                  'aspect-video max-h-full w-full',
                  adapterKind !== 'embed' && 'pointer-events-none',
                )}
              />
              {adapterKind === 'embed' && (
                // Glass and tokens, not `bg-black/60` + `text-white/90`: this
                // chip floats over a running third-party player, which is the
                // one thing §4 reserves glass FOR, and a Tailwind black is a
                // colour literal wherever it is written (§10).
                <span className="glass-raised absolute bottom-3 left-1/2 max-w-[90%] -translate-x-1/2 rounded-pill px-3 py-1 text-center text-label text-hi">
                  Approximate sync — this service plays in its own player on each device
                </span>
              )}
            </div>
            {listen ? (
              <div
                className={cn(
                  'relative h-full w-full',
                  // Approximate-tier embeds keep their own visible player; every
                  // other music source plays behind the hero.
                  adapterKind === 'embed' ? 'hidden' : '',
                )}
              >
                <ListenStage
                  adapter={adapter}
                  currentItem={currentItem}
                  playing={playback?.playing === true}
                  queueItems={queueItems}
                  currentIndex={playback?.queueIndex ?? null}
                  blocked={gate === 'blocked'}
                  onActivate={activateStage}
                  {...(transportNode !== null ? { transport: transportNode } : {})}
                />
                {/* The audio element is the real player — visualizer taps it.
                    No crossOrigin here either: see the note on the video
                    element below, and ListenStage's own same-origin guard. */}
                <video ref={mediaElRef} className="hidden" playsInline />
              </div>
            ) : (
              /* NO crossOrigin. It was `anonymous`, unconditionally, on both
                 media elements — and `crossOrigin` does not mean "please use
                 CORS if you can": it makes the fetch a CORS request outright,
                 so every direct .mp4 and .mp3 from a host that does not send
                 Access-Control-Allow-Origin — most of the web — failed to load
                 at all. A black stage.

                 What it bought was canvas sampling of CROSS-ORIGIN video for
                 the ambient glow, which is decoration with a documented aurora
                 fallback (useAmbientGlow catches the taint), so the trade was
                 playing nothing in order to tint something. Same-origin media
                 samples cleanly with no attribute at all, which is where the
                 glow keeps working; everywhere else it falls back, exactly as
                 that function already said it would. */
              <video
                ref={mediaElRef}
                playsInline
                className={cn(
                  // `bg-void`, never Tailwind's black: the ground under a
                  // letterboxed picture is a palette decision like every other.
                  // `rounded-stage` is the 28px rung §4 names "the stage frame"
                  // — and it comes off in the immersive mode, where the picture
                  // IS the screen and a rounded corner is a bezel we invented
                  // (with or without the top layer: the layout is the mode).
                  // The two are a ternary because `cn` joins and does not
                  // resolve.
                  'max-h-full max-w-full bg-void',
                  immersive || fullscreen.active ? '' : 'rounded-stage',
                  adapterKind === 'native' ? '' : 'hidden',
                )}
                aria-label="Shared video"
              />
            )}
            {mediaRef === null && <EmptyStage />}
            {pageRef !== null && (
              /* The page-kind branch is the ONE place the install funnel
                 mounts (docs/FEATURE_PLAN.md §9 amendments): every other kind
                 still plays through this page's own adapters until
                 WEB_SLIMMING step 4 actually executes, so a gate anywhere
                 wider would block playback that works. Column layout: the
                 poster explains the item, the gate below it owns the install
                 conversation — and only where the driver is not ready, on a
                 browser that could ever hold an extension. */
              <div className="flex h-full min-h-0 w-full flex-col">
                <PageLinkStage
                  url={pageRef.url}
                  title={currentItem?.title ?? null}
                  installUrl={gateOwnsInstall && !handheld ? null : extensionInstall}
                  note={extensionNote}
                  installHandledBelow={gateOwnsInstall && !handheld}
                />
                {gateStatus !== null && !handheld && (
                  <ExtensionGate
                    status={gateStatus}
                    platform="desktop"
                    installUrl={extensionInstall ?? extensionInstallUrl()}
                    appUrl={EXTENSION_DOCS_PATH}
                    onRecheck={extension.refresh}
                    recheckPending={extension.checking}
                  />
                )}
              </div>
            )}
            {/* The item is on its way. Below the shield (z-10) and inert, so
                the one play affordance stays the one play affordance; keyed on
                the item so consecutive track changes each get the transition
                rather than one long-lived element that animates once. */}
            {cueing && (
              <div key={mediaIdentity} className="pointer-events-none absolute inset-0 z-0">
                <CueingStage title={currentItem?.title ?? null} />
              </div>
            )}
            {failed && (
              // Opaque, and at the shield's own layer. There is nothing behind
              // this worth seeing — a dead player, or (in a listen room) an
              // artwork hero whose own z-10 content would otherwise bury the
              // one sentence explaining why nothing is coming out of it.
              // Inert, so the transport above it stays reachable.
              <div className="pointer-events-none absolute inset-0 z-10 bg-surface-0">
                <LoadFailedStage title={currentItem?.title ?? null} />
              </div>
            )}
            {/* One shield over every full-sync provider: the provider's own
                play overlay is unreachable, and while we are paused or the
                browser refused to start, invisible too. */}
            {providerSurface && (
              <StageShield
                gate={gate}
                title={currentItem?.title ?? null}
                listen={listen}
                canControl={controlEnabled}
                onActivate={activateStage}
              />
            )}
          </>
        )}
        <SyncPulse pulseKey={pulseKey} />
        <EmoteOverlay />
      </div>

      {/* waiting-for-all honesty + the live media-path badge + share entry.
          The badge is the SHELL's node (see the prop): it renders the same
          live truth, in the same words, as the call rail — the static
          "Private · device-to-device" architectural claim that used to sit
          here contradicted the rail's live "Private · direct" one panel over,
          and nothing at all is rendered when no link is flowing. */}
      <div className="pointer-events-none absolute right-4 top-4 z-20 flex flex-col items-end gap-2">
        {pathBadge}
        {waitingOn.length > 0 && (
          <Badge variant="default" className="pointer-events-auto">
            Waiting for {waitingOn.length} to buffer…
          </Badge>
        )}
        {!shareOnStage && (
          <Button
            variant="secondary"
            size="sm"
            className="pointer-events-auto"
            onClick={() => {
              // Dialogs portal to document.body (components/ui/dialog.tsx) and
              // the fullscreen top layer paints over the entire document, so a
              // dialog opened from inside fullscreen is simply not on screen.
              // The gesture that asks for it leaves fullscreen first — and
              // arms the latch above so the immersive LAYOUT survives the
              // round trip.
              if (fullscreen.active) dialogExitRef.current = true;
              fullscreen.exit();
              setShareOpen(true);
            }}
          >
            Share screen
          </Button>
        )}
      </div>

      {/* Transport chrome. Video floats it over the picture and lets it fade
          with the rest of the chrome; music mounts the same control inline
          under the hero instead, so it must not also appear here. */}
      {!listen && transportNode !== null && (
        <div
          className={cn(
            'absolute inset-x-4 bottom-4 z-20 transition-opacity duration-300',
            chromeVisible ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
        >
          {transportNode}
        </div>
      )}

      {/* The immersive chrome (exit, call pills, chat sidebar) — inside the
          section, because the fullscreen top layer paints over everything
          else. The shell mounts it only while the mode is on. */}
      {overlay}

      {debug && (
        <div className="glass-raised absolute bottom-4 left-4 z-20 rounded-ctl px-2 py-1 font-mono text-xs text-low">
          drift {Math.round(driftMs)}ms · seq {playback?.seq ?? 0} ·{' '}
          {adapter?.kind ?? 'no-adapter'}
        </div>
      )}

      {/* Screen-share hosting entry (when no one is sharing) */}
      <Dialog
        open={shareOpen}
        onOpenChange={(open) => {
          setShareOpen(open);
          // The dialog borrowed the screen from fullscreen; give it back.
          // Guarded on the mode so a share dialog opened from the windowed
          // layout never fullscreens anything.
          if (!open && immersive && fullscreen.supported && !fullscreen.active) {
            fullscreen.toggle();
          }
        }}
      >
        <DialogContent aria-label="Share your screen">
          <DialogTitle>Share your screen</DialogTitle>
          <ScreenShareStage
            restream={
              restream ?? {
                active: false,
                hostUserId: null,
                startedAt: null,
                viewerCount: 0,
                uplinkQuality: null,
              }
            }
          />
        </DialogContent>
      </Dialog>
    </section>
  );
}
