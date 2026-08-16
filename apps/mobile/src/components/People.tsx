/**
 * People — presence orbs (DESIGN.md §5.2): avatar circles with accent-colored
 * edges, a pulsing 2px ring while a participant is in-call with mic on, and
 * presence state labels. Member list comes from REST (listMembers) and is
 * refreshed whenever the connection bumps membersVersion.
 */
import { useEffect, useRef } from 'react';
import { Animated, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useStore } from 'zustand';
import type { PresenceEntry, RoomId, UserId } from '@playin/contracts';
import { api } from '../api';
import type { RoomConnection } from '../room-connection';
import { layout, palette, spacing, type as typeScale } from '../theme';

const STATE_LABEL: Record<PresenceEntry['state'], string> = {
  watching: 'Watching',
  listening: 'Listening',
  'in-call': 'In call',
  away: 'Away',
  offline: 'Offline',
};

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}

function SpeakingRing(props: { children: React.ReactNode }) {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 900, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] });
  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.9, 0.35] });
  return (
    <View>
      <Animated.View
        style={[styles.ring, { opacity, transform: [{ scale }] }]}
        pointerEvents="none"
      />
      {props.children}
    </View>
  );
}

function Orb(props: {
  name: string;
  accentColor: string;
  presence: PresenceEntry | undefined;
  role: string;
  isMe: boolean;
}) {
  const speaking = props.presence?.state === 'in-call' && props.presence.micOn;
  const orb = (
    <View
      style={[
        styles.orb,
        { borderColor: props.accentColor },
        props.presence?.state === 'offline' && styles.orbOffline,
      ]}
    >
      <Text style={styles.orbText}>{initials(props.name)}</Text>
    </View>
  );
  return (
    <View style={styles.person}>
      {speaking ? <SpeakingRing>{orb}</SpeakingRing> : orb}
      <Text numberOfLines={1} style={styles.name}>
        {props.name}
        {props.isMe ? ' (you)' : ''}
      </Text>
      <Text style={styles.role}>
        {props.role}
        {props.presence !== undefined ? ` · ${STATE_LABEL[props.presence.state]}` : ''}
        {props.presence?.sharing === true ? ' · sharing' : ''}
      </Text>
    </View>
  );
}

export function People(props: { conn: RoomConnection; roomId: RoomId; me: UserId }) {
  const { conn, roomId, me } = props;
  const presence = useStore(conn.store, (s) => s.presence);
  const membersVersion = useStore(conn.store, (s) => s.membersVersion);

  const membersQuery = useQuery({
    queryKey: ['members', roomId],
    queryFn: () => api.rooms.listMembers(roomId),
  });

  useEffect(() => {
    if (membersVersion > 0) void membersQuery.refetch();
    // NOTE: deps intentionally minimal (re-run only on the values above).
  }, [membersVersion]);

  const members = membersQuery.data?.members ?? [];

  return (
    <ScrollView contentContainerStyle={styles.list}>
      {members.length === 0 ? (
        <Text style={styles.empty}>
          {membersQuery.isLoading ? 'Loading people…' : 'No members found.'}
        </Text>
      ) : (
        members.map(({ member, user }) => (
          <Orb
            key={user.id}
            name={user.displayName}
            accentColor={user.accentColor}
            presence={presence[user.id]}
            role={member.role}
            isMe={user.id === me}
          />
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  list: { padding: spacing.md },
  empty: {
    ...typeScale.body,
    color: palette.textLow,
    textAlign: 'center',
    marginTop: spacing.xxl,
  },
  person: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: layout.tap,
  },
  orb: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 2,
    backgroundColor: palette.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  orbOffline: { opacity: 0.4 },
  orbText: { ...typeScale.bodyStrong, color: palette.textHi },
  ring: {
    position: 'absolute',
    top: -3,
    left: -3,
    width: 50,
    height: 50,
    borderRadius: 25,
    borderWidth: 2,
    borderColor: palette.aurora2,
  },
  name: { ...typeScale.bodyStrong, color: palette.textHi, flexShrink: 1 },
  role: { ...typeScale.label, color: palette.textLow },
});
