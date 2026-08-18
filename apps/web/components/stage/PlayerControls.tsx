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
import { useExtensionDriver } from '@/lib/player/extension-driver';
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

/** Names for the cast sentence a provider item shows. 'embed' never reaches
 *  this bar (StagePane withholds the transport there), but the fallback keeps
 *  the sentence grammatical if it ever does. */
const PROVIDER_CAST_NAME: Partial<Record<PlayerAdapter['kind'], string>> = {
  youtube: 'YouTube',
  soundcloud: 'SoundCloud',
  vimeo: 'Vimeo',
};

/**
 * Why the platform pickers cannot act, in one sentence — or null when they
 * can (native media with a working picker). docs/EXTENSION_FIRST.md Part 3:
 * provider content casts only through the service's OWN cast control, so the
 * bar must explain that instead of silently dropping the button; no branch
 * may leave the cast affordance both silent and dead.
 */
function castExplanation(input: {
  adapterKind: PlayerAdapter['kind'] | null;
  nativeEl: HTMLMediaElement | null;
  pickerAvailable: boolean;
  extensionDriving: boolean;
  extensionProviderName: string | null;
}): string | null {
  const { adapterKind, nativeEl, pickerAvailable, extensionDriving, extensionProviderName } =
    input;
  if (nativeEl !== null) {
    return pickerAvailable ? null : 'Casting isn’t available in this browser';
  }
  if (adapterKind !== null && adapterKind !== 'native') {
    const name = PROVIDER_CAST_NAME[adapterKind] ?? 'This service';
    return `${name} casts with its own cast button, from its app or site`;
  }
  if (extensionDriving) {
    // The service's real page is open in the tab the extension drives, so its
    // own cast control genuinely is reachable there.
    return extensionProviderName !== null
      ? `${extensionProviderName} casts with its own cast button — it’s in the ${extensionProviderName} tab`
      : 'This site casts with its own cast button — it’s in the playing tab';
  }
  return 'Casting options appear once the media loads';
}

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

  /**
   * VOLUME AND MUTE ARE THIS BAR'S STATE, NOT THE ADAPTER'S — so they have to
   * be re-asserted onto every adapter this bar is handed.
   *
   * A track change across kinds (mp4 → YouTube, or the music/video flip, which
   * moves the <video> to a different container) destroys the player and builds
   * a fresh one at its factory defaults: full volume, unmuted. The bar kept
   * rendering the old settings — the slider still down, the icon still crossed
   * out — while the new player blasted a room that had deliberately turned it
   * off. Late at night, in someone's headphones.
   *
   * Deliberately keyed on the adapter alone. It is not a sync of "whatever the
   * user last set" on every render; it is the one moment a new player exists
   * and has never been told anything.
   */
  useEffect(() => {
    if (adapter === null) return;
    adapter.setVolume(volume);
    adapter.setMuted(muted);
    // Deps: the PLAYER only. The values are pushed straight to the adapter by
    // their own handlers when they change; this is the other direction.
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

  // Shares StagePane's singleton store; this is a second subscriber, not a
  // second detection pass.
  const extension = useExtensionDriver();
  const castExplain = castExplanation({
    adapterKind: adapter !== null ? adapter.kind : null,
    nativeEl,
    pickerAvailable: canAirPlay || canCast,
    extensionDriving: extension.driving,
    extensionProviderName:
      extension.state.phase === 'ready' ? (extension.state.provider?.name ?? null) : null,
  });

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
      {/* One cast affordance in every session (EXTENSION_FIRST.md Part 3):
          working pickers when the platform has them, otherwise the same slot
          explains — tooltip for pointers, tap-to-toast for touch. */}
      {castExplain !== null ? (
        <Tooltip content={castExplain} align="end">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => toast(castExplain)}
            className={ICON_BTN}
          >
            <CastIcon size={16} />
          </Button>
        </Tooltip>
      ) : (
        <>
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
        </>
      )}
    </div>
  );
}
