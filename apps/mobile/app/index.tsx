/**
 * Entry route: redirect by auth state (boot hydration happens in AuthProvider).
 */
import { Redirect } from 'expo-router';
import { useAuth } from '../src/auth';

export default function Index() {
  const { status } = useAuth();
  if (status === 'authed') return <Redirect href="/home" />;
  if (status === 'anon') return <Redirect href="/login" />;
  return null; // LoadingGate in _layout covers the boot splash
}
