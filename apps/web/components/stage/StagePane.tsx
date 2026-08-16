'use client';

/**
 * StagePane — the room's sun (DESIGN.md §1). Mode A: real <video>/<audio>/
 * YouTube-iframe adapters drift-corrected by sync-core via useSyncEngine;
 * server-authoritative transport, wait-for-all buffering, captions, PiP,
 * AirPlay/Cast, MediaSession. Mode B (restream.state active): the host's
 * mesh screen share takes the stage (ModeBStage). Ambient glow samples the
 * playing media (§5.1) with an aurora fallback; emote bursts float above.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RoomId } from '@playin/contracts';
import { useRoom, useRoomConnection } from '@/lib/room-context';
import { RELAY_LABEL } from '@/lib/labels';
import { canAct } from '@/lib/permissions';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { adapterKindFor, isFullSyncKind, mediaKey, stageGate } from '@/lib/player/adapter';
import type { PlayerAdapter, StageGate } from '@/lib/player/adapter';
import { NativeAdapter } from '@/lib/player/native';
import { YouTubeAdapter } from '@/lib/player/youtube';
import { SoundCloudAdapter } from '@/lib/player/soundcloud';
import { VimeoAdapter } from '@/lib/player/vimeo';
import { EmbedAdapter } from '@/lib/player/embed';
import { useSyncEngine } from '@/lib/player/useSyncEngine';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PlayIcon } from '@/components/ui/icons';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/cn';
import { EmoteOverlay } from './EmoteOverlay';
import { ListenStage } from './ListenStage';
import { PlayerControls } from './PlayerControls';
import { ModeBStage } from './ModeBStage';

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

function EmptyStage({ listen }: { listen: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="font-display text-lg font-semibold text-mid">
        {listen ? 'Queue something to listen to' : 'Nothing playing yet'}
      </p>
      <p className="max-w-sm text-sm text-low">
        Add to the queue from the Queue tab — everyone’s player follows along.
      </p>
    </div>
  );
}

export function StagePane({ roomId }: { roomId: RoomId }) {
  const connection = useRoomConnection();
  const { room, member } = useRoom();
  const playback = connection.useRoomState((s) => s.playback);
  const restream = connection.useRoomState((s) => s.restream);
  const waitingOn = connection.useRoomState((s) => s.waitingOn);
  const queueItems = connection.useRoomState((s) => s.queue.items);
  const reduced = useReducedMotion();

  const mediaRef = playback?.mediaRef ?? null;
  const adapterKind = adapterKindFor(mediaRef);
  const listen = room.kind === 'listen';
  const showModeB = restream?.active === true;
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
  const [localBuffering, setLocalBuffering] = useState(false);
  const [localReady, setLocalReady] = useState(false);
  const [playRefused, setPlayRefused] = useState(false);
  const [startStalled, setStartStalled] = useState(false);
  /** Bumped by every start gesture so the "did it actually start?" watchdog
   *  re-arms; without it a second refusal would go unnoticed. */
  const [startAttempt, setStartAttempt] = useState(0);

  const debug = useMemo(
    () => typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('debug'),
    [],
  );

  // ── adapter lifecycle (created per adapter kind; loaded per media identity)
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
  }, [adapterKind]);

  const mediaIdentity = useMemo(() => {
    if (mediaRef === null || mediaRef === undefined) return 'none';
    return mediaKey(mediaRef, undefined);
  }, [mediaRef]);

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
  }, [adapter, mediaIdentity]);

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
      adapter.on('ended', () => setLocalPlaying(false)),
      adapter.on('blocked', () => setPlayRefused(true)),
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
  useEffect(() => {
    if (adapter === null || !fullSync || !localReady || !wantsPlay || localPlaying) return;
    adapter.play();
  }, [adapter, fullSync, localReady, wantsPlay, localPlaying, startAttempt]);

  // Autoplay reality (UX_OVERHAUL B2): browsers refuse playback nobody asked
  // for. NativeAdapter/VimeoAdapter report the refusal outright; the iframe
  // widgets can only be caught by noticing that a ready, un-buffering player
  // still is not running a beat after the room said play.
  useEffect(() => {
    if (!fullSync || !wantsPlay || !localReady || localPlaying || localBuffering) {
      setStartStalled(false);
      return undefined;
    }
    const h = setTimeout(() => setStartStalled(true), 1500);
    return () => clearTimeout(h);
  }, [fullSync, wantsPlay, localReady, localPlaying, localBuffering, mediaIdentity, startAttempt]);

  /** Is a provider surface with its own chrome on screen for us to shield?
   *  Not for Mode B (the share owns the stage), not for approximate-tier
   *  embeds (their iframe is the only control they have), and not for a
   *  listen room's hidden audio element (ListenStage owns that space). */
  const providerSurface =
    !showModeB &&
    playback !== null &&
    mediaRef !== null &&
    fullSync &&
    !(listen && adapterKind === 'native');

  const gate = stageGate({
    active: providerSurface,
    wantsPlay,
    localPlaying,
    blocked: playRefused || startStalled,
  });

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
      artist: `${room.name} · Playin`,
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

  /** One transport, mounted in one of two places: floating over a watch room's
   *  video, or inline under the listen room's hero (there is no moving picture
   *  there for it to get out of the way of). */
  const transportNode =
    !showModeB && playback !== null && adapterKind !== 'embed' ? (
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
        {showModeB ? (
          <ModeBStage restream={restream} />
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
                'relative h-full w-full',
                adapterKind !== null && adapterKind !== 'native'
                  ? 'flex items-center justify-center'
                  : 'hidden',
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
                  adapterKind === 'native' || mediaRef === null ? '' : 'hidden',
                )}
              >
                <ListenStage
                  adapter={adapter}
                  currentItem={currentItem}
                  playing={playback?.playing === true}
                  queueItems={queueItems}
                  currentIndex={playback?.queueIndex ?? null}
                  {...(transportNode !== null ? { transport: transportNode } : {})}
                />
                {/* The audio element is the real player — visualizer taps it. */}
                <video ref={mediaElRef} className="hidden" playsInline crossOrigin="anonymous" />
              </div>
            ) : (
              <video
                ref={mediaElRef}
                playsInline
                crossOrigin="anonymous"
                className={cn(
                  'max-h-full max-w-full bg-black',
                  adapterKind === 'native' ? '' : 'hidden',
                )}
                aria-label="Shared video"
              />
            )}
            {mediaRef === null && !listen && <EmptyStage listen={listen} />}
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

      {/* waiting-for-all honesty + relay badge + Mode B entry */}
      <div className="pointer-events-none absolute right-4 top-4 z-20 flex flex-col items-end gap-2">
        <Badge variant="muted" className="pointer-events-auto">
          {RELAY_LABEL[room.relayMode]}
        </Badge>
        {waitingOn.length > 0 && (
          <Badge variant="default" className="pointer-events-auto">
            Waiting for {waitingOn.length} to buffer…
          </Badge>
        )}
        {!showModeB && (
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

      {/* Transport chrome. Watch rooms float it over the video and let it fade
          with the rest of the chrome; listen rooms mount the same control inline
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

      {/* Mode B hosting entry (when no one is sharing) */}
      <Dialog open={shareOpen} onOpenChange={setShareOpen}>
        <DialogContent aria-label="Share your screen">
          <DialogTitle>Share your screen</DialogTitle>
          <ModeBStage
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
