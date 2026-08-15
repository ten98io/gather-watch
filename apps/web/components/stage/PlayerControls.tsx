'use client';

/**
 * PlayerControls — the stage's transport bar. Play/pause/seek/rate are room
 * policy-gated ClientEvents (server-authoritative); volume/mute/captions/PiP/
 * casting are LOCAL output concerns and stay local. Auto-hide is owned by the
 * StagePane chrome wrapper (DESIGN.md §7: 3 s of stillness).
 */
import { useEffect, useMemo, useState } from 'react';
import type { PlaybackState } from '@playin/contracts';
import { Slider } from '@/components/ui/slider';
import { Button } from '@/components/ui/button';
import { useRoomConnection } from '@/lib/room-context';
import { formatMs } from '@/lib/permissions';
import type { PlayerAdapter } from '@/lib/player/adapter';
import type { NativeAdapter } from '@/lib/player/native';
import {
  airPlayAvailable,
  promptRemotePlayback,
  remotePlaybackAvailable,
  showAirPlayPicker,
} from '@/lib/cast';
import { toast } from '@/components/ui/toast';

const RATES = [0.75, 1, 1.25, 1.5, 2] as const;

export function PlayerControls({
  adapter,
  playback,
  enabled,
  captionsOn,
  onToggleCaptions,
  captionsAvailable,
  muted,
  onMutedChange,
}: {
  adapter: PlayerAdapter | null;
  playback: PlaybackState;
  /** Room policy: may this member drive playback? */
  enabled: boolean;
  captionsOn: boolean;
  onToggleCaptions(): void;
  captionsAvailable: boolean;
  /** Controlled by the pane so the M shortcut shares the state. */
  muted: boolean;
  onMutedChange(muted: boolean): void;
}) {
  const connection = useRoomConnection();
  const [now, setNow] = useState(() => Date.now());
  const [volume, setVolume] = useState(1);
  const [durationMs, setDurationMs] = useState(0);

  const nativeEl = useMemo(
    () =>
      adapter !== null && adapter.kind === 'native'
        ? (adapter as NativeAdapter).mediaElement
        : null,
    [adapter],
  );

  useEffect(() => {
    const h = setInterval(() => {
      setNow(Date.now());
      if (adapter !== null) setDurationMs(adapter.durationMs());
    }, 500);
    return () => clearInterval(h);
  }, [adapter]);

  const expected =
    playback.playing && adapter !== null
      ? adapter.positionMs() // freshest local read; drift engine keeps it true
      : playback.positionMs;
  void now; // re-render heartbeat for the clock display

  const canCast = nativeEl !== null && remotePlaybackAvailable(nativeEl);
  const canAirPlay = nativeEl !== null && airPlayAvailable(nativeEl);

  const togglePlay = (): void => {
    if (!enabled || adapter === null) return;
    const pos = adapter.positionMs();
    if (playback.playing) connection.syncPause(pos);
    else connection.syncPlay(pos);
  };

  const seekTo = (ms: number): void => {
    if (!enabled) return;
    connection.syncSeek(Math.round(ms));
  };

  return (
    <div className="glass-raised flex flex-col gap-2 rounded-ctl px-3 py-2">
      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          aria-label={playback.playing ? 'Pause' : 'Play'}
          disabled={!enabled || adapter === null}
          onClick={togglePlay}
        >
          {playback.playing ? '❚❚' : '▶'}
        </Button>

        <span className="w-12 text-right font-mono text-xs text-mid tabular-nums">
          {formatMs(expected)}
        </span>
        <Slider
          aria-label="Seek"
          min={0}
          max={Math.max(1, durationMs)}
          step={500}
          value={Math.min(expected, Math.max(1, durationMs))}
          disabled={!enabled || durationMs <= 0}
          onValueChange={seekTo}
          className="flex-1"
        />
        <span className="w-12 font-mono text-xs text-low tabular-nums">
          {formatMs(durationMs)}
        </span>

        <Button
          variant="ghost"
          size="sm"
          aria-label="Playback rate"
          disabled={!enabled}
          onClick={() => {
            const idx = RATES.indexOf(playback.rate as (typeof RATES)[number]);
            connection.syncRate(RATES[(idx + 1) % RATES.length] ?? 1);
          }}
          className="font-mono text-xs"
        >
          {playback.rate}×
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          aria-label={muted ? 'Unmute' : 'Mute'}
          onClick={() => {
            const next = !muted;
            adapter?.setMuted(next);
            onMutedChange(next);
          }}
        >
          {muted ? '🔇' : '🔊'}
        </Button>
        <Slider
          aria-label="Volume"
          min={0}
          max={1}
          step={0.05}
          value={muted ? 0 : volume}
          onValueChange={(v) => {
            setVolume(v);
            adapter?.setVolume(v);
            if (v > 0 && muted) {
              adapter?.setMuted(false);
              onMutedChange(false);
            }
          }}
          className="w-24"
        />

        <div className="flex-1" />

        {captionsAvailable && (
          <Button
            variant={captionsOn ? 'secondary' : 'ghost'}
            size="sm"
            aria-label="Captions"
            aria-pressed={captionsOn}
            onClick={onToggleCaptions}
          >
            CC
          </Button>
        )}
        {nativeEl !== null && 'requestPictureInPicture' in document && (
          <Button
            variant="ghost"
            size="sm"
            aria-label="Picture in picture"
            onClick={() => {
              void (nativeEl as HTMLVideoElement).requestPictureInPicture?.().catch(() => {
                toast.error('Picture-in-picture is unavailable right now');
              });
            }}
          >
            ⧉
          </Button>
        )}
        {canAirPlay && nativeEl !== null && (
          <Button
            variant="ghost"
            size="sm"
            aria-label="AirPlay"
            onClick={() => showAirPlayPicker(nativeEl)}
          >
            ⌁
          </Button>
        )}
        {canCast && nativeEl !== null && (
          <Button
            variant="ghost"
            size="sm"
            aria-label="Cast to device"
            onClick={() => {
              void promptRemotePlayback(nativeEl).catch((err: unknown) => {
                toast.error(err instanceof Error ? err.message : 'Casting failed');
              });
            }}
          >
            📡
          </Button>
        )}
      </div>
    </div>
  );
}
