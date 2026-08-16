/**
 * Room screen — Stage (Mode A playback) + CallBar + bottom tab sheet
 * (Chat / Queue / People), all fed by one RoomConnection (RoomSocket with
 * replay gap recovery) seeded at the live event tip (lastEventSeq) so late
 * joiners don't replay full history.
 */
import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useStore } from 'zustand';
import type { RoomId } from '@playin/contracts';
import { api, tokenStore } from '../../src/api';
import { useAuth } from '../../src/auth';
import { WS_URL } from '../../src/config';
import { RoomConnection } from '../../src/room-connection';
import { canAct } from '../../src/permissions';
import { CallBar } from '../../src/components/CallBar';
import { Chat } from '../../src/components/Chat';
import { People } from '../../src/components/People';
import { Queue } from '../../src/components/Queue';
import { Stage } from '../../src/components/Stage';
import { palette, radii, spacing, type as typeScale } from '../../src/theme';

type Tab = 'chat' | 'queue' | 'people';

const QUICK_EMOTES = ['💜', '🔥', '😂', '👏'] as const;

export default function RoomScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const roomId = (typeof params.id === 'string' ? params.id : '') as RoomId;
  const auth = useAuth();
  const router = useRouter();

  const [tab, setTab] = useState<Tab>('chat');

  const roomQuery = useQuery({
    queryKey: ['room', roomId],
    queryFn: () => api.rooms.getRoom(roomId),
    enabled: auth.status === 'authed' && roomId.length > 0,
  });

  // One connection per room id; RoomSocket is inert until connect().
  const conn = useMemo(
    () => new RoomConnection({ rest: api, wsUrl: WS_URL }),
    // NOTE: deps intentionally minimal (re-run only on the values above).
    [roomId],
  );

  const status = useStore(conn.store, (s) => s.status);
  const gapLossCount = useStore(conn.store, (s) => s.gapLossCount);
  const lastError = useStore(conn.store, (s) => s.lastError);

  useEffect(() => {
    const data = roomQuery.data;
    if (data === undefined) return;
    let cancelled = false;
    void (async () => {
      // The WS handshake uses the raw access JWT — refresh first if stale.
      if (!tokenStore.hasValidAccessToken() && tokenStore.getRefreshToken() !== null) {
        await api.auth.refresh().catch(() => undefined);
      }
      const token = tokenStore.getAccessToken();
      if (token === null || cancelled) return;
      conn.store.setState({ room: data.room });
      conn.connect(roomId, token, {
        ...(data.lastEventSeq !== undefined ? { initialSeq: data.lastEventSeq } : {}),
      });
      conn.presenceUpdate({ state: data.room.kind === 'listen' ? 'listening' : 'watching' });
      void conn.loadRecentMessages().catch(() => undefined);
    })();
    return () => {
      cancelled = true;
      conn.close();
    };
    // NOTE: deps intentionally minimal (re-run only on the values above).
  }, [roomQuery.data, roomId, conn]);

  // A gap that replay could not close: refetch authoritative room state.
  useEffect(() => {
    if (gapLossCount > 0) void roomQuery.refetch();
    // NOTE: deps intentionally minimal (re-run only on the values above).
  }, [gapLossCount]);

  useEffect(() => {
    if (auth.status === 'anon') router.replace('/login');
    // NOTE: deps intentionally minimal (re-run only on the values above).
  }, [auth.status]);

  const room = roomQuery.data?.room ?? null;
  const role = roomQuery.data?.member.role ?? 'member';
  const me = auth.user?.id;

  const statusColor =
    status === 'open' ? palette.success : status === 'closed' ? palette.textLow : palette.warn;

  return (
    <SafeAreaView style={styles.flex} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Leave room"
          onPress={() => router.back()}
          style={styles.backButton}
        >
          <Text style={styles.backGlyph}>‹</Text>
        </Pressable>
        <View style={styles.headerMain}>
          <Text numberOfLines={1} style={styles.roomName}>
            {room?.name ?? 'Room'}
          </Text>
          {room !== null && (
            <Text style={styles.invite}>
              code <Text style={styles.inviteCode}>{room.inviteCode}</Text>
            </Text>
          )}
        </View>
        <View style={styles.statusWrap}>
          <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
          <Text style={styles.statusText}>{status}</Text>
        </View>
      </View>

      {room !== null && me !== undefined && (
        <>
          <Stage conn={conn} kind={room.kind} role={role} />
          <CallBar conn={conn} roomId={roomId} />

          {/* Quick emotes — ephemeral bursts over the stage (§5.3). */}
          <View style={styles.emoteRow}>
            {QUICK_EMOTES.map((emoji) => (
              <Pressable
                key={emoji}
                accessibilityLabel={`React with ${emoji}`}
                onPress={() =>
                  conn.emoteBurst(emoji, 10 + Math.random() * 75, 15 + Math.random() * 40)
                }
                style={styles.emoteButton}
              >
                <Text style={styles.emoteGlyph}>{emoji}</Text>
              </Pressable>
            ))}
          </View>

          <View style={styles.tabs}>
            {(['chat', 'queue', 'people'] as const).map((t) => (
              <Pressable
                key={t}
                accessibilityRole="button"
                onPress={() => setTab(t)}
                style={[styles.tab, tab === t && styles.tabActive]}
              >
                <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
                  {t === 'chat' ? 'Chat' : t === 'queue' ? 'Queue' : 'People'}
                </Text>
              </Pressable>
            ))}
          </View>

          <View style={styles.tabBody}>
            {tab === 'chat' && (
              <Chat
                conn={conn}
                me={me}
                canModerate={role === 'host' || role === 'moderator'}
                composerEnabled={room !== null && canAct(room.policies.chat, role)}
              />
            )}
            {tab === 'queue' && <Queue conn={conn} me={me} role={role} />}
            {tab === 'people' && <People conn={conn} roomId={roomId} me={me} />}
          </View>
        </>
      )}

      {roomQuery.isLoading && <Text style={styles.centerNote}>Joining room…</Text>}
      {lastError !== null && <Text style={styles.errorNote}>{lastError}</Text>}
      {roomQuery.error !== null && (
        <Text style={styles.errorNote}>
          {roomQuery.error instanceof Error ? roomQuery.error.message : 'Failed to load room'}
        </Text>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: palette.bgVoid },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  backButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  backGlyph: { color: palette.textHi, fontSize: 32, marginTop: -4 },
  headerMain: { flex: 1 },
  roomName: { ...typeScale.title, color: palette.textHi },
  invite: { ...typeScale.label, color: palette.textLow },
  inviteCode: { ...typeScale.mono, color: palette.aurora3, fontSize: 12 },
  statusWrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { ...typeScale.label, color: palette.textLow },
  emoteRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  emoteButton: {
    width: 44,
    height: 44,
    borderRadius: radii.pill,
    backgroundColor: palette.surfaceGlass,
    borderWidth: 1,
    borderColor: palette.borderGlass,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emoteGlyph: { fontSize: 20 },
  tabs: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: palette.borderGlass,
    backgroundColor: palette.bgDeep,
  },
  tab: {
    flex: 1,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabActive: { borderTopWidth: 2, borderTopColor: palette.aurora1 },
  tabText: { ...typeScale.body, color: palette.textLow },
  tabTextActive: { color: palette.textHi, fontWeight: '600' },
  tabBody: { flex: 1, backgroundColor: palette.bgDeep },
  centerNote: {
    ...typeScale.body,
    color: palette.textLow,
    textAlign: 'center',
    marginTop: spacing.xxl,
  },
  errorNote: {
    ...typeScale.label,
    color: palette.danger,
    textAlign: 'center',
    padding: spacing.sm,
  },
});
