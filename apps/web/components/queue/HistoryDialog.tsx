'use client';

/**
 * What this room has played — the room's own history, and the replacement for
 * the "Library" that used to sit in this slot. The library's backend
 * (services/media) was deleted, so that button opened a dialog that fetched a
 * 404 and showed an empty box forever; this one shows things that actually
 * happened here, and the obvious action on a row is to play it again.
 *
 * DELIBERATELY NOT react-query. components/ui/tabs.tsx unmounts the inactive
 * pane, so this component is destroyed and rebuilt every time someone leaves
 * the Queue tab and comes back — there is no "stays mounted" to lean on and
 * nothing to keep warm. A plain fetch on mount is the whole lifecycle, and it
 * is also the correct one: history changes while you are not looking at it, so
 * a cached first paint would be a lie more often than a saving.
 *
 * The names lookup is best-effort on purpose. A history you can read with one
 * name missing beats a history that refuses to render because the roster call
 * failed.
 */
import { useCallback, useEffect, useState } from 'react';
import type { QueueItemInput, RoomHistoryEntry, RoomId } from '@gather/contracts';
import { api } from '@/lib/api';
import { describeError } from '@/lib/describe-error';
import { formatDurationMs, formatTimestamp } from '@/lib/format';
import { providerLabel } from '@/lib/labels';
import { mediaKindFor } from '@/lib/media-kind';
import { useRoom, useRoomConnection } from '@/lib/room-context';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { MediaRow } from '@/components/ui/media-row';
import { HistoryIcon, PlusIcon } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';

/** How many rows one read pulls. Two screenfuls — enough that "Show older"
 *  is rare, small enough that opening the panel is never a download. */
const PAGE_SIZE = 30;

/**
 * A history entry as a queue add. This is why the entry stores the title and
 * the artwork next to the ref: re-queueing must not need a second lookup or a
 * live queue row, because by the time anyone wants it, neither exists.
 */
export function historyEntryToQueueInput(entry: RoomHistoryEntry): QueueItemInput {
  return {
    mediaRef: entry.mediaRef,
    title: entry.title,
    durationMs: entry.durationMs,
    artworkUrl: entry.artworkUrl,
  };
}

/**
 * "queued by Ada", or "queued by Ada, played by Ben" when someone else was the
 * one who put it on. Null when the roster has not named them — a raw user id
 * is not a person's name and is worse than saying nothing.
 */
function whoLine(
  entry: RoomHistoryEntry,
  me: string,
  names: Record<string, string>,
): string | null {
  const nameOf = (id: string): string | undefined => (id === me ? 'you' : names[id]);
  const queuer = nameOf(entry.queuedBy);
  if (queuer === undefined) return null;
  const starter = entry.startedBy === entry.queuedBy ? undefined : nameOf(entry.startedBy);
  return starter === undefined
    ? `queued by ${queuer}`
    : `queued by ${queuer}, played by ${starter}`;
}

/**
 * The first paint, cut like the rows it stands in for: a 48px poster, a title
 * line and a shorter meta line, at the row's own pitch. "Loading…" is a
 * spinner wall with better manners (§10) — it says nothing about what is
 * coming, and the panel visibly re-shapes when it arrives.
 *
 * The widths differ per row on purpose. Four identical bars read as a loading
 * GRAPHIC; four unequal ones read as titles that have not landed yet.
 */
const SKELETON_WIDTHS: readonly [string, string][] = [
  ['w-3/5', 'w-2/5'],
  ['w-4/5', 'w-1/3'],
  ['w-1/2', 'w-2/5'],
  ['w-2/3', 'w-1/4'],
];

function HistorySkeleton() {
  return (
    <div>
      <p role="status" className="sr-only">
        Loading what this room has played.
      </p>
      <ul aria-hidden className="flex flex-col gap-1">
        {SKELETON_WIDTHS.map(([title, meta]) => (
          <li key={title} className="flex min-h-row items-center gap-3 px-2 py-2">
            <Skeleton radius="ctl" className="h-12 w-12 shrink-0" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Skeleton radius="ctl" className={`h-4 ${title}`} />
              <Skeleton radius="ctl" className={`h-3 ${meta}`} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface LoadState {
  entries: RoomHistoryEntry[];
  nextBefore: number | null;
  /** Null while loading, null on success; a sentence when the read failed. */
  error: string | null;
  loading: boolean;
}

/**
 * The list itself, separated from the dialog chrome so it can be rendered
 * (and tested) on its own.
 */
export function HistoryList({ roomId }: { roomId: RoomId }) {
  const connection = useRoomConnection();
  const { member } = useRoom();
  const me = member.userId;
  const [names, setNames] = useState<Record<string, string>>({});
  const [state, setState] = useState<LoadState>({
    entries: [],
    nextBefore: null,
    error: null,
    loading: true,
  });

  useEffect(() => {
    let live = true;
    setState({ entries: [], nextBefore: null, error: null, loading: true });
    void api.rooms
      .getHistory(roomId, { limit: PAGE_SIZE })
      .then((page) => {
        if (!live) return;
        setState({
          entries: page.entries,
          nextBefore: page.nextBefore,
          error: null,
          loading: false,
        });
      })
      .catch((err: unknown) => {
        if (!live) return;
        setState({
          entries: [],
          nextBefore: null,
          error: describeError(err, "Couldn't load what this room has played."),
          loading: false,
        });
      });
    // Best-effort: a missing roster costs a name, never the list.
    void api.rooms
      .listMembers(roomId)
      .then((res) => {
        if (!live) return;
        const map: Record<string, string> = {};
        for (const row of res.members) {
          map[row.user.id] = row.user.displayName;
        }
        setNames(map);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [roomId]);

  const loadOlder = useCallback((): void => {
    const before = state.nextBefore;
    if (before === null || state.loading) return;
    setState((s) => ({ ...s, loading: true }));
    void api.rooms
      .getHistory(roomId, { limit: PAGE_SIZE, before })
      .then((page) => {
        setState((s) => ({
          entries: [...s.entries, ...page.entries],
          nextBefore: page.nextBefore,
          error: null,
          loading: false,
        }));
      })
      .catch((err: unknown) => {
        setState((s) => ({
          ...s,
          loading: false,
          error: describeError(err, "Couldn't load older entries."),
        }));
      });
  }, [roomId, state.nextBefore, state.loading]);

  const requeue = (entry: RoomHistoryEntry): void => {
    connection.queueAdd(historyEntryToQueueInput(entry));
    toast.success(`Added ${entry.title} to the queue`);
  };

  if (state.error !== null && state.entries.length === 0) {
    return <p className="py-8 text-center text-body text-warn">{state.error}</p>;
  }
  if (state.loading && state.entries.length === 0) {
    return <HistorySkeleton />;
  }
  if (state.entries.length === 0) {
    return (
      <EmptyState
        icon={<HistoryIcon size={20} />}
        title="Nothing has played here yet"
        description="Whatever this room watches together shows up here, ready to queue again."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-1">
        {state.entries.map((entry) => {
          // Duration is a readout and lives in `trailing`; the meta line is
          // for the things a sentence is the right shape for.
          const meta = [providerLabel(entry.mediaRef), whoLine(entry, me, names), formatTimestamp(entry.playedAt)]
            .filter((part): part is string => part !== null)
            .join(' · ');
          return (
            <MediaRow
              as="li"
              key={entry.id}
              artwork={{
                src: entry.artworkUrl,
                alt: entry.title,
                // Null only for a null ref, which a history entry cannot have.
                kind: mediaKindFor(entry.mediaRef) ?? 'video',
                shape: 'square',
              }}
              title={entry.title}
              meta={meta}
              trailing={entry.durationMs !== null ? formatDurationMs(entry.durationMs) : null}
              actions={
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Add ${entry.title} to the queue`}
                  onClick={() => {
                    requeue(entry);
                  }}
                >
                  <PlusIcon size={16} aria-hidden />
                </Button>
              }
            />
          );
        })}
      </ul>
      {state.error !== null && <p className="px-1 text-label text-warn">{state.error}</p>}
      {state.nextBefore !== null && (
        // Centred and only as wide as its label: in a flex column a plain
        // button stretches to the panel, which makes "Show older" look like
        // the dialog's primary action rather than the end of a list.
        <Button
          size="sm"
          variant="ghost"
          className="self-center"
          onClick={loadOlder}
          disabled={state.loading}
        >
          {state.loading ? 'Loading…' : 'Show older'}
        </Button>
      )}
    </div>
  );
}

/** The Queue pane's History affordance: the list in a dialog. */
export function RecentlyPlayed({
  roomId,
  open,
  onOpenChange,
}: {
  roomId: RoomId;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-label="What this room has played">
        {/* The overline is the hierarchy the dialog was missing: it says WHOSE
            history this is, so the title is free to be one short noun. */}
        <p className="text-caption text-low">This room</p>
        <DialogTitle>Recently played</DialogTitle>
        <DialogDescription>
          Everything this room has played, newest first. Add any of it back to the queue.
        </DialogDescription>
        <div className="mt-6 max-h-96 overflow-y-auto">
          {/* Mounted only while open, so opening the dialog is the read. */}
          {open && <HistoryList roomId={roomId} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
