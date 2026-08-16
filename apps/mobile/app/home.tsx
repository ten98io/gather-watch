/**
 * Home — my rooms (with unread badges), create a watch|listen room, join by
 * invite code. Guests land directly in their room and can sign out here.
 */
import { useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import type { InviteCode, RoomKind } from '@playin/contracts';
import { api } from '../src/api';
import { useAuth } from '../src/auth';
import { palette, radii, spacing, type as typeScale } from '../src/theme';

export default function HomeScreen() {
  const auth = useAuth();
  const router = useRouter();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<RoomKind>('watch');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const roomsQuery = useQuery({
    queryKey: ['my-rooms'],
    queryFn: () => api.rooms.listMyRooms(),
    enabled: auth.status === 'authed' && auth.user?.email !== null,
  });

  useEffect(() => {
    if (auth.status === 'anon') router.replace('/login');
    // NOTE: deps intentionally minimal (re-run only on the values above).
  }, [auth.status]);

  const create = (): void => {
    setBusy(true);
    setError(null);
    api.rooms
      .createRoom({ kind, name: name.trim() })
      .then((res) => router.push(`/room/${res.room.id}`))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'failed'))
      .finally(() => setBusy(false));
  };

  const join = (): void => {
    setBusy(true);
    setError(null);
    api.rooms
      .joinRoom({ inviteCode: code.trim() as InviteCode })
      .then((res) => router.push(`/room/${res.room.id}`))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'failed'))
      .finally(() => setBusy(false));
  };

  return (
    <SafeAreaView style={styles.flex} edges={['top']}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.title}>
            Hey {auth.user?.displayName ?? 'there'}
          </Text>
          <Text style={styles.sub}>Pick a room, or start a new one.</Text>
        </View>
        <Pressable accessibilityRole="button" onPress={auth.signOut} style={styles.signOut}>
          <Text style={styles.signOutText}>Sign out</Text>
        </Pressable>
      </View>

      <FlatList
        data={roomsQuery.data?.rooms ?? []}
        keyExtractor={(r) => r.room.id}
        contentContainerStyle={styles.list}
        refreshing={roomsQuery.isRefetching}
        onRefresh={() => void roomsQuery.refetch()}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {auth.user?.email === null
              ? 'Guests live in one room — join with an invite code below.'
              : roomsQuery.isLoading
                ? 'Loading rooms…'
                : 'No rooms yet. Create one below.'}
          </Text>
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push(`/room/${item.room.id}`)}
            style={styles.roomCard}
          >
            <View style={styles.roomCardMain}>
              <Text style={styles.roomName}>{item.room.name}</Text>
              <Text style={styles.roomMeta}>
                {item.room.kind === 'watch' ? '🎬 watch' : '🎧 listen'} · {item.memberCount}{' '}
                {item.memberCount === 1 ? 'person' : 'people'}
              </Text>
            </View>
            {item.unreadCount > 0 && (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{item.unreadCount}</Text>
              </View>
            )}
          </Pressable>
        )}
      />

      <View style={styles.forms}>
        <View style={styles.formRow}>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="New room name"
            placeholderTextColor={palette.textLow}
            style={[styles.input, styles.formGrow]}
          />
          <Pressable
            accessibilityRole="button"
            onPress={() => setKind(kind === 'watch' ? 'listen' : 'watch')}
            style={styles.kindToggle}
          >
            <Text style={styles.kindToggleText}>{kind === 'watch' ? '🎬' : '🎧'}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={busy || name.trim().length === 0}
            onPress={create}
            style={[styles.actionButton, (busy || name.trim().length === 0) && styles.dimmed]}
          >
            <Text style={styles.actionText}>Create</Text>
          </Pressable>
        </View>

        <View style={styles.formRow}>
          <TextInput
            value={code}
            onChangeText={setCode}
            placeholder="Invite code"
            placeholderTextColor={palette.textLow}
            autoCapitalize="characters"
            autoCorrect={false}
            style={[styles.input, styles.formGrow]}
          />
          <Pressable
            accessibilityRole="button"
            disabled={busy || code.trim().length < 4}
            onPress={join}
            style={[styles.actionButton, (busy || code.trim().length < 4) && styles.dimmed]}
          >
            <Text style={styles.actionText}>Join</Text>
          </Pressable>
        </View>

        {error !== null && <Text style={styles.error}>{error}</Text>}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: palette.bgVoid },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.lg,
  },
  headerText: { flex: 1 },
  title: { ...typeScale.display, color: palette.textHi },
  sub: { ...typeScale.label, color: palette.textLow, marginTop: 2 },
  signOut: { padding: spacing.sm, minHeight: 44, justifyContent: 'center' },
  signOutText: { ...typeScale.label, color: palette.textLow },
  list: { paddingHorizontal: spacing.lg },
  empty: {
    ...typeScale.body,
    color: palette.textLow,
    textAlign: 'center',
    marginTop: spacing.xxl,
  },
  roomCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: palette.surfaceGlass,
    borderWidth: 1,
    borderColor: palette.borderGlass,
    borderRadius: radii.card,
    padding: spacing.lg,
    marginBottom: spacing.sm,
    minHeight: 64,
  },
  roomCardMain: { flex: 1 },
  roomName: { ...typeScale.title, color: palette.textHi },
  roomMeta: { ...typeScale.label, color: palette.textLow, marginTop: 2 },
  badge: {
    minWidth: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: palette.aurora2,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  badgeText: { ...typeScale.label, color: palette.accentInk, fontWeight: '700' },
  forms: {
    padding: spacing.lg,
    gap: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: palette.borderGlass,
    backgroundColor: palette.bgDeep,
  },
  formRow: { flexDirection: 'row', gap: spacing.sm },
  formGrow: { flex: 1 },
  input: {
    ...typeScale.body,
    color: palette.textHi,
    backgroundColor: palette.surfaceGlass,
    borderWidth: 1,
    borderColor: palette.borderGlass,
    borderRadius: radii.control,
    paddingHorizontal: spacing.md,
    minHeight: 44,
  },
  kindToggle: {
    width: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.control,
    backgroundColor: palette.surfaceRaised,
  },
  kindToggleText: { fontSize: 20 },
  actionButton: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    borderRadius: radii.control,
    backgroundColor: palette.aurora1,
  },
  actionText: { ...typeScale.bodyStrong, color: palette.accentInk },
  dimmed: { opacity: 0.45 },
  error: { ...typeScale.label, color: palette.danger },
});
