/**
 * CallBar — in-room call strip. HONEST BOUNDARY: this build does not bundle
 * @livekit/react-native + react-native-webrtc (native config-plugin weight,
 * no toolchains in CI). What is REAL here:
 *  - the LiveKit token round-trip (POST /rtc/livekit-token via RestClient);
 *  - presence of call participants (from the room stream) rendered as orbs.
 * What is a documented stub: actually joining the SFU session. Pressing Join
 * mints a token, then shows the boundary panel instead of pretending to be
 * in a call — presence is NOT set to in-call (that would fake state other
 * clients render).
 *
 * Integration point (native milestone): add @livekit/react-native +
 * react-native-webrtc config plugins, then connect with the minted
 * { url, token } and publish mic. Mode B hosting from mobile additionally
 * requires the iOS ReplayKit broadcast extension (BUILD_PROMPT marks it a
 * documented stub).
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useStore } from 'zustand';
import type { RoomId } from '@gather/contracts';
import { api } from '../api';
import type { RoomConnection } from '../room-connection';
import { palette, radii, spacing, type as typeScale } from '../theme';

type CallPhase = 'idle' | 'requesting' | 'boundary' | 'error';

export function CallBar(props: { conn: RoomConnection; roomId: RoomId }) {
  const { conn, roomId } = props;
  const presence = useStore(conn.store, (s) => s.presence);
  const [phase, setPhase] = useState<CallPhase>('idle');
  const [detail, setDetail] = useState<string | null>(null);

  const inCall = Object.values(presence).filter((p) => p.state === 'in-call');

  const join = async (): Promise<void> => {
    setPhase('requesting');
    setDetail(null);
    try {
      const { url } = await api.livekit.token({ roomId });
      // Token minted successfully — the SFU session itself needs the native
      // module, so we surface the boundary instead of faking a connection.
      setDetail(`Token minted for ${url}. Native call module is not bundled in this build.`);
      setPhase('boundary');
    } catch (err) {
      setDetail(err instanceof Error ? err.message : 'token request failed');
      setPhase('error');
    }
  };

  return (
    <View style={styles.bar}>
      <View style={styles.left}>
        <Text style={styles.title}>
          {inCall.length > 0 ? `${inCall.length} in call` : 'Room call'}
        </Text>
        {inCall.length > 0 && (
          <Text style={styles.sub}>
            {inCall
              .slice(0, 3)
              .map((p) => (p.micOn ? '🎙' : '🔇'))
              .join(' ')}
          </Text>
        )}
      </View>

      {phase === 'idle' && (
        <Pressable accessibilityRole="button" onPress={() => void join()} style={styles.joinButton}>
          <Text style={styles.joinText}>Join call</Text>
        </Pressable>
      )}
      {phase === 'requesting' && <Text style={styles.sub}>Requesting token…</Text>}
      {(phase === 'boundary' || phase === 'error') && (
        <Pressable
          accessibilityRole="button"
          onPress={() => setPhase('idle')}
          style={[styles.joinButton, phase === 'error' && styles.errorButton]}
        >
          <Text style={styles.joinText}>Dismiss</Text>
        </Pressable>
      )}

      {detail !== null && (
        <View style={styles.detailBox}>
          <Text style={[styles.detailText, phase === 'error' && { color: palette.danger }]}>
            {detail}
          </Text>
          {phase === 'boundary' && (
            <Text style={styles.detailText}>
              Calls arrive with @livekit/react-native (native milestone) — see
              apps/mobile/README.md.
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    backgroundColor: palette.surfaceGlass,
    borderBottomWidth: 1,
    borderBottomColor: palette.borderGlass,
  },
  left: { flex: 1 },
  title: { ...typeScale.bodyStrong, color: palette.textHi },
  sub: { ...typeScale.label, color: palette.textMid },
  joinButton: {
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: palette.aurora1,
    backgroundColor: 'rgba(149,91,254,0.15)',
  },
  errorButton: { borderColor: palette.danger, backgroundColor: 'rgba(255,82,81,0.12)' },
  joinText: { ...typeScale.bodyStrong, color: palette.textHi },
  detailBox: { flexBasis: '100%', paddingTop: spacing.xs },
  detailText: { ...typeScale.label, color: palette.textMid },
});
