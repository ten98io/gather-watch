'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { User } from '@playin/contracts';
import { Ok } from '@playin/contracts';
import {
  apiFetch,
  clearAccessToken,
  onAuthExpired,
  refreshSession,
} from './api';

export interface AuthContextValue {
  /** The signed-in user (guests included), or null when signed out. */
  user: User | null;
  /** True until the initial session bootstrap (refresh-cookie probe) settles. */
  loading: boolean;
  /** Room-scoped guest identity (email is null). */
  isGuest: boolean;
  /** Replace the current user (after login/verify/guest join/profile update). */
  setUser(user: User | null): void;
  /** Re-fetch the session via the refresh cookie. */
  refresh(): Promise<User | null>;
  /** Revoke this session server-side and clear local auth state. */
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void refreshSession().then((session) => {
      if (cancelled) return;
      setUser(session === null ? null : session.user);
      setLoading(false);
    });
    const off = onAuthExpired(() => {
      setUser(null);
      setLoading(false);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const refresh = useCallback(async (): Promise<User | null> => {
    const session = await refreshSession();
    setUser(session === null ? null : session.user);
    return session === null ? null : session.user;
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    try {
      await apiFetch('/auth/logout', { method: 'POST', schema: Ok });
    } catch {
      // Logout must succeed locally even when the server is unreachable.
    }
    clearAccessToken();
    setUser(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      isGuest: user !== null && user.email === null,
      setUser,
      refresh,
      logout,
    }),
    [user, loading, refresh, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx === null) {
    throw new Error('useAuth must be used within <AuthProvider>');
  }
  return ctx;
}
