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
import type { ReactNode } from 'react';
import { motion } from '@gather/design';
import type { RoomId, UserId } from '@gather/contracts';
import { useRoom, useRoomConnection } from '@/lib/room-context';
import { RELAY_LABEL } from '@/lib/labels';
import { canAct } from '@/lib/permissions';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { adapterKindFor, isFullSyncKind, mediaKey, stageGate } from '@/lib/player/adapter';
import {
  isAdvancerClient,
  masterClaimDelayMs,
  masterClaimEpoch,
  masterSeatVacant,
  nextTrackOnEnd,
} from '@/lib/player/advance';
import { mediaKindFor } from '@/lib/media-kind';
import type { PlayerAdapter, StageGate } from '@/lib/player/adapter';
import { NativeAdapter } from '@/lib/player/native';
import { YouTubeAdapter } from '@/lib/player/youtube';
import { SoundCloudAdapter } from '@/lib/player/soundcloud';
import { VimeoAdapter } from '@/lib/player/vimeo';
import { EmbedAdapter } from '@/lib/player/embed';
import { useSyncEngine } from '@/lib/player/useSyncEngine';
import { useExtensionDriver } from '@/lib/player/extension-driver';
import { extensionMediaKey, onEnded } from '@/lib/extension-bridge';
import { API_URL, getAccessToken } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PlayIcon } from '@/components/ui/icons';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/cn';
import { EmoteOverlay } from './EmoteOverlay';
import { ListenStage } from './ListenStage';
import { PlayerControls } from './PlayerControls';
import { ScreenShareStage } from './ScreenShareStage';

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
        'pointer-events-none absolute inset-0 z-10 m-auto h-24 w-24 rounded-full border-2 border-aurora-2',
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
          'absolute inset-0 flex flex-col items-center justify-center gap-4 bg-surface-0 px-6 text-center',
          !reduced && 'animate-fade-in',
        )}
      >
        {title !== null && title !== '' && (
          <span className="line-clamp-2 max-w-lg text-title text-hi">{title}</span>
        )}
        {actionable && (
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-surface-2 text-hi shadow-glow">
            <PlayIcon size={24} />
          </span>
        )}
        <span className="text-label text-low">{hint}</span>
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
        'flex h-full w-full flex-col items-center justify-center gap-2 p-8 text-center',
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

/** Anchors the stage offers as actions. Same shape as ListenStage's own
 *  "Tap to start listening together" control, because they are the same kind of
 *  thing: one calm affordance on a stage with no picture on it. */
const STAGE_LINK_CLASS =
  'glass-raised inline-flex items-center rounded-ctl px-3 py-2 text-body text-hi transition-colors hover:text-accent';

/** An empty room promises nothing — the stage decides when media plays. */
function EmptyStage() {
  return (
    <StageMessage>
      <p className="font-display text-lg font-semibold text-mid">Nothing playing yet</p>
      <p className="max-w-sm text-sm text-low">
        Add to the queue from the Queue tab — everyone’s player follows along.
      </p>
    </StageMessage>
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
    <StageMessage>
      {title !== null && title !== '' && (
        <p className="line-clamp-2 max-w-lg text-title text-hi">{title}</p>
      )}
      <p className="text-label text-low">Starting…</p>
    </StageMessage>
  );
}

/**
 * A `page` item on a browser that cannot play one.
 *
 * The queue accepts ANY link — that is the promise QueuePane makes at the
 * paste box — but a page is a LINK, not media bytes: only the extension can
 * play it, by driving whatever video the page itself mounts, in the viewer's
 * own tab. `adapterKindFor` correctly refuses to build a player for one, and
 * until now NOTHING rendered in its place: a completely blank stage, no
 * message, no controls, no explanation, directly contradicting what the queue
 * had just promised.
 *
 * Both ways out are offered because both are real: add the extension and it
 * plays here in time with the room, or open the link and watch it on your own.
 */
function PageLinkStage({
  url,
  title,
  installUrl,
}: {
  url: string;
  title: string | null;
  /** Null when this browser cannot install the extension at all, or already
   *  has it — either way there is nothing to send anyone to. */
  installUrl: string | null;
}) {
  return (
    <StageMessage>
      {title !== null && title !== '' && (
        <p className="line-clamp-2 max-w-lg text-title text-hi">{title}</p>
      )}
      <p className="max-w-sm text-sm text-low">
        This one is a link to a page, and the Gather extension is what plays those — in
        your own browser, in time with everyone.
      </p>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
        {installUrl !== null && (
          <a
            href={installUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={STAGE_LINK_CLASS}
          >
            Add the extension
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        )}
        <a href={url} target="_blank" rel="noopener noreferrer" className={STAGE_LINK_CLASS}>
          Open the link
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      </div>
    </StageMessage>
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
    <StageMessage>
      {title !== null && title !== '' && (
        <p className="line-clamp-2 max-w-lg text-title text-hi">{title}</p>
      )}
      <p className="max-w-sm text-sm text-low">
        This didn’t load on your device. Everyone else is unaffected, and the next item
        starts fresh.
      </p>
    </StageMessage>
  );
}

/**
 * What the stage says while the extension is the one playing. The video is in
 * the user's own tab on the content site, so this space explains where it went
 * rather than pretending to be a player — the room's transport, chat, queue and
 * call all keep working here.
 */
function ExtensionDrivingStage({ providerName }: { providerName: string | null }) {
  return (
    <StageMessage>
      <p className="font-display text-lg font-semibold text-mid">
        {providerName === null ? 'Playing in your other tab' : `Playing on ${providerName}`}
      </p>
      <p className="max-w-sm text-sm text-low">
        Everyone stays on the same second. Play, pause and skip from here or from the
        tab — the room follows either way.
      </p>
    </StageMessage>
  );
}

export function StagePane({ roomId }: { roomId: RoomId }) {
  const connection = useRoomConnection();
  const { room, member } = useRoom();
  const playback = connection.useRoomState((s) => s.playback);
  const restream = connection.useRoomState((s) => s.restream);
  const waitingOn = connection.useRoomState((s) => s.waitingOn);
  const queueItems = connection.useRoomState((s) => s.queue.items);
  const master = connection.useRoomState((s) => s.master);
  const presence = connection.useRoomState((s) => s.presence);
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

  /** Everyone the room lists as here. Derived through a key rather than
   *  straight into an array so its IDENTITY tracks the set: presence churns on
   *  every mic toggle, and a fresh array on each of those would re-arm the
   *  claim timer below forever and never let it fire. */
  const presentKey = useMemo(() => {
    const ids: string[] = [];
    for (const entry of Object.values(presence)) {
      if (entry.state !== 'offline') ids.push(entry.userId);
    }
    return ids.sort().join(' ');
  }, [presence]);
  const presentUserIds = useMemo(
    () => (presentKey === '' ? [] : (presentKey.split(' ') as UserId[])),
    [presentKey],
  );
  /**
   * WHO ADVANCES THE QUEUE. Elastic sync leaves viewers deliberately out of
   * step by up to ~15 s, so in an N-person room the item ends at N different
   * moments. If every client advanced, whoever reached the credits first would
   * yank everyone still ten seconds out into the next item. Exactly ONE client
   * advances; the rest follow the setTrack it sends — which is correct, because
   * a track change is HOST INTENT (docs/EXTENSION_FIRST.md Part 1) and applies
   * immediately and unbanded, while drift correction stays comfort-banded.
   *
   * The predicate must name ONE client, never "anyone permitted to": the room's
   * playbackControl policy can be 'everyone', which would re-open the race. So
   * it is the room's master seat — server-elected by compare-and-set — with the
   * old host rule as the fallback that covers the moment before the seat is
   * filled. See lib/player/advance.ts for why the seat and not the roster.
   */
  const isAdvancer = isAdvancerClient({
    selfUserId: member.userId,
    selfIsHost: member.role === 'host',
    master,
    presentUserIds,
  });

  /**
   * CLAIMING THE SEAT. Nothing anywhere sent sync.claimMaster, so the seat the
   * server was built to arbitrate stayed empty forever and the fallback was the
   * whole election. A mounted StagePane is by definition a client that CAN
   * advance — it holds both 'ended' subscriptions, the adapter's and the
   * extension bridge's — so it is a legitimate candidate, and it says so.
   *
   * Claimed on mount rather than at the end of an item: the seat has to be
   * settled BEFORE the credits, and a claim landing in the last second would
   * change the advancer mid-decision.
   *
   * The send is guarded because it is a courtesy, not the feature: a socket
   * that has not opened yet throws outright, and losing a claim only means the
   * fallback keeps deciding.
   */
  useEffect(() => {
    // Only a client that may actually DRIVE may take the seat. The seat makes
    // its holder the SOLE advancer and every other tab stands down, so a seat
    // held by someone the policy forbids is strictly worse than an empty one:
    // their setTrack is refused and nobody else tries. In a default 'host'
    // room the first guest to mount used to win it and the queue never moved
    // again. The server enforces the same predicate on the claim; this is the
    // half that stops the pointless round trip.
    if (!controlEnabled) return undefined;
    if (!masterSeatVacant({ master, presentUserIds })) return undefined;
    const epoch = masterClaimEpoch(master);
    const handle = setTimeout(
      () => {
        // Re-read the seat at the last moment: an earlier candidate's claim may
        // have landed while this one was waiting its turn.
        if (!masterSeatVacant({ master: connection.useRoomState.getState().master, presentUserIds }))
          return;
        try {
          connection.rawSocket.send('sync.claimMaster', { epoch });
        } catch {
          // No socket yet. The fallback advancer still decides, and the next
          // roster change re-arms this.
        }
      },
      masterClaimDelayMs({ selfUserId: member.userId, presentUserIds }),
    );
    return () => clearTimeout(handle);
  }, [connection, master, presentUserIds, member.userId, controlEnabled]);

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
  // The end latch belongs to ONE ITEM, and only a new item may clear it.
  useEffect(() => {
    setLocalEnded(false);
  }, [adapter, trackKey]);

  /**
   * The auto-advance decision, kept fresh in a ref so the subscription below
   * stays keyed on the adapter alone instead of re-arming on every queue or
   * playback change.
   */
  const advanceRef = useRef<() => void>(() => undefined);
  const advancedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    advanceRef.current = (): void => {
      // ONE end per item, from any source. A local adapter can fire 'ended'
      // more than once (a correction landing on the end re-fires it), and the
      // extension deliberately does not de-duplicate at all
      // (apps/extension/src/background.ts, `case 'mediaEnded'`) because its
      // content script makes exactly one judgement per item — which makes this
      // guard, keyed on the item rather than the playback epoch, the only
      // thing standing between a room and a double skip.
      if (advancedKeyRef.current === trackKey) return;
      const next = nextTrackOnEnd({
        queueIndex: playback?.queueIndex ?? null,
        items: queueItems,
        mediaRef,
        isAdvancer,
      });
      // null is a real answer at the end of the queue: let the room stop.
      if (next === null) return;
      advancedKeyRef.current = trackKey;
      connection.syncSetTrackByQueue(next.index);
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
      // and, on the one designated client, hand the room the next item.
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

  /** A pasted link with no extension to play it. `adapterKindFor` returns null
   *  for a page ref on purpose, so nothing else on this stage claims the space. */
  const pageRef = mediaRef !== null && mediaRef.kind === 'page' ? mediaRef : null;
  const extensionInstall =
    extension.state.phase === 'unavailable' || extension.state.phase === 'incompatible'
      ? extension.state.installUrl
      : null;

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
      ],
      [activateStage, controlEnabled, adapter, connection, muted, captionsAvailable],
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
      />
    ) : null;

  return (
    <section
      aria-label="Stage"
      data-room={roomId}
      className="relative flex h-full w-full flex-col overflow-hidden bg-void"
      onMouseMove={wakeChrome}
      onFocus={wakeChrome}
    >
      {/* Ambient glow: sampled media color over a slow aurora wash (§5.1, §5.5) */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div
          className={cn(
            'absolute inset-[-20%] opacity-[0.06]',
            !reduced && 'animate-aurora-drift',
          )}
          style={{
            background:
              'conic-gradient(from 0deg, var(--aurora-1), var(--aurora-2), var(--aurora-3), var(--aurora-1))',
          }}
        />
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
          <ScreenShareStage restream={restream} />
        ) : extensionDriving ? (
          <ExtensionDrivingStage
            providerName={
              extension.state.phase === 'ready' ? (extension.state.provider?.name ?? null) : null
            }
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
                <span className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-[10px] text-white/90">
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
                  'max-h-full max-w-full bg-black',
                  adapterKind === 'native' ? '' : 'hidden',
                )}
                aria-label="Shared video"
              />
            )}
            {mediaRef === null && <EmptyStage />}
            {pageRef !== null && (
              <PageLinkStage
                url={pageRef.url}
                title={currentItem?.title ?? null}
                installUrl={extensionInstall}
              />
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

      {/* waiting-for-all honesty + relay badge + screen-share entry */}
      <div className="pointer-events-none absolute right-4 top-4 z-20 flex flex-col items-end gap-2">
        <Badge variant="muted" className="pointer-events-auto">
          {RELAY_LABEL[room.relayMode]}
        </Badge>
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
            onClick={() => setShareOpen(true)}
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

      {debug && (
        <div className="glass-raised absolute bottom-4 left-4 z-20 rounded-ctl px-2 py-1 font-mono text-xs text-low">
          drift {Math.round(driftMs)}ms · seq {playback?.seq ?? 0} ·{' '}
          {adapter?.kind ?? 'no-adapter'}
        </div>
      )}

      {/* Screen-share hosting entry (when no one is sharing) */}
      <Dialog open={shareOpen} onOpenChange={setShareOpen}>
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
