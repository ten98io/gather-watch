/**
 * Login — magic-link email sign-in, guest join via invite code, and a dev
 * token/link paste box.
 *
 * Deep link: production magic links target `gather://login?token=…`
 * (scheme "gather", app.json); expo-router parses the query into this
 * screen's params and the effect below verifies it automatically. In dev the
 * api echoes the link (devLink) — surfaced here so no mailbox is needed.
 */
import { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useAuth } from '../src/auth';
import { auroraGradient, palette, radii, spacing, type as typeScale } from '../src/theme';

export default function LoginScreen() {
  const auth = useAuth();
  const router = useRouter();
  const params = useLocalSearchParams<{ token?: string }>();

  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [devLink, setDevLink] = useState<string | null>(null);
  const [tokenPaste, setTokenPaste] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [guestName, setGuestName] = useState('');
  const [roomPassword, setRoomPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = (fn: () => Promise<void>): void => {
    setBusy(true);
    setError(null);
    fn()
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'failed'))
      .finally(() => setBusy(false));
  };

  // Deep-link: gather://login?token=…
  useEffect(() => {
    const token = typeof params.token === 'string' ? params.token : null;
    if (token !== null && auth.status === 'anon') {
      run(() => auth.verifyToken(token).then(() => router.replace('/home')));
    }
    // NOTE: deps intentionally minimal (re-run only on the values above).
  }, [params.token, auth.status]);

  useEffect(() => {
    if (auth.status === 'authed') router.replace('/home');
    // NOTE: deps intentionally minimal (re-run only on the values above).
  }, [auth.status]);

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={styles.logo}>Gather</Text>
        <Text style={styles.tagline}>Your private cinema, drifting in space.</Text>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Sign in with email</Text>
          <TextInput
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            placeholderTextColor={palette.textLow}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
          />
          <Pressable
            accessibilityRole="button"
            disabled={busy || !email.includes('@')}
            onPress={() =>
              run(async () => {
                const res = await auth.requestMagicLink(email.trim());
                setSentTo(email.trim());
                setDevLink(res.devLink);
              })
            }
          >
            <LinearGradient
              colors={[...auroraGradient.colors]}
              start={auroraGradient.start}
              end={auroraGradient.end}
              style={[styles.primaryButton, (busy || !email.includes('@')) && styles.dimmed]}
            >
              <Text style={styles.primaryText}>Send magic link</Text>
            </LinearGradient>
          </Pressable>
          {sentTo !== null && (
            <Text style={styles.note}>
              Link sent to {sentTo}. Open it on this device — or paste it below (dev).
            </Text>
          )}
          {devLink !== null && (
            <Text selectable style={styles.devLink}>
              dev link: {devLink}
            </Text>
          )}

          <TextInput
            value={tokenPaste}
            onChangeText={setTokenPaste}
            placeholder="Paste token or full link (dev)"
            placeholderTextColor={palette.textLow}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
          />
          <Pressable
            accessibilityRole="button"
            disabled={busy || tokenPaste.trim().length === 0}
            onPress={() => run(() => auth.verifyToken(tokenPaste))}
            style={[styles.secondaryButton, (busy || tokenPaste.trim().length === 0) && styles.dimmed]}
          >
            <Text style={styles.secondaryText}>Verify pasted token</Text>
          </Pressable>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Join as guest</Text>
          <TextInput
            value={inviteCode}
            onChangeText={setInviteCode}
            placeholder="Invite code"
            placeholderTextColor={palette.textLow}
            autoCapitalize="characters"
            autoCorrect={false}
            style={styles.input}
          />
          <TextInput
            value={guestName}
            onChangeText={setGuestName}
            placeholder="Display name"
            placeholderTextColor={palette.textLow}
            style={styles.input}
          />
          <TextInput
            value={roomPassword}
            onChangeText={setRoomPassword}
            placeholder="Room password (if required)"
            placeholderTextColor={palette.textLow}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            style={styles.input}
          />
          <Pressable
            accessibilityRole="button"
            disabled={busy || inviteCode.trim().length < 4 || guestName.trim().length === 0}
            onPress={() =>
              run(() =>
                auth
                  .guestJoin(inviteCode, guestName, roomPassword)
                  .then(({ roomId }) => router.replace(`/room/${roomId}`)),
              )
            }
            style={[
              styles.secondaryButton,
              (busy || inviteCode.trim().length < 4 || guestName.trim().length === 0) &&
                styles.dimmed,
            ]}
          >
            <Text style={styles.secondaryText}>Join room</Text>
          </Pressable>
        </View>

        {error !== null && <Text style={styles.error}>{error}</Text>}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: palette.bgVoid },
  container: { padding: spacing.lg, paddingTop: spacing.xxl * 2 },
  logo: { ...typeScale.hero, color: palette.textHi, textAlign: 'center' },
  tagline: {
    ...typeScale.body,
    color: palette.textMid,
    textAlign: 'center',
    marginTop: spacing.xs,
    marginBottom: spacing.xl,
  },
  card: {
    backgroundColor: palette.surfaceGlass,
    borderWidth: 1,
    borderColor: palette.borderGlass,
    borderRadius: radii.panel,
    padding: spacing.lg,
    gap: spacing.md,
    marginBottom: spacing.lg,
  },
  cardTitle: { ...typeScale.title, color: palette.textHi },
  input: {
    ...typeScale.body,
    color: palette.textHi,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: palette.borderGlass,
    borderRadius: radii.control,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: 44,
  },
  primaryButton: {
    borderRadius: radii.control,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { ...typeScale.bodyStrong, color: palette.accentInk },
  secondaryButton: {
    borderRadius: radii.control,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: palette.borderGlass,
    backgroundColor: palette.surfaceRaised,
  },
  secondaryText: { ...typeScale.bodyStrong, color: palette.textHi },
  dimmed: { opacity: 0.45 },
  note: { ...typeScale.label, color: palette.textMid },
  devLink: { ...typeScale.mono, fontSize: 12, color: palette.aurora3 },
  error: { ...typeScale.label, color: palette.danger, textAlign: 'center' },
});
