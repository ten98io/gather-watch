'use client';

/**
 * /admin — owner ops panel. Every card polls the /admin/* endpoints
 * (contracts-validated via apiFetch) and re-renders live. Access is enforced
 * server-side (ADMIN_EMAILS); the UI mirrors it honestly: 401 → sign-in
 * nudge, 403 → "not an owner account".
 *
 * Scope (binding): operational telemetry only — counts, gauges, aggregates,
 * abuse reports. No message content, no play-activity telemetry (spec
 * safeguards: private rooms stay private).
 */
import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  AdminMetricsResponse,
  AdminOverviewResponse,
  AdminReportsResponse,
  AdminResolveReportResponse,
  AdminRoomsResponse,
  AdminUsageResponse,
  AdminUsersResponse,
} from '@playin/contracts';
import type { AdminReport } from '@playin/contracts';
import { ApiError } from '@playin/api-client';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';

const POLL_MS = 5000;

function useAdminQuery<T>(key: string, path: string, schema: { parse(v: unknown): T }) {
  return useQuery({
    queryKey: ['admin', key],
    queryFn: () => apiFetch(path, { schema }),
    refetchInterval: POLL_MS,
    retry: false,
  });
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="glass-raised flex flex-col gap-1 rounded-card p-4">
      <span className="text-xs text-low">{label}</span>
      <span className="font-display text-2xl font-bold text-hi tabular-nums">{value}</span>
      {hint !== undefined && <span className="text-[10px] text-low">{hint}</span>}
    </div>
  );
}

function Panel({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('glass-panel flex min-w-0 flex-col gap-3 p-4', className)}>
      <h2 className="font-display text-sm font-semibold text-mid">{title}</h2>
      {children}
    </section>
  );
}

function OverviewPanel() {
  const q = useAdminQuery('overview', '/admin/overview', AdminOverviewResponse);
  if (q.isPending) return <Skeleton className="h-40 w-full" />;
  if (q.isError) return <p className="text-sm text-danger">Overview failed to load.</p>;
  const o = q.data;
  const upH = Math.floor(o.uptimeSec / 3600);
  const upM = Math.floor((o.uptimeSec % 3600) / 60);
  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Live connections" value={o.live.connections} hint={`${o.live.rooms} active room(s)`} />
        <Stat label="Users" value={o.counts.users} hint={`${o.counts.sessionsActive} sessions`} />
        <Stat label="Rooms" value={o.counts.rooms} hint={`${o.counts.members} memberships`} />
        <Stat label="Messages" value={o.counts.messages} hint={`${o.counts.assets} assets`} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="default">store: {o.adapters.store}</Badge>
        <Badge variant="default">bus: {o.adapters.bus}</Badge>
        <Badge variant="muted">node {o.nodeVersion}</Badge>
        <Badge variant="muted">rss {o.memoryRssMb} MB</Badge>
        <Badge variant="muted">up {upH}h {upM}m</Badge>
        <Badge variant={o.counts.reportsOpen > 0 ? 'aurora' : 'muted'}>
          {o.counts.reportsOpen} open report(s)
        </Badge>
        {(['mediaPipeline', 'sfu', 'gifs', 'stripe', 'push'] as const).map((f) => (
          <Badge key={f} variant={o.features[f] ? 'default' : 'muted'}>
            {f}: {o.features[f] ? 'on' : 'off'}
          </Badge>
        ))}
      </div>
    </>
  );
}

function MetricsPanel() {
  const q = useAdminQuery('metrics', '/admin/metrics', AdminMetricsResponse);
  if (q.isPending) return <Skeleton className="h-40 w-full" />;
  if (q.isError) return <p className="text-sm text-danger">Metrics failed to load.</p>;
  const m = q.data;
  const wsEntries = Object.entries(m.wsEvents);
  return (
    <>
      <div className="flex flex-wrap gap-2 text-xs text-mid">
        <Badge variant="default">{m.totalRequests} requests</Badge>
        <Badge variant={m.total5xx > 0 ? 'aurora' : 'muted'}>{m.total5xx} × 5xx</Badge>
        <Badge variant={m.total4xx > 0 ? 'default' : 'muted'}>{m.total4xx} × 4xx</Badge>
        <span className="text-low">in-process since {new Date(m.since).toLocaleTimeString()} — resets on restart</span>
      </div>
      <div className="max-h-56 overflow-auto">
        <table className="w-full min-w-[420px] text-left text-xs">
          <thead className="sticky top-0 bg-deep text-low">
            <tr>
              <th className="py-1 pr-2">Route</th>
              <th className="py-1 pr-2 text-right">OK</th>
              <th className="py-1 pr-2 text-right">4xx</th>
              <th className="py-1 pr-2 text-right">5xx</th>
              <th className="py-1 text-right">Mean ms</th>
            </tr>
          </thead>
          <tbody>
            {m.requests.map((r) => {
              const n = r.ok + r.clientError + r.serverError;
              return (
                <tr key={`${r.method} ${r.route}`} className="border-t border-border-glass text-mid">
                  <td className="py-1 pr-2 font-mono">{r.method} {r.route}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{r.ok}</td>
                  <td className={cn('py-1 pr-2 text-right tabular-nums', r.clientError > 0 && 'text-warn')}>{r.clientError}</td>
                  <td className={cn('py-1 pr-2 text-right tabular-nums', r.serverError > 0 && 'text-danger')}>{r.serverError}</td>
                  <td className="py-1 text-right tabular-nums">{n > 0 ? (r.totalMs / n).toFixed(1) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {wsEntries.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {wsEntries.map(([type, count]) => (
            <Badge key={type} variant="muted" className="font-mono text-[10px]">
              {type}: {count}
            </Badge>
          ))}
        </div>
      )}
    </>
  );
}

function describeTarget(r: AdminReport): string {
  switch (r.target.kind) {
    case 'message':
      return `message in room ${r.target.roomId.slice(0, 8)}…`;
    case 'user':
      return `user ${r.target.userId.slice(0, 8)}…`;
    case 'room':
      return `room ${r.target.roomId.slice(0, 8)}…`;
    case 'asset':
      return `asset ${r.target.assetId.slice(0, 8)}…`;
  }
}

function ReportsPanel() {
  const q = useAdminQuery('reports', '/admin/reports', AdminReportsResponse);
  const [busy, setBusy] = useState<string | null>(null);

  const resolve = async (reportId: string, dismiss: boolean): Promise<void> => {
    setBusy(reportId);
    try {
      const res = await apiFetch('/admin/reports/resolve', {
        method: 'POST',
        body: { reportId, dismiss },
        schema: AdminResolveReportResponse,
      });
      toast.success(dismiss ? 'Report dismissed' : `Takedown: ${res.action}`);
      await q.refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Resolve failed');
    } finally {
      setBusy(null);
    }
  };

  if (q.isPending) return <Skeleton className="h-32 w-full" />;
  if (q.isError) return <p className="text-sm text-danger">Reports failed to load.</p>;
  const reports = q.data.reports;
  return (
    <>
      {reports.length === 0 ? (
        <p className="text-sm text-low">Inbox zero — no open reports. 🎉</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {reports.map((r) => (
            <li key={r.id} className="rounded-card border border-border-glass bg-glass p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm text-hi">{r.reason}</p>
                  <p className="mt-0.5 text-xs text-low">
                    {describeTarget(r)} · by {r.reporterName ?? 'unknown'} ·{' '}
                    {new Date(r.createdAt).toLocaleString()}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={busy === r.id}
                    onClick={() => void resolve(r.id, false)}
                  >
                    Takedown
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy === r.id}
                    onClick={() => void resolve(r.id, true)}
                  >
                    Dismiss
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function UsagePanel() {
  const q = useAdminQuery('usage', '/admin/usage', AdminUsageResponse);
  if (q.isPending) return <Skeleton className="h-32 w-full" />;
  if (q.isError) return <p className="text-sm text-danger">Usage failed to load.</p>;
  const u = q.data;
  return (
    <>
      <p className="text-[10px] text-low">
        Metering window: {u.windowDays} days · cost attribution + fair-use only
      </p>
      <div className="flex flex-wrap gap-1.5">
        {u.buckets.length === 0 && <span className="text-xs text-low">No usage recorded yet.</span>}
        {u.buckets.map((b) => (
          <Badge key={`${b.kind}:${b.unit}`} variant="default">
            {b.kind}: {b.total.toLocaleString()} {b.unit} ({b.samples})
          </Badge>
        ))}
      </div>
      {u.topRooms.length > 0 && (
        <table className="w-full min-w-[420px] text-left text-xs">
          <thead className="text-low">
            <tr>
              <th className="py-1 pr-2">Room</th>
              <th className="py-1 text-right">Session-min</th>
            </tr>
          </thead>
          <tbody>
            {u.topRooms.map((r) => (
              <tr key={r.roomId} className="border-t border-border-glass text-mid">
                <td className="py-1 pr-2">{r.roomName ?? r.roomId.slice(0, 8)}</td>
                <td className="py-1 text-right tabular-nums">{r.sessionMinutes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function RoomsPanel() {
  const q = useAdminQuery('rooms', '/admin/rooms', AdminRoomsResponse);
  if (q.isPending) return <Skeleton className="h-32 w-full" />;
  if (q.isError) return <p className="text-sm text-danger">Rooms failed to load.</p>;
  return (
    <div className="max-h-64 overflow-auto">
      <table className="w-full min-w-[420px] text-left text-xs">
        <thead className="sticky top-0 bg-deep text-low">
          <tr>
            <th className="py-1 pr-2">Name</th>
            <th className="py-1 pr-2">Kind</th>
            <th className="py-1 pr-2 text-right">Members</th>
            <th className="py-1 pr-2 text-right">Live</th>
            <th className="py-1 pr-2 text-right">Msgs</th>
            <th className="py-1 text-right">Relay</th>
          </tr>
        </thead>
        <tbody>
          {q.data.rooms.map((r) => (
            <tr key={r.room.id} className="border-t border-border-glass text-mid">
              <td className="max-w-40 truncate py-1 pr-2 text-hi">{r.room.name}</td>
              <td className="py-1 pr-2">{r.room.kind}{r.room.theater ? ' 🎭' : ''}</td>
              <td className="py-1 pr-2 text-right tabular-nums">{r.memberCount}</td>
              <td className={cn('py-1 pr-2 text-right tabular-nums', r.liveConnections > 0 && 'text-success')}>
                {r.liveConnections}
              </td>
              <td className="py-1 pr-2 text-right tabular-nums">{r.messageCount}</td>
              <td className="py-1 text-right">{r.room.relayMode}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UsersPanel() {
  const q = useAdminQuery('users', '/admin/users', AdminUsersResponse);
  if (q.isPending) return <Skeleton className="h-32 w-full" />;
  if (q.isError) return <p className="text-sm text-danger">Users failed to load.</p>;
  return (
    <div className="max-h-64 overflow-auto">
      <table className="w-full min-w-[420px] text-left text-xs">
        <thead className="sticky top-0 bg-deep text-low">
          <tr>
            <th className="py-1 pr-2">Name</th>
            <th className="py-1 pr-2">Email</th>
            <th className="py-1 pr-2 text-right">Sessions</th>
            <th className="py-1 pr-2 text-right">Rooms</th>
            <th className="py-1 text-right">Joined</th>
          </tr>
        </thead>
        <tbody>
          {q.data.users.map((u) => (
            <tr key={u.user.id} className="border-t border-border-glass text-mid">
              <td className="max-w-32 truncate py-1 pr-2 text-hi">{u.user.displayName}</td>
              <td className="max-w-40 truncate py-1 pr-2">{u.user.email ?? 'guest'}</td>
              <td className="py-1 pr-2 text-right tabular-nums">{u.activeSessions}</td>
              <td className="py-1 pr-2 text-right tabular-nums">{u.memberships}</td>
              <td className="py-1 text-right">{new Date(u.user.createdAt).toLocaleDateString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function AdminPage() {
  const { user, loading } = useAuth();
  const probe = useAdminQuery('overview', '/admin/overview', AdminOverviewResponse);

  if (loading || probe.isPending) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col gap-4 px-4 py-6" aria-label="Loading admin">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-48 w-full" />
      </main>
    );
  }

  if (user === null) {
    return (
      <Gate emoji="🔑" title="Sign in first">
        <Link href="/login"><Button>Go to sign-in</Button></Link>
      </Gate>
    );
  }

  if (probe.isError) {
    const forbidden = probe.error instanceof ApiError && probe.error.code === 'FORBIDDEN';
    return (
      <Gate
        emoji="🛡"
        title={forbidden ? 'This account is not an owner' : 'Admin API unreachable'}
      >
        <p className="text-sm text-mid">
          {forbidden
            ? 'The admin panel requires an account whose email is listed in ADMIN_EMAILS on the API.'
            : 'Check that the API is running, then retry.'}
        </p>
        <Link href="/home"><Button variant="secondary">Back home</Button></Link>
      </Gate>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <header className="flex items-center gap-3">
        <Link href="/home" aria-label="Back home" className="text-low transition-colors hover:text-hi">
          ←
        </Link>
        <h1 className="font-display text-xl font-bold">Owner console</h1>
        <Badge variant="aurora">live · 5 s</Badge>
        <span className="text-xs text-low">ops telemetry only — content stays private</span>
      </header>

      <Panel title="Overview">
        <OverviewPanel />
      </Panel>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Request metrics">
          <MetricsPanel />
        </Panel>
        <Panel title="Abuse reports">
          <ReportsPanel />
        </Panel>
        <Panel title="Usage metering">
          <UsagePanel />
        </Panel>
        <Panel title="Rooms">
          <RoomsPanel />
        </Panel>
        <Panel title="Users" className="lg:col-span-2">
          <UsersPanel />
        </Panel>
      </div>
    </main>
  );
}

function Gate({
  emoji,
  title,
  children,
}: {
  emoji: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="glass-panel flex w-full max-w-md flex-col items-center gap-4 p-8 text-center shadow-glow">
        <span aria-hidden className="text-4xl">{emoji}</span>
        <h1 className="font-display text-2xl font-bold">{title}</h1>
        {children}
      </div>
    </main>
  );
}
