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
import { MonitorIcon, SmartphoneIcon } from '@/components/ui/icons';
import { Wordmark } from '@/components/Logo';

/**
 * ACCOUNT DATA, not palette. `AccentColor` is a `#rrggbb` string persisted on
 * the user row and rendered as their avatar ring wherever they appear, so these
 * are the presets offered for a value the PERSON owns — the one kind of colour
 * in the product that cannot come from `packages/design/src/tokens.ts`, because
 * the point of it is that it is not the product's colour. Nothing in the design
 * system may read them, and they are never used as a surface or as ink.
 */
const ACCENT_PRESETS = ['#7c5cfc', '#d64db8', '#e8b34d', '#4dc9e8', '#5ce88a', '#ff6b6b'];

function Section({
  title,
  description,
  children,
}: {
  title: string;
  /** One sentence only when the title alone would mislead; controls that
   *  explain themselves get no narration. */
  description?: string;
  children: ReactNode;
}) {
  // Solid ladder, not glass: a settings section is a resting surface on a
  // static page, and DESIGN.md §4 reserves glass for things floating over
  // moving video.
  return (
    <section className="flex flex-col gap-6 rounded-panel bg-surface-1 p-6 md:p-8">
      <div>
        <h2 className="font-display text-title text-hi">{title}</h2>
        {description !== undefined && (
          <p className="mt-1 max-w-prose text-body text-mid">{description}</p>
        )}
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
      toast.error('Couldn’t save your profile. Try again.');
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
          inputSize="lg"
          placeholder="Paste an image URL"
          value={avatarUrl}
          onChange={(e) => {
            setAvatarUrl(e.target.value);
          }}
        />
      </div>
      <label className="flex flex-col gap-2">
        <span className="text-label text-mid">Display name</span>
        <Input
          maxLength={80}
          inputSize="lg"
          value={displayName}
          onChange={(e) => {
            setDisplayName(e.target.value);
          }}
        />
      </label>
      <fieldset>
        <legend className="mb-3 text-label text-mid">Accent color</legend>
        <div className="flex flex-wrap gap-3">
          {ACCENT_PRESETS.map((hex) => (
            <button
              key={hex}
              type="button"
              aria-label={`Accent color ${hex}`}
              aria-pressed={accentColor === hex}
              onClick={() => {
                setAccentColor(hex);
              }}
              // `h-ctl-md w-ctl-md`, not `h-9 w-9`. A hand-written 36px square
              // is a touch target under DESIGN.md §9's 44px floor on every
              // phone — and the control tokens already answer this: 32px
              // under a mouse, 44px under a finger, decided by
              // `(pointer: coarse)` rather than by a breakpoint guess.
              className={
                accentColor === hex
                  ? 'h-ctl-md w-ctl-md rounded-pill ring-2 ring-ring ring-offset-2 ring-offset-surface-1'
                  : 'h-ctl-md w-ctl-md rounded-pill ring-1 ring-hairline transition-transform hover:scale-105'
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
      toast.error('Couldn’t sign out your other sessions. Try again.');
    }
  };

  return (
    <Section title="Sessions" description="Every device currently signed in.">
      {sessionsQuery.isPending ? (
        <Skeleton className="h-20" />
      ) : sessionsQuery.isError ? (
        <p role="alert" className="text-body text-mid">
          Couldn’t load your sessions. Reload the page to try again.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {sessionsQuery.data.sessions.map((s) => (
            <li
              key={s.id}
              // The chip takes 94px of a 247px row, which left the column
              // beside it 101px for a 105px "Last active 03:16" — so the one
              // row that carries a chip was also the only one whose metadata
              // came down as two lines. Below `sm` the chip drops to a line of
              // its own instead; from `sm` up the row is what it was.
              className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-card bg-surface-2 px-4 py-3 sm:flex-nowrap"
            >
              {/* Icons, not emoji: a device glyph is a control-adjacent label,
                  and DESIGN.md §8 keeps emoji for content only. */}
              <span aria-hidden className="text-low">
                {/mobile|ios|android/i.test(s.device) ? (
                  <SmartphoneIcon size={20} />
                ) : (
                  <MonitorIcon size={20} />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-body text-hi">{s.device}</p>
                <p className="text-label text-low">Last active {formatTimestamp(s.lastSeenAt)}</p>
              </div>
              {/* The wrapper, not the chip, carries `basis-full`: a chip given
                  a 100% basis stretches into a 247px pill. This one takes the
                  line and lets the chip stay the size of its own label. */}
              {s.current && (
                <div className="basis-full sm:basis-auto">
                  <Badge variant="aurora">This device</Badge>
                </div>
              )}
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
      toast.error('Couldn’t export your data. Try again.');
    }
  };

  const deleteAccount = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      const res = await apiFetch('/me', { method: 'DELETE', schema: DeleteMeResponse });
      toast.success(`Your account will be deleted on ${new Date(res.purgeAt).toLocaleDateString()}`);
      // Erasure drops the server row; this drops the browser end, so the
      // device stops holding a subscription to an account that is going away.
      await unsubscribeFromPush().catch(() => undefined);
      await logout();
      router.replace('/login');
    } catch {
      toast.error('Couldn’t delete your account. Try again.');
      setDeleting(false);
    }
  };

  return (
    <Section title="Your data">
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
            We’ll delete your account, messages, uploads and room memberships after a short
            grace period. Once they’re deleted, you can’t get them back.
          </DialogDescription>
          <div className="mt-8 flex flex-wrap justify-end gap-4">
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
        toast.success('Notifications on');
      } else if (settled === 'blocked') {
        toast.error(
          'Your browser blocked notifications. Allow them in your browser’s site settings.',
        );
      }
      // 'off' means the prompt was dismissed. That is an answer, not a
      // failure — the switch stays off and nothing needs saying.
    } catch (err) {
      toast.error(describeError(err, 'Couldn’t change notification settings.'));
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
        <p className="text-body text-mid">
          This browser doesn’t support notifications. On iOS, add Gather to your Home Screen first.
        </p>
      ) : state === 'blocked' ? (
        <p role="alert" className="text-body text-mid">
          Notifications are blocked. Allow them in your browser’s site settings, then come back.
        </p>
      ) : (
        <label className="flex items-center justify-between gap-4">
          <span className="text-body text-mid">Notify me when someone @mentions me</span>
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
    <Section title="Appearance">
      <label className="flex items-center justify-between gap-4">
        <span className="text-body text-mid">Daylight theme</span>
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
    // The placeholder mirrors the real composition below rung for rung —
    // same header, same `gap-section pt-chapter` main, same `gap-4` stack of
    // panels. It used to carry `gap-6` on the container AND `mt-chapter` /
    // `mt-section` on the children, so every gap was the sum of two rungs and
    // nothing landed where the loaded page put it. A placeholder whose rhythm
    // is not the page's rhythm re-lays the screen out at the moment the data
    // arrives, which is the one thing a skeleton exists to prevent.
    return (
      <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-6 lg:px-10">
        <header className="py-6">
          <Skeleton radius="ctl" className="h-8 w-40" />
        </header>
        <main className="flex flex-col gap-8 pt-12 md:gap-section md:pt-chapter">
          <div className="flex flex-col gap-4">
            <Skeleton radius="ctl" className="h-3 w-24" />
            <Skeleton radius="ctl" className="h-11 w-64" />
          </div>
          <div className="flex flex-col gap-4">
            <Skeleton radius="panel" className="h-64" />
            <Skeleton radius="panel" className="h-40" />
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-6 lg:px-10">
      <header className="flex items-center gap-4 py-6">
        <Link href="/home" aria-label="Back to rooms">
          <Wordmark size={30} />
        </Link>
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

      {/* One display setting, and it names the screen (DESIGN.md §3). The
          section heads below stay at `title` — they name a block inside it. */}
      {/* Composition rungs halve below `md` (see app/home/page.tsx). */}
      <main className="flex flex-1 flex-col gap-8 pt-12 md:gap-section md:pt-chapter">
        <div>
          <p className="text-caption text-low">Account</p>
          <h1 className="mt-4 font-display text-headline text-hi md:text-display">Settings</h1>
          {user.email === null && (
            <p className="mt-6">
              <Badge variant="warn">Guest — add an email to keep this account</Badge>
            </p>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <ProfileSection />
          <NotificationsSection />
          <AppearanceSection />
          <SessionsSection />
          <DataSection />
        </div>
      </main>

      <footer className="mt-8 flex flex-wrap items-center gap-6 border-t border-hairline py-8 text-label text-low md:mt-section">
        <nav aria-label="Legal" className="flex gap-6">
          <Link className="transition-colors hover:text-hi" href="/legal/terms">Terms</Link>
          <Link className="transition-colors hover:text-hi" href="/legal/privacy">Privacy</Link>
          <Link className="transition-colors hover:text-hi" href="/legal/abuse">Abuse &amp; DMCA</Link>
        </nav>
      </footer>
    </div>
  );
}
