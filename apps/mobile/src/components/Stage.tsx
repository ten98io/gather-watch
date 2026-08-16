/**
 * Stage — the room's sun (DESIGN.md §1). Mode A playback:
 *  - hls / direct-url MediaRef → expo-video player, drift-corrected by
 *    useSyncEngine (sync-core math, WS beacons);
 *  - youtube MediaRef → WebView embed. LIMITATION (documented, not faked):
 *    the YouTube iframe inside react-native-webview exposes no reliable
 *    position sampling without a postMessage bridge build, so YouTube
 *    playback renders but is NOT drift-corrected on mobile — the room stays
 *    in sync only via play/pause/seek commands being issued at roughly the
 *    same server time. A native YT bridge is a follow-up milestone.
 *  - Mode B (restream.state active) → honest boundary panel (native viewing
 *    needs the LiveKit call module; see CallBar.tsx).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useEventListener } from 'expo';
import { useVideoPlayer, VideoView } from 'expo-video';
import type { VideoPlayer } from 'expo-video';
import { WebView } from 'react-native-webview';
import { useStore } from 'zustand';
import type { MemberRole, PlaybackState, RoomKind } from '@playin/contracts';
import type { RoomConnection } from '../room-connection';
import { canAct } from '../permissions';
import { useSyncEngine } from '../sync/useSyncEngine';
import { auroraGradient, layout, palette, radii, spacing, type as typeScale } from '../theme';

const RATES = [0.75, 1, 1.25, 1.5, 2] as const;

function formatMs(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Ephemeral emote bursts floating up over the stage (§5.3). */
function EmoteOverlay(props: { conn: RoomConnection }) {
  const emotes = useStore(props.conn.store, (s) => s.emotes);
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {emotes.map((e) => (
        <FloatingEmote key={e.id} emoji={e.emoji} xPct={e.xPct} yPct={e.yPct} />
      ))}
    </View>
  );
}

function FloatingEmote(props: { emoji: string; xPct: number; yPct: number }) {
  const rise = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(rise, { toValue: 1, duration: 2400, useNativeDriver: true }).start();
  }, [rise]);
  const translateY = rise.interpolate({ inputRange: [0, 1], outputRange: [0, -120] });
  const opacity = rise.interpolate({ inputRange: [0, 0.7, 1], outputRange: [1, 1, 0] });
  return (
    <Animated.Text
      style={{
        position: 'absolute',
        left: `${props.xPct}%`,
        top: `${props.yPct}%`,
        fontSize: 28,
        opacity,
        transform: [{ translateY }],
      }}
    >
      {props.emoji}
    </Animated.Text>
  );
}

function Controls(props: {
  conn: RoomConnection;
  player: VideoPlayer;
  playback: PlaybackState;
  enabled: boolean;
}) {
  const { conn, player, playback, enabled } = props;
  const [width, setWidth] = useState(1);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(h);
  }, []);

  const expected = playback.playing
    ? playback.positionMs + (now - playback.serverTs) * playback.rate
    : playback.positionMs;
  const durationMs = Number.isFinite(player.duration) ? player.duration * 1000 : 0;

  return (
    <View style={styles.controls}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={playback.playing ? 'Pause' : 'Play'}
        disabled={!enabled}
        onPress={() => {
          const pos = player.currentTime * 1000;
          if (playback.playing) {
            conn.syncPause(pos);
          } else {
            conn.syncPlay(pos);
          }
        }}
        style={[styles.playButton, !enabled && styles.disabled]}
      >
        <Text style={styles.playGlyph}>{playback.playing ? '❚❚' : '▶'}</Text>
      </Pressable>

      <Pressable
        accessibilityLabel="Seek"
        disabled={!enabled || durationMs <= 0}
        style={styles.progressTrack}
        onLayout={(e) => setWidth(Math.max(1, e.nativeEvent.layout.width))}
        onPress={(e) => {
          if (!enabled || durationMs <= 0) return;
          const frac = Math.min(1, Math.max(0, e.nativeEvent.locationX / width));
          conn.syncSeek(Math.round(frac * durationMs));
        }}
      >
        <View style={styles.progressRail}>
          <View
            style={[
              styles.progressFill,
              { width: `${durationMs > 0 ? Math.min(100, (expected / durationMs) * 100) : 0}%` },
            ]}
          />
        </View>
      </Pressable>

      <Text style={styles.time}>
        {formatMs(expected)} / {formatMs(durationMs)}
      </Text>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Playback rate"
        disabled={!enabled}
        onPress={() => {
          const idx = RATES.indexOf(playback.rate as (typeof RATES)[number]);
          const next = RATES[(idx + 1) % RATES.length] ?? 1;
          conn.syncRate(next);
        }}
        style={[styles.rateButton, !enabled && styles.disabled]}
      >
        <Text style={styles.rateText}>{playback.rate}×</Text>
      </Pressable>
    </View>
  );
}

function EmbedStage(props: { uri: string; label: string }) {
  return (
    <View style={styles.stageBody}>
      <WebView
        source={{ uri: props.uri }}
        style={styles.flex}
        allowsFullscreenVideo
        mediaPlaybackRequiresUserAction={false}
      />
      <Text style={styles.limitation}>
        {props.label} on mobile: sync is approximate (embed bridge pending) — direct/HLS
        sources are frame-accurate.
      </Text>
    </View>
  );
}

export function Stage(props: {
  conn: RoomConnection;
  kind: RoomKind;
  role: MemberRole;
}) {
  const { conn, kind, role } = props;
  const playback = useStore(conn.store, (s) => s.playback);
  const restream = useStore(conn.store, (s) => s.restream);
  const room = useStore(conn.store, (s) => s.room);
  const waitingOn = useStore(conn.store, (s) => s.waitingOn);

  const mediaRef = playback?.mediaRef ?? null;
  const nativeSource = useMemo(() => {
    if (mediaRef === null || (mediaRef.kind !== 'hls' && mediaRef.kind !== 'url')) return null;
    return { uri: mediaRef.url };
  }, [mediaRef]);

  /** WebView embed URL for the no-native-player kinds (approximate sync). */
  const embedUri = useMemo(() => {
    if (mediaRef === null) return null;
    if (mediaRef.kind === 'youtube') {
      return `https://www.youtube.com/embed/${mediaRef.videoId}?playsinline=1&rel=0`;
    }
    if (mediaRef.kind === 'soundcloud') {
      return `https://w.soundcloud.com/player/?url=${encodeURIComponent(mediaRef.url)}&auto_play=false`;
    }
    if (mediaRef.kind === 'vimeo') {
      return `https://player.vimeo.com/video/${mediaRef.videoId}`;
    }
    if (mediaRef.kind === 'embed') {
      return mediaRef.embedUrl;
    }
    return null;
  }, [mediaRef]);

  const player = useVideoPlayer(nativeSource, (p) => {
    p.timeUpdateEventInterval = 0.5;
  });

  useSyncEngine({
    player: nativeSource === null ? null : player,
    playback,
    clock: conn.clock,
  });

  // Buffering reports drive the server's wait-for-all coordination.
  const [status, setStatus] = useState(player.status);
  useEventListener(player, 'statusChange', (payload) => {
    setStatus(payload.status);
  });
  useEffect(() => {
    if (nativeSource === null) return;
    conn.syncBuffering(status === 'loading');
  }, [conn, status, nativeSource]);

  const controlEnabled =
    room !== null ? canAct(room.policies.playbackControl, role) : false;

  return (
    <View style={styles.stage}>
      {/* Ambient glow (§5.1): static aurora wash until per-media color
          sampling ships; opacity kept low per DESIGN.md. */}
      <LinearGradient
        colors={[auroraGradient.colors[0], auroraGradient.colors[1]]}
        start={auroraGradient.start}
        end={auroraGradient.end}
        style={styles.ambient}
        pointerEvents="none"
      />

      {restream?.active === true ? (
        <View style={styles.stageBody}>
          <Text style={styles.modeBTitle}>Host is sharing their screen (Mode B)</Text>
          <Text style={styles.limitation}>
            Native Mode B viewing rides the LiveKit call module, which is a documented
            scaffold in this build (see CallBar). Nothing here is simulated.
          </Text>
        </View>
      ) : mediaRef === null ? (
        <View style={styles.stageBody}>
          <Text style={styles.emptyTitle}>
            {kind === 'listen' ? 'Queue something to listen to' : 'Nothing playing yet'}
          </Text>
          <Text style={styles.limitation}>
            Add to the queue from the Queue tab — everyone’s player follows along.
          </Text>
        </View>
      ) : embedUri !== null ? (
        <EmbedStage
          uri={embedUri}
          label={
            mediaRef?.kind === 'youtube'
              ? 'YouTube'
              : mediaRef?.kind === 'soundcloud'
                ? 'SoundCloud'
                : mediaRef?.kind === 'vimeo'
                  ? 'Vimeo'
                  : mediaRef?.kind === 'embed'
                    ? mediaRef.provider
                    : 'Embed'
          }
        />
      ) : (
        <View style={styles.stageBody}>
          <VideoView
            player={player}
            style={kind === 'listen' ? styles.audioArtwork : styles.video}
            contentFit="contain"
            nativeControls={false}
          />
          {waitingOn.length > 0 && (
            <Text style={styles.limitation}>Waiting for {waitingOn.length} to buffer…</Text>
          )}
          {playback !== null && (
            <Controls conn={conn} player={player} playback={playback} enabled={controlEnabled} />
          )}
        </View>
      )}

      <EmoteOverlay conn={conn} />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  stage: {
    backgroundColor: palette.bgVoid,
    borderBottomWidth: 1,
    borderBottomColor: palette.borderGlass,
    overflow: 'hidden',
  },
  ambient: {
    ...StyleSheet.absoluteFillObject,
    opacity: 0.08,
  },
  stageBody: {
    minHeight: 220,
  },
  video: {
    width: '100%',
    aspectRatio: 16 / 9,
    backgroundColor: 'black',
  },
  audioArtwork: {
    width: '100%',
    height: 160,
    backgroundColor: palette.bgDeep,
  },
  emptyTitle: {
    ...typeScale.title,
    color: palette.textMid,
    textAlign: 'center',
    marginTop: spacing.xxl,
  },
  modeBTitle: {
    ...typeScale.title,
    color: palette.textHi,
    textAlign: 'center',
    marginTop: spacing.xl,
  },
  limitation: {
    ...typeScale.caption,
    color: palette.textLow,
    textAlign: 'center',
    margin: spacing.md,
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  playButton: {
    minWidth: layout.minHit,
    minHeight: layout.minHit,
    borderRadius: radii.pill,
    backgroundColor: palette.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playGlyph: { color: palette.textHi, fontSize: 18 },
  progressTrack: {
    flex: 1,
    height: layout.minHit,
    justifyContent: 'center',
  },
  progressRail: {
    height: 4,
    borderRadius: 2,
    backgroundColor: palette.surfaceRaised,
    overflow: 'hidden',
  },
  progressFill: {
    height: 4,
    borderRadius: 2,
    backgroundColor: palette.aurora1,
  },
  time: { ...typeScale.mono, color: palette.textMid, fontSize: 12 },
  rateButton: {
    minWidth: layout.minHit,
    minHeight: layout.minHit,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rateText: { ...typeScale.bodyStrong, color: palette.aurora1 },
  disabled: { opacity: 0.4 },
});
