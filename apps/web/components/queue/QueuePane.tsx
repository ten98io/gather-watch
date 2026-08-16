'use client';

/**
 * QueuePane — the collaborative queue: add by URL (YouTube/direct/HLS) or
 * from your uploaded library, remove, reorder (up/down + drag on desktop),
 * vote-to-skip with the room's configured threshold, and click-to-play via
 * sync.setTrack. Server-authoritative queue.state drives everything.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { QueueItem, QueueItemId, RoomId } from '@playin/contracts';
import { api } from '@/lib/api';
import { canAct, formatMs } from '@/lib/permissions';
import { parseProviderUrl } from '@/lib/providers';
import { useRoom, useRoomConnection } from '@/lib/room-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/cn';

/** Add-from-library: ready HLS assets become queue items. */
function LibraryPicker({ open, onOpenChange }: { open: boolean; onOpenChange(o: boolean): void }) {
  const connection = useRoomConnection();
  const libraryQuery = useQuery({
    queryKey: ['library'],
    queryFn: () => api.media.listLibrary({ limit: 50 }),
    enabled: open,
  });
  const ready = (libraryQuery.data?.items ?? []).filter(
    (a) => a.status === 'ready' && a.hlsUrl !== null,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-label="Add from your library">
        <DialogTitle>Add from your library</DialogTitle>
        <DialogDescription>
          Processed uploads stream as HLS. (The media pipeline is an optional server
          module — if this is empty, paste a direct URL instead.)
        </DialogDescription>
        <div className="mt-3 flex max-h-80 flex-col gap-1 overflow-y-auto">
          {libraryQuery.isPending && <Skeleton className="h-10 w-full" />}
          {libraryQuery.isSuccess && ready.length === 0 && (
            <p className="py-6 text-center text-sm text-low">No processed media yet.</p>
          )}
          {ready.map((a) => (
            <button
              key={a.id}
              type="button"
              className="rounded-ctl border border-border-glass bg-glass px-3 py-2 text-left hover:bg-raised"
              onClick={() => {
                connection.queueAdd({
                  mediaRef: { kind: 'hls', assetId: a.id, url: a.hlsUrl ?? '' },
                  title: a.filename,
                  durationMs: a.durationMs,
                  artworkUrl: a.thumbnailUrl,
                });
                onOpenChange(false);
              }}
            >
              <span className="block truncate text-sm text-hi">{a.filename}</span>
              <span className="text-xs text-low">
                {a.durationMs !== null ? formatMs(a.durationMs) : 'unknown length'}
              </span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function QueueRow({
  item,
  index,
  count,
  isCurrent,
  canQueue,
  memberCount,
  skipThreshold,
}: {
  item: QueueItem;
  index: number;
  count: number;
  isCurrent: boolean;
  canQueue: boolean;
  memberCount: number;
  skipThreshold: number;
}) {
  const connection = useRoomConnection();
  const { member } = useRoom();
  const me = member.userId;
  const voted = item.votesToSkip.includes(me);
  const needed = Math.max(1, Math.ceil(memberCount * skipThreshold));

  const move = (dir: -1 | 1): void => {
    const ids = connection.useRoomState.getState().queue.items.map((it) => it.id);
    const j = index + dir;
    if (j < 0 || j >= ids.length) return;
    const a = ids[index];
    const b = ids[j];
    if (a === undefined || b === undefined) return;
    ids[index] = b;
    ids[j] = a;
    connection.queueReorder(ids as QueueItemId[]);
  };

  return (
    <li
      className={cn(
        'flex flex-wrap items-center gap-2 rounded-card border border-border-glass bg-glass p-2.5',
        isCurrent && 'border-aurora-1 bg-[rgba(149,91,254,0.12)]',
      )}
    >
      {item.artworkUrl !== null ? (
        <img src={item.artworkUrl} alt="" className="h-10 w-10 rounded-ctl object-cover" />
      ) : (
        <span aria-hidden className="flex h-10 w-10 items-center justify-center rounded-ctl bg-raised">
          {item.mediaRef.kind === 'youtube' ? '▶' : item.mediaRef.kind === 'hls' ? '🎬' : item.mediaRef.kind === 'soundcloud' ? '☁' : item.mediaRef.kind === 'vimeo' ? 'Ⓥ' : item.mediaRef.kind === 'embed' ? '●' : '🔗'}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-hi">
          {isCurrent ? '▶ ' : ''}
          {item.title}
        </p>
        <p className="text-xs text-low">
          {item.mediaRef.kind}
          {item.durationMs !== null ? ` · ${formatMs(item.durationMs)}` : ''}
          {item.votesToSkip.length > 0 ? ` · skip ${item.votesToSkip.length}/${needed}` : ''}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1">
        {canQueue && (
          <>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Play this item"
              onClick={() => connection.syncSetTrackByQueue(index)}
            >
              Play
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Move up"
              disabled={index === 0}
              onClick={() => move(-1)}
            >
              ↑
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Move down"
              disabled={index === count - 1}
              onClick={() => move(1)}
            >
              ↓
            </Button>
          </>
        )}
        <Button
          variant={voted ? 'secondary' : 'ghost'}
          size="sm"
          aria-label={voted ? 'Withdraw skip vote' : 'Vote to skip'}
          aria-pressed={voted}
          onClick={() => connection.queueVoteSkip(item.id)}
        >
          {voted ? '✓ Skip' : 'Skip'}
        </Button>
        {canQueue && (
          <Button
            variant="ghost"
            size="sm"
            aria-label="Remove from queue"
            className="text-danger"
            onClick={() => connection.queueRemove(item.id)}
          >
            ✕
          </Button>
        )}
      </div>
    </li>
  );
}

export function QueuePane({ roomId }: { roomId: RoomId }) {
  const connection = useRoomConnection();
  const { room, member } = useRoom();
  const items = connection.useRoomState((s) => s.queue.items);
  const playback = connection.useRoomState((s) => s.playback);
  const presence = connection.useRoomState((s) => s.presence);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);

  const canQueue = canAct(room.policies.queueControl, member.role);
  const memberCount = Math.max(1, Object.keys(presence).length);
  const currentIndex = playback?.queueIndex ?? null;

  const add = (): void => {
    const parsed = parseProviderUrl(draft);
    if (parsed === null) {
      setError('Paste a link from a supported service or a direct media URL (mp4/mp3/m3u8)');
      return;
    }
    if (parsed.ref === null) {
      // DRM tier: recognized, but there is nothing to embed — honest stop.
      setError(
        `${parsed.provider.name} is DRM-protected: no embed exists. It works via the Playin browser extension (everyone watches through their own account) — landing as a separate app.`,
      );
      return;
    }
    const title =
      parsed.titleHint ??
      (parsed.ref.kind === 'youtube' ? `YouTube · ${parsed.ref.videoId}` : 'Shared media');
    connection.queueAdd({
      mediaRef: parsed.ref,
      title,
      durationMs: null,
      artworkUrl: null,
    });
    setDraft('');
    setError(null);
  };

  const parsedPreview = useMemo(() => {
    const trimmed = draft.trim();
    if (trimmed.length < 8) return null;
    return parseProviderUrl(trimmed);
  }, [draft]);

  return (
    <section aria-label="Queue" data-room={roomId} className="flex h-full min-h-0 flex-col">
      {canQueue && (
        <div className="flex flex-col gap-1 border-b border-border-glass p-2">
          <div className="flex gap-2">
            <Input
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') add();
              }}
              placeholder="Add YouTube, SoundCloud, Vimeo, Spotify…"
              aria-label="Add to queue"
            />
            <Button size="sm" onClick={add}>Add</Button>
            <Button size="sm" variant="secondary" onClick={() => setLibraryOpen(true)}>
              Library
            </Button>
          </div>
          {parsedPreview !== null && (
            <p className="px-1 text-[10px] text-low">
              {parsedPreview.provider.icon} {parsedPreview.provider.name} ·{' '}
              {parsedPreview.provider.note}
            </p>
          )}
        </div>
      )}
      {error !== null && <p className="px-3 pt-1 text-xs text-warn">{error}</p>}

      <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
        {items.length === 0 ? (
          <li className="py-10 text-center text-sm text-low">
            Queue is empty — add something to {room.kind === 'listen' ? 'hear' : 'watch'} together.
          </li>
        ) : (
          items.map((item, index) => (
            <QueueRow
              key={item.id}
              item={item}
              index={index}
              count={items.length}
              isCurrent={currentIndex === index}
              canQueue={canQueue}
              memberCount={memberCount}
              skipThreshold={room.policies.skipVoteThreshold}
            />
          ))
        )}
      </ul>

      <LibraryPicker open={libraryOpen} onOpenChange={setLibraryOpen} />
    </section>
  );
}
