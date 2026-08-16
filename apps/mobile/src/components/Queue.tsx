/**
 * Queue — collaborative queue tab: add by URL (direct/HLS/YouTube), remove,
 * reorder (up/down — no gesture-handler dependency), vote-to-skip with live
 * vote counts, and tap-to-play via sync.setTrack. All state comes from the
 * server-authoritative queue.state event; actions are ClientEvents.
 */
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useStore } from 'zustand';
import type { MemberRole, QueueItem, UserId } from '@gather/contracts';
import type { RoomConnection } from '../room-connection';
import { canAct, mediaRefFromUrl } from '../permissions';
import { palette, radii, spacing, type as typeScale } from '../theme';

function formatDuration(ms: number | null): string {
  if (ms === null) return '';
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function QueueRow(props: {
  conn: RoomConnection;
  item: QueueItem;
  index: number;
  count: number;
  isCurrent: boolean;
  me: UserId;
  canQueue: boolean;
  memberCount: number;
}) {
  const { conn, item, index, count, isCurrent, me, canQueue, memberCount } = props;
  const voted = item.votesToSkip.includes(me);
  const majority = Math.floor(memberCount / 2);

  const move = (dir: -1 | 1): void => {
    const ids = conn.store.getState().queue.items.map((it) => it.id);
    const j = index + dir;
    if (j < 0 || j >= ids.length) return;
    const a = ids[index];
    const b = ids[j];
    if (a === undefined || b === undefined) return;
    ids[index] = b;
    ids[j] = a;
    conn.queueReorder(ids);
  };

  return (
    <View style={[styles.row, isCurrent && styles.rowCurrent]}>
      <View style={styles.rowMain}>
        <Text numberOfLines={1} style={styles.title}>
          {isCurrent ? '▶ ' : ''}
          {item.title}
        </Text>
        <Text style={styles.meta}>
          {item.mediaRef.kind}
          {item.durationMs !== null ? ` · ${formatDuration(item.durationMs)}` : ''}
          {item.votesToSkip.length > 0
            ? ` · skip votes ${item.votesToSkip.length}/${majority + 1}`
            : ''}
        </Text>
      </View>
      <View style={styles.rowActions}>
        {canQueue && (
          <>
            <Pressable
              accessibilityLabel="Play this item"
              onPress={() => conn.syncSetTrackByQueue(index)}
              style={styles.action}
            >
              <Text style={styles.actionText}>Play</Text>
            </Pressable>
            <Pressable
              accessibilityLabel="Move up"
              disabled={index === 0}
              onPress={() => move(-1)}
              style={[styles.action, index === 0 && styles.dim]}
            >
              <Text style={styles.actionText}>↑</Text>
            </Pressable>
            <Pressable
              accessibilityLabel="Move down"
              disabled={index === count - 1}
              onPress={() => move(1)}
              style={[styles.action, index === count - 1 && styles.dim]}
            >
              <Text style={styles.actionText}>↓</Text>
            </Pressable>
          </>
        )}
        <Pressable
          accessibilityLabel={voted ? 'Withdraw skip vote' : 'Vote to skip'}
          onPress={() => conn.queueVoteSkip(item.id)}
          style={[styles.action, voted && styles.voted]}
        >
          <Text style={styles.actionText}>{voted ? '✓ Skip' : 'Skip'}</Text>
        </Pressable>
        {canQueue && (
          <Pressable
            accessibilityLabel="Remove from queue"
            onPress={() => conn.queueRemove(item.id)}
            style={styles.action}
          >
            <Text style={[styles.actionText, { color: palette.danger }]}>✕</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

export function Queue(props: { conn: RoomConnection; me: UserId; role: MemberRole }) {
  const { conn, me, role } = props;
  const queue = useStore(conn.store, (s) => s.queue);
  const playback = useStore(conn.store, (s) => s.playback);
  const room = useStore(conn.store, (s) => s.room);
  const presence = useStore(conn.store, (s) => s.presence);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const canQueue = room !== null ? canAct(room.policies.queueControl, role) : false;
  const memberCount = Object.keys(presence).length;
  const currentIndex = playback?.queueIndex ?? null;

  const add = (): void => {
    const ref = mediaRefFromUrl(draft);
    if (ref === null) {
      setError('Paste a YouTube link or a direct media URL (mp4/mp3/m3u8)');
      return;
    }
    const title = ref.kind === 'youtube' ? `YouTube · ${ref.videoId}` : ref.url.split('/').pop() ?? ref.url;
    conn.queueAdd({ mediaRef: ref, title, durationMs: null, artworkUrl: null });
    setDraft('');
    setError(null);
  };

  return (
    <View style={styles.flex}>
      {canQueue && (
        <View style={styles.addRow}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="Add YouTube or media URL…"
            placeholderTextColor={palette.textLow}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
          />
          <Pressable accessibilityLabel="Add to queue" onPress={add} style={styles.addButton}>
            <Text style={styles.addButtonText}>Add</Text>
          </Pressable>
        </View>
      )}
      {error !== null && <Text style={styles.error}>{error}</Text>}

      <ScrollView contentContainerStyle={styles.list}>
        {queue.items.length === 0 ? (
          <Text style={styles.empty}>Queue is empty — add something to watch together.</Text>
        ) : (
          queue.items.map((item, index) => (
            <QueueRow
              key={item.id}
              conn={conn}
              item={item}
              index={index}
              count={queue.items.length}
              isCurrent={currentIndex === index}
              me={me}
              canQueue={canQueue}
              memberCount={memberCount}
            />
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  addRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: palette.borderGlass,
  },
  input: {
    flex: 1,
    ...typeScale.body,
    color: palette.textHi,
    backgroundColor: palette.surfaceGlass,
    borderWidth: 1,
    borderColor: palette.borderGlass,
    borderRadius: radii.control,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  addButton: {
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    borderRadius: radii.control,
    backgroundColor: palette.aurora1,
    minHeight: 44,
  },
  addButtonText: { ...typeScale.bodyStrong, color: palette.accentInk },
  error: { ...typeScale.label, color: palette.warn, paddingHorizontal: spacing.md },
  list: { padding: spacing.sm },
  empty: {
    ...typeScale.body,
    color: palette.textLow,
    textAlign: 'center',
    marginTop: spacing.xxl,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.card,
    backgroundColor: palette.surfaceGlass,
    borderWidth: 1,
    borderColor: palette.borderGlass,
    marginBottom: spacing.sm,
  },
  rowCurrent: { borderColor: palette.aurora1, backgroundColor: 'rgba(149,91,254,0.12)' },
  rowMain: { flex: 1 },
  title: { ...typeScale.bodyStrong, color: palette.textHi },
  meta: { ...typeScale.label, color: palette.textLow, marginTop: 2 },
  rowActions: { flexDirection: 'row', gap: spacing.xs, flexWrap: 'wrap', maxWidth: 170 },
  action: {
    minHeight: 36,
    minWidth: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.control,
    backgroundColor: palette.surfaceRaised,
    paddingHorizontal: spacing.sm,
  },
  actionText: { ...typeScale.label, color: palette.textHi },
  voted: { borderWidth: 1, borderColor: palette.aurora3 },
  dim: { opacity: 0.35 },
});
