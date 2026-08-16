/**
 * Runtime configuration. `EXPO_PUBLIC_API_URL` (Expo inlines EXPO_PUBLIC_* at
 * bundle time) wins; `app.json > expo.extra.apiUrl` is the committed default;
 * localhost:4000 matches services/api's default port.
 */
import Constants from 'expo-constants';

const extra = (Constants.expoConfig?.extra ?? {}) as { apiUrl?: unknown };

export const API_URL: string =
  process.env.EXPO_PUBLIC_API_URL ??
  (typeof extra.apiUrl === 'string' ? extra.apiUrl : 'http://localhost:4000');

/** One multiplexed room WS endpoint (services/api registers GET /ws). */
export const WS_URL: string = `${API_URL.replace(/^http/i, 'ws')}/ws`;

/** Deep-link scheme (app.json). Magic links for mobile target
 *  `gather://login?token=…`; in dev the link/token can be pasted manually. */
export const DEEP_LINK_SCHEME = 'gather';
