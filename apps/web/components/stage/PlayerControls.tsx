'use client';

/**
 * PlayerControls — the stage's transport bar. Play/pause/seek/rate are room
 * policy-gated ClientEvents (server-authoritative); volume/mute/captions/PiP/
 * casting are LOCAL output concerns and stay local. Auto-hide is owned by the
 * StagePane chrome wrapper (DESIGN.md §7: 3 s of stillness).
 *
 * Layout is a single ~50px row so the bar never eats the stage; every control
 * carries a Tooltip whose text doubles as its aria-label (DESIGN.md §9 keyboard
 * map is surfaced in the hints).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PlaybackState } from '@gather/contracts';
import { Slider } from '@/components/ui/slider';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import {
  AirplayIcon,
  CaptionsIcon,
  CastIcon,
  PauseIcon,
  PipIcon,
  PlayIcon,
  VolumeIcon,
  VolumeMutedIcon,
} from '@/components/ui/icons';
import { useRoomConnection } from '@/lib/room-context';
import { describeError } from '@/lib/describe-error';
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

/** `size="sm"` is 36px and pads for a text label; icon controls are 32px squares.
 *  `!` is required because `cn` only joins — Tailwind's own source order would
 *  otherwise let the size class win. */
const ICON_BTN = '!h-8 !w-8 shrink-0 !p-0';

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
  /** Local scrub preview: set while dragging, released when the room echoes. */
  const [scrubMs, setScrubMs] = useState<number | null>(null);
  const draggingRef = useRef(false);

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

  // The scrub preview holds until the server's new state lands (seq bump), so
  // the readout never snaps back to the pre-seek position for a frame.
  useEffect(() => {
    if (!draggingRef.current) setScrubMs(null);
  }, [playback.seq]);
  // …and never sticks if that echo never comes (seek rejected, socket asleep).
  useEffect(() => {
    if (scrubMs === null) return;
    const h = setTimeout(() => setScrubMs(null), 2000);
    return () => clearTimeout(h);
  }, [scrubMs]);

  const expected =
    playback.playing && adapter !== null
      ? adapter.positionMs() // freshest local read; drift engine keeps it true
      : playback.positionMs;
  void now; // re-render heartbeat for the clock display

  const positionMs = scrubMs ?? expected;
  const seekMax = Math.max(1, durationMs);
  const canCast = nativeEl !== null && remotePlaybackAvailable(nativeEl);
  const canAirPlay = nativeEl !== null && airPlayAvailable(nativeEl);
  const canPip = nativeEl !== null && 'requestPictureInPicture' in document;

  const togglePlay = (): void => {
    if (!enabled || adapter === null) return;
    const pos = adapter.positionMs();
    if (playback.playing) connection.syncPause(pos);
    else connection.syncPlay(pos);
  };

  return (
    <div className="glass-raised flex flex-wrap items-center gap-1.5 rounded-ctl px-2.5 py-1.5">
      <Tooltip content={playback.playing ? 'Pause (Space)' : 'Play (Space)'} align="start">
        <Button
          variant="primary"
          size="sm"
          disabled={!enabled || adapter === null}
          onClick={togglePlay}
          className={ICON_BTN}
        >
          {playback.playing ? <PauseIcon size={14} /> : <PlayIcon size={14} />}
        </Button>
      </Tooltip>

      <span className="hidden w-12 shrink-0 text-right font-mono text-xs text-mid tabular-nums sm:inline">
        {formatMs(positionMs)}
      </span>
      {/* basis-24 (not flex-1) so wrapping actually triggers on a narrow stage:
          a 0-basis item is collected into the line at zero width and then
          overflows past min-width instead of pushing the tail onto row two. */}
      <Tooltip content="Seek (arrow keys ±10s)" className="min-w-[6rem] grow basis-24">
        <Slider
          aria-label="Seek"
          min={0}
          max={seekMax}
          step={500}
          value={Math.min(positionMs, seekMax)}
          disabled={!enabled || durationMs <= 0}
          // Dragging only moves the local preview; the room hears about it once.
          onValueChange={(ms) => {
            draggingRef.current = true;
            setScrubMs(ms);
          }}
          onValueCommit={(ms) => {
            draggingRef.current = false;
            if (!enabled) return;
            connection.syncSeek(Math.round(ms));
          }}
          className="h-8"
        />
      </Tooltip>
      <span className="w-12 shrink-0 font-mono text-xs text-low tabular-nums">
        {formatMs(durationMs)}
      </span>

      <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-border-glass" />

      <Tooltip content={muted ? 'Unmute (M)' : 'Mute (M)'}>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            const next = !muted;
            adapter?.setMuted(next);
            onMutedChange(next);
          }}
          className={ICON_BTN}
        >
          {muted ? <VolumeMutedIcon size={16} /> : <VolumeIcon size={16} />}
        </Button>
      </Tooltip>
      {/* Pointer-only affordance: on touch the OS volume owns this. The width
          lives on the wrapper — the Slider itself is w-full inside it. */}
      <Tooltip content="Volume" className="hidden w-20 shrink-0 md:inline-flex">
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
        />
      </Tooltip>

      <Tooltip content="Playback speed">
        <Button
          variant="ghost"
          size="sm"
          disabled={!enabled}
          onClick={() => {
            const idx = RATES.indexOf(playback.rate as (typeof RATES)[number]);
            connection.syncRate(RATES[(idx + 1) % RATES.length] ?? 1);
          }}
          className="!h-8 shrink-0 !px-2 font-mono text-xs tabular-nums"
        >
          {playback.rate}×
        </Button>
      </Tooltip>

      {captionsAvailable && (
        <Tooltip content="Subtitles (C)" align="end">
          <Button
            variant={captionsOn ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={captionsOn}
            onClick={onToggleCaptions}
            className={ICON_BTN}
          >
            <CaptionsIcon size={16} />
          </Button>
        </Tooltip>
      )}
      {canPip && nativeEl !== null && (
        <Tooltip content="Picture-in-picture" align="end">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void (nativeEl as HTMLVideoElement).requestPictureInPicture?.().catch(() => {
                toast.error('Picture-in-picture is unavailable right now');
              });
            }}
            className={ICON_BTN}
          >
            <PipIcon size={16} />
          </Button>
        </Tooltip>
      )}
      {canAirPlay && nativeEl !== null && (
        <Tooltip content="AirPlay" align="end">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => showAirPlayPicker(nativeEl)}
            className={ICON_BTN}
          >
            <AirplayIcon size={16} />
          </Button>
        </Tooltip>
      )}
      {canCast && nativeEl !== null && (
        <Tooltip content="Cast to TV" align="end">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void promptRemotePlayback(nativeEl).catch((err: unknown) => {
                toast.error(describeError(err, 'Casting is unavailable right now'));
              });
            }}
            className={ICON_BTN}
          >
            <CastIcon size={16} />
          </Button>
        </Tooltip>
      )}
    </div>
  );
}
