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
import { canAct } from '@/lib/permissions';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { adapterKindFor, mediaKey } from '@/lib/player/adapter';
import type { PlayerAdapter } from '@/lib/player/adapter';
import { NativeAdapter } from '@/lib/player/native';
import { YouTubeAdapter } from '@/lib/player/youtube';
import { useSyncEngine } from '@/lib/player/useSyncEngine';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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

  const mediaElRef = useRef<HTMLVideoElement | null>(null);
  const ytContainerRef = useRef<HTMLDivElement | null>(null);
  const [adapter, setAdapter] = useState<PlayerAdapter | null>(null);
  const [muted, setMuted] = useState(false);
  const [captionsOn, setCaptionsOn] = useState(true);
  const [captionsAvailable, setCaptionsAvailable] = useState(false);
  const [chromeAwake, setChromeAwake] = useState(true);
  const [driftMs, setDriftMs] = useState(0);
  const [shareOpen, setShareOpen] = useState(false);

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
    if (adapterKind === 'youtube' && ytContainerRef.current !== null) {
      const a = new YouTubeAdapter(ytContainerRef.current);
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

  useEffect(() => {
    if (adapter === null || mediaRef === null) return;
    adapter.load(mediaRef);
  }, [adapter, mediaIdentity]);

  useSyncEngine({
    adapter,
    playback,
    clock: connection.clock,
    onDriftSample: debug ? setDriftMs : undefined,
  });

  // Buffering reports drive the server's wait-for-all coordination.
  useEffect(() => {
    if (adapter === null) return;
    const offBuf = adapter.on('buffering', () => connection.syncBuffering(true));
    const offReady = adapter.on('buffered', () => connection.syncBuffering(false));
    const offCap = adapter.on('ready', () => {
      if (adapter.kind === 'native') {
        const el = (adapter as NativeAdapter).mediaElement;
        setCaptionsAvailable(el.textTracks.length > 0);
      }
    });
    return () => {
      offBuf();
      offReady();
      offCap();
    };
  }, [adapter, connection]);

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
    navigator.mediaSession.setActionHandler('play', () => connection.syncPlay(adapter?.positionMs()));
    navigator.mediaSession.setActionHandler('pause', () =>
      connection.syncPause(adapter?.positionMs()),
    );
    navigator.mediaSession.setActionHandler('seekto', (d) => {
      if (typeof d.seekTime === 'number') connection.syncSeek(Math.round(d.seekTime * 1000));
    });
    return () => {
      navigator.mediaSession.setActionHandler('play', null);
      navigator.mediaSession.setActionHandler('pause', null);
      navigator.mediaSession.setActionHandler('seekto', null);
    };
  }, [connection, adapter, currentItem?.title, currentItem?.artworkUrl, room.name]);

  // ── chrome auto-hide: 3 s of stillness (§7) ──
  const wakeChrome = useCallback(() => setChromeAwake(true), []);
  useEffect(() => {
    if (!chromeAwake) return;
    const h = setTimeout(() => setChromeAwake(false), 3000);
    return () => clearTimeout(h);
  }, [chromeAwake]);

  // ── keyboard map (§9) ──
  const controlEnabled = canAct(room.policies.playbackControl, member.role);
  useKeyboardShortcuts(
    useMemo(
      () => [
        {
          key: ' ',
          handler: () => {
            if (!controlEnabled || adapter === null || playback === null) return;
            if (playback.playing) connection.syncPause(adapter.positionMs());
            else connection.syncPlay(adapter.positionMs());
          },
        },
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
      [controlEnabled, adapter, playback, connection, muted, captionsAvailable],
    ),
  );

  const glow = useAmbientGlow(adapter, playback?.playing === true, reduced);
  const pulseKey = playback?.seq ?? 0;
  const showModeB = restream?.active === true;

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
            {/* Both mount points stay in the tree; the inactive one is hidden
                so adapters survive transient state without re-mounting. */}
            {/* YouTube chrome is suppressed: the iframe is inert
                (pointer-events-none) and a click layer toggles play/pause —
                the room's transport bar is the ONLY control surface. */}
            <div className={cn('relative h-full w-full', adapterKind === 'youtube' ? 'flex items-center justify-center' : 'hidden')}>
              <div ref={ytContainerRef} className="pointer-events-none aspect-video max-h-full w-full" />
              {adapterKind === 'youtube' && playback !== null && (
                <button
                  type="button"
                  aria-label={playback.playing ? 'Pause' : 'Play'}
                  className="absolute inset-0 h-full w-full cursor-pointer"
                  onClick={() => {
                    if (!controlEnabled || adapter === null) return;
                    if (playback.playing) connection.syncPause(adapter.positionMs());
                    else connection.syncPlay(adapter.positionMs());
                  }}
                />
              )}
            </div>
            {listen ? (
              <div className={cn('flex w-full flex-col items-center gap-4 p-6', adapterKind === 'native' || mediaRef === null ? '' : 'hidden')}>
                <ListenStage
                  adapter={adapter}
                  currentItem={currentItem}
                  playing={playback?.playing === true}
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
          </>
        )}
        <SyncPulse pulseKey={pulseKey} />
        <EmoteOverlay />
      </div>

      {/* waiting-for-all honesty + relay badge + Mode B entry */}
      <div className="pointer-events-none absolute right-4 top-4 z-20 flex flex-col items-end gap-2">
        <Badge variant="muted" className="pointer-events-auto">
          {room.relayMode === 'mesh' ? 'P2P · E2E' : room.relayMode === 'cf-sfu' ? 'Relayed · Theater' : 'Relayed'}
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

      {/* transport chrome */}
      {!showModeB && playback !== null && (
        <div
          className={cn(
            'absolute inset-x-4 bottom-4 z-20 transition-opacity duration-300',
            chromeAwake ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
        >
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
          <DialogTitle>Mode B — share your screen</DialogTitle>
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
