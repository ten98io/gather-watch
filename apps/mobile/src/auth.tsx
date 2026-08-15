/**
 * AuthProvider / useAuth — magic-link + guest auth on top of src/api.ts.
 *
 * Session model (matches services/api): short-lived access JWT in secure
 * store (sent as Bearer), refresh token scraped from the `playin_rt`
 * Set-Cookie and re-attached manually on /auth/refresh (see api.ts header).
 * Deep link: production magic links target `playin://login?token=…`
 * (app.json scheme "playin"); the login screen also accepts a pasted
 * token or full link in dev.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { InviteCode, User } from '@playin/contracts';
import { api, setAuthExpiredHandler, tokenStore } from './api';

export type AuthStatus = 'loading' | 'anon' | 'authed';

export interface AuthContextValue {
  status: AuthStatus;
  user: User | null;
  /** Send a magic link. `devLink` is non-null only against a dev api. */
  requestMagicLink: (email: string) => Promise<{ devLink: string | null }>;
  /** Complete sign-in from a raw token OR a full magic link URL. */
  verifyToken: (tokenOrLink: string) => Promise<void>;
  /** Guest join via invite code; resolves with the room id to enter. */
  guestJoin: (inviteCode: string, displayName: string) => Promise<{ roomId: string }>;
  /**
   * Local sign-out (secure store wiped). NOTE: the api exposes
   * POST /auth/logout but @playin/api-client@0.1.0 does not surface it —
   * server-side session revocation is an orchestrator TODO; the session
   * remains valid server-side until expiry.
   */
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Extracts the token from a pasted magic link or returns the raw input. */
export function extractToken(tokenOrLink: string): string {
  const trimmed = tokenOrLink.trim();
  const m = /[?&#]token=([^&#\s]+)/.exec(trimmed);
  const raw = m?.[1];
  return raw !== undefined ? decodeURIComponent(raw) : trimmed;
}

export function AuthProvider(props: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<User | null>(null);

  const signOut = useCallback((): void => {
    tokenStore.clear();
    setUser(null);
    setStatus('anon');
  }, []);

  useEffect(() => {
    setAuthExpiredHandler(signOut);
    return () => setAuthExpiredHandler(null);
  }, [signOut]);

  // Bootstrap: hydrate tokens, then me() (valid access token) or refresh()
  // (expired token + stored refresh token). Anything failing → anon.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await tokenStore.hydrate();
      try {
        if (tokenStore.hasValidAccessToken()) {
          const res = await api.auth.me();
          if (!cancelled) {
            setUser(res.user);
            setStatus('authed');
          }
          return;
        }
        if (tokenStore.getRefreshToken() !== null) {
          const res = await api.auth.refresh(); // captureFetch stores new tokens
          if (!cancelled) {
            setUser(res.user);
            setStatus('authed');
          }
          return;
        }
      } catch {
        tokenStore.clear();
      }
      if (!cancelled) setStatus('anon');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const requestMagicLink = useCallback(async (email: string) => {
    await api.auth.requestMagicLink({ email });
    return { devLink: tokenStore.consumeDevLink() };
  }, []);

  const verifyToken = useCallback(async (tokenOrLink: string) => {
    const res = await api.auth.verifyToken({ token: extractToken(tokenOrLink) });
    setUser(res.user);
    setStatus('authed');
  }, []);

  const guestJoin = useCallback(async (inviteCode: string, displayName: string) => {
    const res = await api.auth.guestJoin({
      inviteCode: inviteCode.trim() as InviteCode,
      displayName: displayName.trim(),
    });
    setUser(res.user);
    setStatus('authed');
    return { roomId: res.room.id as string };
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, requestMagicLink, verifyToken, guestJoin, signOut }),
    [status, user, requestMagicLink, verifyToken, guestJoin, signOut],
  );

  return <AuthContext.Provider value={value}>{props.children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx === null) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
