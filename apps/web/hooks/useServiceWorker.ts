'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';

/**
 * Registers /public/sw.js in production only (app-shell cache + push handler).
 * No-op during development so HMR is never intercepted.
 */
export function useServiceWorker(): void {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Registration failure must never break the app.
    });
  }, []);
}

/* ── web push opt-in ──────────────────────────────────────────────────────
 *
 * There was no client half at all: nothing in the app had ever called
 * Notification.requestPermission or pushManager.subscribe, so the server's
 * subscription table stayed empty and every mention push fanned out to nobody.
 *
 * Two rules shape everything below.
 *
 * 1. NEVER prompt on load. A permission prompt nobody asked for is the fastest
 *    way to a permanent "blocked", and a blocked origin cannot be un-blocked
 *    from script. `refresh()` therefore only READS state (Notification
 *    permission, an existing subscription); the prompt lives behind an
 *    explicit control in Settings and nowhere else.
 * 2. Unsubscribe on the way out — opting out AND signing out. A subscription
 *    the server still holds keeps delivering to a device whose owner has
 *    walked away from the account, so `disable()` drops the row server-side
 *    first and then tears down the browser subscription.
 */

/**
 * What the opt-in control has to render. 'checking' is the first paint, before
 * the read-only probe has answered — without it the control would claim this
 * browser cannot do push and then correct itself a tick later.
 */
export type PushPermission = 'checking' | 'unsupported' | 'blocked' | 'off' | 'on';

export interface PushSubscriptionControls {
  state: PushPermission;
  /** True while a permission prompt or a round trip is in flight. */
  busy: boolean;
  /** Resolves to the state it settled on, so the caller can say what happened
   *  — a dismissed prompt is not an error, and is not success either. */
  enable(): Promise<PushPermission>;
  disable(): Promise<void>;
}

/** This browser can do web push at all. */
function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/**
 * The VAPID key as `pushManager.subscribe` wants it. The server hands it over
 * base64url-encoded (that is the form web-push generates and the form every
 * VAPID_PUBLIC_KEY in the wild is written in); the API takes raw bytes.
 */
function applicationServerKey(base64Url: string): BufferSource {
  const padded = base64Url.padEnd(base64Url.length + ((4 - (base64Url.length % 4)) % 4), '=');
  const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  // Built over an explicit ArrayBuffer: a bare `new Uint8Array(n)` is typed
  // over ArrayBufferLike, which BufferSource does not accept.
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * The service-worker registration, registering it if this is development (where
 * `useServiceWorker` deliberately does not). Opting in is an explicit user
 * action, so it is allowed to cost a registration.
 */
async function ensureRegistration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration();
  if (existing?.active != null) return existing;
  if (existing === undefined) await navigator.serviceWorker.register('/sw.js');
  // `ready` and not the register() result: it resolves only once a worker is
  // ACTIVE, and `pushManager.subscribe` on a registration whose worker is still
  // installing throws. That is the exact state a first-ever opt-in is in.
  return navigator.serviceWorker.ready;
}

/** The live PushSubscription for this browser, if it has one. */
async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration();
  if (registration === undefined) return null;
  return registration.pushManager.getSubscription();
}

/**
 * Drop this browser's subscription, server row first.
 *
 * Exported because sign-out has to call it too, and sign-out is not a hook:
 * the row is keyed to the account that created it, so leaving it behind means
 * the next person on this device gets the last person's mentions.
 */
export async function unsubscribeFromPush(): Promise<void> {
  if (!pushSupported()) return;
  const subscription = await currentSubscription();
  if (subscription === null) return;
  // Server first: if the browser end went away and the row did not, the
  // endpoint is a ghost that only stops when the push service 410s it.
  await api.push.unsubscribe({ platform: 'web', endpoint: subscription.endpoint });
  await subscription.unsubscribe();
}

/**
 * Opt-in state for OS notifications, plus the two actions that change it.
 *
 * What earns a real notification is decided on the server (mentions, invites,
 * room-started) and rendered in sw.js; ordinary chat never does. This hook only
 * owns the permission and the subscription.
 */
export function usePushNotifications(): PushSubscriptionControls {
  const [state, setState] = useState<PushPermission>('checking');
  const [busy, setBusy] = useState(false);

  /** Read-only: this must never trigger a permission prompt. */
  const refresh = useCallback(async (): Promise<void> => {
    if (!pushSupported()) {
      setState('unsupported');
      return;
    }
    if (Notification.permission === 'denied') {
      setState('blocked');
      return;
    }
    const subscription = await currentSubscription();
    setState(subscription === null ? 'off' : 'on');
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const enable = useCallback(async (): Promise<PushPermission> => {
    if (!pushSupported()) return 'unsupported';
    setBusy(true);
    try {
      const registration = await ensureRegistration();
      // The prompt, at the only moment it is ever allowed to happen: inside a
      // handler the person started.
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        const refused = permission === 'denied' ? 'blocked' : 'off';
        setState(refused);
        return refused;
      }
      const { publicKey } = await api.push.publicKey();
      if (publicKey === null) {
        throw new Error('This server has no push keys configured.');
      }
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          // Required by Chrome: every push we accept must show something.
          userVisibleOnly: true,
          applicationServerKey: applicationServerKey(publicKey),
        }));
      const keys = subscription.toJSON().keys;
      if (keys?.p256dh === undefined || keys.auth === undefined) {
        throw new Error('This browser returned a subscription with no keys.');
      }
      await api.push.subscribe({
        platform: 'web',
        endpoint: subscription.endpoint,
        keys: { p256dh: keys.p256dh, auth: keys.auth },
      });
      setState('on');
      return 'on';
    } finally {
      setBusy(false);
    }
  }, []);

  const disable = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      await unsubscribeFromPush();
      setState('off');
    } finally {
      setBusy(false);
    }
  }, []);

  return { state, busy, enable, disable };
}
