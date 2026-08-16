'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, ChunkedUploader } from '@gather/api-client';
import {
  CreateCheckoutSessionResponse,
  CreatePortalSessionResponse,
  DeleteMeResponse,
  GetEntitlementsResponse,
  ListSessionsResponse,
  MeExportResponse,
  RevokeAllSessionsResponse,
} from '@gather/contracts';
import type { AccentColor } from '@gather/contracts';
import { api, apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatBytes, formatTimestamp } from '@/lib/format';
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
  const fileRef = useRef<HTMLInputElement>(null);

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

  const uploadAvatar = async (file: File) => {
    try {
      // ChunkedUploader owns the multipart mechanics: it forwards the REAL
      // per-part ETags to completeUpload (a hand-rolled loop with fake etags
      // is rejected by MinIO/S3) and handles the CORS ExposeHeaders:ETag
      // failure mode with a readable error.
      const uploader = new ChunkedUploader(api);
      const asset = await uploader.upload({
        filename: file.name,
        mime: file.type || 'image/png',
        sizeBytes: file.size,
        readPart: async (start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer()),
      });
      toast.success('Avatar uploaded — processing…');
      // The media pipeline processes async; its thumbnail (source scaled to
      // 640w) is the public URL we can persist. Poll briefly, then save.
      for (let attempt = 0; attempt < 15; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const page = await api.media.listLibrary({ limit: 50 });
        const processed = page.items.find((item) => item.id === asset.id);
        if (processed === undefined || processed.status === 'failed') break;
        if (processed.status === 'ready') {
          const url = processed.thumbnailUrl;
          if (url !== null) {
            setAvatarUrl(url);
            const { user: updated } = await api.auth.updateProfile({ avatarUrl: url });
            setUser(updated);
            toast.success('Avatar saved');
            return;
          }
          break;
        }
      }
      toast.error('Could not process that image — paste an image URL instead.');
    } catch {
      toast.error('Uploads are offline on this server — paste an image URL instead.');
    }
  };

  if (user === null) return null;
  return (
    <Section title="Profile" description="How you appear inside rooms.">
      <div className="flex items-center gap-4">
        <Avatar src={user.avatarUrl} name={user.displayName} accentColor={accentColor} size={64} />
        <div className="flex flex-col gap-2">
          <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
            Upload avatar
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            aria-label="Upload avatar image"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file !== undefined) void uploadAvatar(file);
              e.target.value = '';
            }}
          />
          <Input
            aria-label="Avatar image URL"
            placeholder="…or paste an image URL"
            value={avatarUrl}
            onChange={(e) => {
              setAvatarUrl(e.target.value);
            }}
          />
        </div>
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

function BillingSection() {
  const entitlementsQuery = useQuery({
    queryKey: ['entitlements'],
    queryFn: () => apiFetch('/billing/entitlements', { schema: GetEntitlementsResponse }),
  });

  const open = async (kind: 'checkout' | 'portal') => {
    try {
      const res =
        kind === 'checkout'
          ? await apiFetch('/billing/checkout-session', {
              method: 'POST',
              body: { plan: 'premium' as const },
              schema: CreateCheckoutSessionResponse,
            })
          : await apiFetch('/billing/portal-session', {
              method: 'POST',
              schema: CreatePortalSessionResponse,
            });
      window.location.assign(res.url);
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'NOT_FOUND' || err.code === 'INTERNAL')) {
        toast.error('Billing is not configured on this server.');
      } else {
        toast.error('Could not reach billing. Try again.');
      }
    }
  };

  return (
    <Section title="Plan" description="Free is the full product; Premium adds Theater mode and bigger calls.">
      {entitlementsQuery.isPending ? (
        <Skeleton className="h-16" />
      ) : entitlementsQuery.isError ? (
        <p role="alert" className="text-sm text-mid">Couldn’t load plan details.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant={entitlementsQuery.data.entitlements.plan === 'premium' ? 'aurora' : 'default'}>
            {entitlementsQuery.data.entitlements.plan === 'premium' ? 'Premium' : 'Free'}
          </Badge>
          <span className="text-xs text-low">
            {entitlementsQuery.data.entitlements.maxPublishers} people on camera or mic ·{' '}
            {formatBytes(entitlementsQuery.data.entitlements.uploadQuotaGb * 1_073_741_824)} upload quota
            {entitlementsQuery.data.entitlements.relayAllowed ? ' · Theater mode' : ''}
          </span>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {entitlementsQuery.data?.entitlements.plan === 'premium' ? (
          <Button variant="secondary" onClick={() => void open('portal')}>
            Manage subscription
          </Button>
        ) : (
          <Button onClick={() => void open('checkout')}>Upgrade to Premium</Button>
        )}
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
              void logout()
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
      <AppearanceSection />
      <SessionsSection />
      <BillingSection />
      <DataSection />

      <nav aria-label="Legal" className="flex gap-4 text-xs text-low">
        <Link className="transition-colors hover:text-mid" href="/legal/terms">Terms</Link>
        <Link className="transition-colors hover:text-mid" href="/legal/privacy">Privacy</Link>
        <Link className="transition-colors hover:text-mid" href="/legal/abuse">Abuse &amp; DMCA</Link>
      </nav>
    </main>
  );
}
