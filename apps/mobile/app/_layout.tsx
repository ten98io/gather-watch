/**
 * Root layout: providers (TanStack Query, Auth) + dark navigation container
 * themed from DESIGN.md tokens. All screens render on the void background.
 */
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { DarkTheme, ThemeProvider } from '@react-navigation/native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '../src/auth';
import { palette, type as typeScale } from '../src/theme';

const navTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: palette.bgVoid,
    card: palette.bgDeep,
    text: palette.textHi,
    border: palette.borderGlass,
    primary: palette.aurora1,
    notification: palette.aurora2,
  },
};

function LoadingGate(props: { children: React.ReactNode }) {
  const { status } = useAuth();
  if (status === 'loading') {
    return (
      <View style={styles.gate}>
        <Text style={styles.gateTitle}>Gather</Text>
        <Text style={styles.gateSub}>Warming up the projector…</Text>
      </View>
    );
  }
  return <>{props.children}</>;
}

export default function RootLayout() {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <ThemeProvider value={navTheme}>
            <StatusBar style="light" />
            <LoadingGate>
              <Stack
                screenOptions={{
                  headerShown: false,
                  contentStyle: { backgroundColor: palette.bgVoid },
                }}
              />
            </LoadingGate>
          </ThemeProvider>
        </AuthProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  gate: {
    flex: 1,
    backgroundColor: palette.bgVoid,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gateTitle: { ...typeScale.display, color: palette.textHi },
  gateSub: { ...typeScale.label, color: palette.textLow, marginTop: 8 },
});
