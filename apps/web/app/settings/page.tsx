'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DeleteMeResponse,
  ListSessionsResponse,
  MeExportResponse,
  RevokeAllSessionsResponse,
} from '@gather/contracts';
import type { AccentColor } from '@gather/contracts';
import { api, apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { describeError } from '@/lib/describe-error';
import { formatTimestamp } from '@/lib/format';
import { usePushNotifications, unsubscribeFromPush } from '@/hooks/useServiceWorker';
import { useTheme } from '@/hooks/useTheme';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { Logo } from '@/components/Logo';

const ACCENT_PRESETS = ['#7c5cfc', '#d64db8', '#e8b34d', '#4dc9e8', '#5ce88a', '#ff6b6b'];

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="glass-panel flex flex-col gap-4 p-6">
      <div>
        <h2 className="font-display text-lg font-semibold text-hi">{title}</h2>
        <p className="text-sm text-mid">{description}</p>
      </div>
      {children}
    </section>
  );
}

function ProfileSection() {
  const { user, setUser } = useAuth();
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [avatarUrl, setAvatarUrl] = useState(user?.avatarUrl ?? '');
  const [accentColor, setAccentColor] = useState<string>(user?.accentColor ?? ACCENT_PRESETS[0] ?? '#7c5cfc');
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (user === null) return;
    setDisplayName(user.displayName);
    setAvatarUrl(user.avatarUrl ?? '');
    setAccentColor(user.accentColor);
  }, [user]);

  const save = async () => {
    if (pending || user === null) return;
    setPending(true);
    try {
      const body: { displayName?: string; avatarUrl?: string | null; accentColor?: AccentColor } = {};
      if (displayName.trim() !== user.displayName) body.displayName = displayName.trim();
      const nextAvatar = avatarUrl.trim();
      if (nextAvatar !== (user.avatarUrl ?? '')) body.avatarUrl = nextAvatar === '' ? null : nextAvatar;
      if (accentColor !== user.accentColor) body.accentColor = accentColor as AccentColor;
      const { user: updated } = await api.auth.updateProfile(body);
      setUser(updated);
      toast.success('Profile saved');
    } catch {
      toast.error('Could not save your profile.');
    } finally {
      setPending(false);
    }
  };

  if (user === null) return null;
  return (
    <Section title="Profile" description="How you appear inside rooms.">
      {/* Avatars are a URL, not an upload. The file picker that used to sit
          here ran the whole thing through services/media: a multipart POST for
          the bytes, then a poll of the library listing waiting for the
          transcoder's 640w thumbnail. That service is deleted, so the POST 404d
          and the poll had nothing to read — every press ended in "Uploads are
          offline on this server — paste an image URL instead." This is that
          sentence, as a field instead of a dead end. */}
      <div className="flex items-center gap-4">
        <Avatar src={user.avatarUrl} name={user.displayName} accentColor={accentColor} size={64} />
        <Input
          aria-label="Avatar image URL"
          placeholder="Paste an image URL"
          value={avatarUrl}
          onChange={(e) => {
            setAvatarUrl(e.target.value);
          }}
        />
      </div>
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-mid">Display name</span>
        <Input
          maxLength={80}
          value={displayName}
          onChange={(e) => {
            setDisplayName(e.target.value);
          }}
        />
      </label>
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium text-mid">Accent color</legend>
        <div className="flex gap-2">
          {ACCENT_PRESETS.map((hex) => (
            <button
              key={hex}
              type="button"
              aria-label={`Accent color ${hex}`}
              aria-pressed={accentColor === hex}
              onClick={() => {
                setAccentColor(hex);
              }}
              className={
                accentColor === hex
                  ? 'h-9 w-9 rounded-full ring-2 ring-ring ring-offset-2 ring-offset-void'
                  : 'h-9 w-9 rounded-full ring-1 ring-border-glass transition-transform hover:scale-105'
              }
              style={{ backgroundColor: hex }}
            />
          ))}
        </div>
      </fieldset>
      <div>
        <Button onClick={() => void save()} disabled={pending || displayName.trim().length === 0}>
          {pending ? 'Saving…' : 'Save profile'}
        </Button>
      </div>
    </Section>
  );
}

function SessionsSection() {
  const sessionsQuery = useQuery({
    queryKey: ['sessions'],
    queryFn: () => apiFetch('/auth/sessions', { schema: ListSessionsResponse }),
  });

  const revokeAll = async () => {
    try {
      const res = await apiFetch('/auth/sessions/revoke-all', {
        method: 'POST',
        schema: RevokeAllSessionsResponse,
      });
      toast.success(`Signed out ${res.revoked} other ${res.revoked === 1 ? 'session' : 'sessions'}`);
      await sessionsQuery.refetch();
    } catch {
      toast.error('Could not sign out everywhere.');
    }
  };

  return (
    <Section title="Sessions" description="Every device currently signed in.">
      {sessionsQuery.isPending ? (
        <Skeleton className="h-20" />
      ) : sessionsQuery.isError ? (
        <p role="alert" className="text-sm text-mid">Couldn’t load sessions.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {sessionsQuery.data.sessions.map((s) => (
            <li key={s.id} className="glass-raised flex items-center gap-3 px-3 py-2.5">
              <span aria-hidden className="text-lg">{/mobile|ios|android/i.test(s.device) ? '📱' : '💻'}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-hi">{s.device}</p>
                <p className="text-xs text-low">
                  Last active {formatTimestamp(s.lastSeenAt)}
                </p>
              </div>
              {s.current && <Badge variant="aurora">This device</Badge>}
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button variant="secondary" onClick={() => void revokeAll()}>
          Sign out everywhere else
        </Button>
      </div>
    </Section>
  );
}

function DataSection() {
  const router = useRouter();
  const { logout } = useAuth();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const exportData = async () => {
    try {
      const data = await apiFetch('/me/export', { schema: MeExportResponse });
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `gather-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Export downloaded');
    } catch {
      toast.error('Export failed. Try again.');
    }
  };

  const deleteAccount = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      const res = await apiFetch('/me', { method: 'DELETE', schema: DeleteMeResponse });
      toast.success(`Account deletion scheduled for ${new Date(res.purgeAt).toLocaleDateString()}`);
      // Erasure drops the server row; this drops the browser end, so the
      // device stops holding a subscription to an account that is going away.
      await unsubscribeFromPush().catch(() => undefined);
      await logout();
      router.replace('/login');
    } catch {
      toast.error('Could not delete the account.');
      setDeleting(false);
    }
  };

  return (
    <Section title="Your data" description="GDPR: export everything, or delete everything. No trackers, ever.">
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => void exportData()}>
          Export my data (JSON)
        </Button>
        <Button variant="destructive" onClick={() => {
          setConfirmOpen(true);
        }}>
          Delete account
        </Button>
      </div>
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent aria-label="Delete account confirmation">
          <DialogTitle>Delete your account?</DialogTitle>
          <DialogDescription>
            Your account, messages, uploads and memberships are scheduled for deletion after a
            short grace period. This cannot be undone once the purge runs.
          </DialogDescription>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => {
              setConfirmOpen(false);
            }}>
              Keep my account
            </Button>
            <Button variant="destructive" disabled={deleting} onClick={() => void deleteAccount()}>
              {deleting ? 'Deleting…' : 'Delete everything'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Section>
  );
}

/**
 * The opt-in, and the only place in the app that may ask for notification
 * permission. Nothing prompts on load: an unprompted permission dialog is how
 * an origin gets permanently blocked, and a blocked origin can never ask again.
 *
 * The copy states the actual policy, because the policy is the reassurance —
 * this is a watch-together app and nothing may interrupt what is playing. The
 * server pushes @mentions, invites and room-starts only; ordinary chat is the
 * unread badge on the Chat tab, and sw.js additionally stays silent for a room
 * you already have open on screen.
 */
function NotificationsSection() {
  const { state, busy, enable, disable } = usePushNotifications();

  const toggle = async (on: boolean) => {
    try {
      if (!on) {
        await disable();
        toast.success('Notifications off');
        return;
      }
      const settled = await enable();
      if (settled === 'on') {
        toast.success('Notifications on — @mentions only');
      } else if (settled === 'blocked') {
        toast.error('Your browser blocked notifications for this site.');
      }
      // 'off' means the prompt was dismissed. That is an answer, not a
      // failure — the switch stays off and nothing needs saying.
    } catch (err) {
      toast.error(describeError(err, 'Could not change notification settings.'));
    }
  };

  return (
    <Section
      title="Notifications"
      description="Only @mentions, invites, and a room starting. Never ordinary chat, and never while you already have that room open."
    >
      {state === 'checking' ? (
        <Skeleton className="h-9" />
      ) : state === 'unsupported' ? (
        <p className="text-sm text-mid">
          This browser can’t do push notifications. On iOS, add Gather to your Home Screen first.
        </p>
      ) : state === 'blocked' ? (
        <p role="alert" className="text-sm text-mid">
          Notifications are blocked for this site. Re-allow them in your browser’s site settings,
          then come back.
        </p>
      ) : (
        <label className="flex items-center justify-between gap-4">
          <span className="text-sm text-mid">Notify me when someone @mentions me</span>
          <Switch
            aria-label="Notify me when someone @mentions me"
            checked={state === 'on'}
            disabled={busy}
            onCheckedChange={(on) => {
              void toggle(on);
            }}
          />
        </label>
      )}
    </Section>
  );
}

function AppearanceSection() {
  const { theme, setTheme } = useTheme();
  return (
    <Section title="Appearance" description="Dark is the home theme; Daylight is a first-class variant.">
      <label className="flex items-center justify-between gap-4">
        <span className="text-sm text-mid">Daylight theme</span>
        <Switch
          aria-label="Daylight theme"
          checked={theme === 'light'}
          onCheckedChange={(on) => {
            setTheme(on ? 'light' : 'dark');
          }}
        />
      </label>
    </Section>
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, loading, logout } = useAuth();

  useEffect(() => {
    if (!loading && user === null) router.replace('/login');
  }, [user, loading, router]);

  if (loading || user === null) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-6 px-4 py-6">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-48" />
        <Skeleton className="h-32" />
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-6 px-4 py-6">
      <header className="flex items-center gap-3">
        <Link href="/home" className="flex items-center gap-2.5" aria-label="Back to rooms">
          <Logo size={30} />
        </Link>
        <h1 className="font-display text-xl font-bold">Settings</h1>
        {user.email === null && (
          <Badge variant="warn">Guest — add an email to keep this identity</Badge>
        )}
        <div className="ml-auto">
          <Button
            variant="ghost"
            onClick={() => {
              // Before the token goes, not after: the subscription row belongs
              // to THIS account, and a device left subscribed keeps delivering
              // one person's mentions to whoever signs in next. A failure here
              // must never trap someone in a session they asked to leave.
              void unsubscribeFromPush()
                .catch(() => undefined)
                .then(() => logout())
                .then(() => queryClient.clear())
                .then(() => {
                  router.replace('/login');
                });
            }}
          >
            Sign out
          </Button>
        </div>
      </header>

      <ProfileSection />
      <NotificationsSection />
      <AppearanceSection />
      <SessionsSection />
      <DataSection />

      <nav aria-label="Legal" className="flex gap-4 text-xs text-low">
        <Link className="transition-colors hover:text-mid" href="/legal/terms">Terms</Link>
        <Link className="transition-colors hover:text-mid" href="/legal/privacy">Privacy</Link>
        <Link className="transition-colors hover:text-mid" href="/legal/abuse">Abuse &amp; DMCA</Link>
      </nav>
    </main>
  );
}
