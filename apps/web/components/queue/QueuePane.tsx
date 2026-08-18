'use client';

/**
 * QueuePane — the collaborative queue: add by URL (YouTube/SoundCloud/Vimeo/
 * embeds/direct/HLS, or ANY other https page — providers.ts has no gate left,
 * only better paths for the sites it knows), reorder by dragging the
 * grabber (native HTML5 drag-and-drop, arrow keys as the keyboard path, a
 * pointer-drag fallback for touch), delete on hover, vote-to-skip with the
 * room's configured threshold, and click a row to play it via sync.setTrack.
 * Server-authoritative queue.state drives everything — sends are
 * fire-and-forget and the UI only moves when the snapshot comes back.
 *
 * The second button used to be "Library" — your uploads, from services/media.
 * That service was deleted, so the dialog fetched a 404 and showed an empty
 * box to everyone, forever. In its place: what this room has actually played,
 * with one click to queue it again (components/queue/HistoryDialog.tsx).
 */
import { useCallback, useMemo, useState } from 'react';
import type { DragEvent, KeyboardEvent, PointerEvent } from 'react';
import type { MediaRef, QueueItem, QueueItemId, RoomId } from '@gather/contracts';
import { canAct, formatMs } from '@/lib/permissions';
import { mediaKindFor } from '@/lib/media-kind';
import { parseProviderUrl } from '@/lib/providers';
import { providerLabel } from '@/lib/labels';
import { useRoom, useRoomConnection } from '@/lib/room-context';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RecentlyPlayed } from '@/components/queue/HistoryDialog';
import {
  FilmIcon,
  GripVerticalIcon,
  MusicIcon,
  PlayIcon,
  SkipForwardIcon,
  TrashIcon,
} from '@/components/ui/icons';
import { cn } from '@/lib/cn';

/**
 * Row affordances are revealed on hover, but hover does not exist on touch —
 * so they stay visible by default and only hide behind hover on pointers that
 * actually have it. Focus (keyboard) reveals them in both worlds.
 */
const HOVER_REVEAL =
  'opacity-100 transition-opacity duration-150 group-focus-within:opacity-100 ' +
  '[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 ' +
  '[@media(hover:hover)]:group-focus-within:opacity-100';

/** Placeholder glyph when an item has no artwork: music sources get a note. */
function ProviderIcon({ mediaRef, className }: { mediaRef: MediaRef; className: string }) {
  return mediaKindFor(mediaRef) === 'music' ? (
    <MusicIcon size={20} className={className} />
  ) : (
    <FilmIcon size={20} className={className} />
  );
}

/** Which half of a row the cursor sits in — the insertion point. */
type DropEdge = 'above' | 'below';

interface DragState {
  /** The item being dragged. */
  id: QueueItemId;
  /** The row currently under the cursor (null before the first dragover). */
  overId: QueueItemId | null;
  edge: DropEdge;
}

function edgeAt(element: Element, clientY: number): DropEdge {
  const rect = element.getBoundingClientRect();
  return clientY - rect.top < rect.height / 2 ? 'above' : 'below';
}

function QueueRow({
  item,
  index,
  count,
  isCurrent,
  canQueue,
  memberCount,
  skipThreshold,
  reducedMotion,
  drag,
  onDragChange,
  onDropReorder,
  onMove,
}: {
  item: QueueItem;
  index: number;
  count: number;
  isCurrent: boolean;
  canQueue: boolean;
  memberCount: number;
  skipThreshold: number;
  reducedMotion: boolean;
  drag: DragState | null;
  onDragChange(next: DragState | null): void;
  onDropReorder(sourceId: QueueItemId, targetId: QueueItemId, edge: DropEdge): void;
  onMove(index: number, dir: -1 | 1): void;
}) {
  const connection = useRoomConnection();
  const { member } = useRoom();
  const me = member.userId;
  const voted = item.votesToSkip.includes(me);
  const votes = item.votesToSkip.length;
  const needed = Math.max(1, Math.ceil(memberCount * skipThreshold));
  // The server lets anyone retract their OWN item, policy or not.
  const canDelete = canQueue || item.addedBy === me;
  const isDragging = drag?.id === item.id;
  const indicator = drag !== null && drag.overId === item.id && !isDragging ? drag.edge : null;

  const meta = [
    providerLabel(item.mediaRef),
    item.durationMs !== null ? formatMs(item.durationMs) : null,
    item.addedBy === me ? 'added by you' : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');

  const handleDragStart = (e: DragEvent<HTMLLIElement>): void => {
    if (!canQueue) return;
    e.dataTransfer.effectAllowed = 'move';
    // Firefox refuses to start a drag without payload.
    e.dataTransfer.setData('text/plain', item.id);
    onDragChange({ id: item.id, overId: null, edge: 'above' });
  };

  const handleDragOver = (e: DragEvent<HTMLLIElement>): void => {
    if (drag === null) return; // not our drag (a file, a link) — don't accept it.
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const edge = edgeAt(e.currentTarget, e.clientY);
    if (drag.overId !== item.id || drag.edge !== edge) {
      onDragChange({ ...drag, overId: item.id, edge });
    }
  };

  const handleDrop = (e: DragEvent<HTMLLIElement>): void => {
    if (drag === null) return;
    e.preventDefault();
    const raw = e.dataTransfer.getData('text/plain');
    const sourceId = raw !== '' ? (raw as QueueItemId) : drag.id;
    onDropReorder(sourceId, item.id, edgeAt(e.currentTarget, e.clientY));
    onDragChange(null);
  };

  const handleGrabKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    onMove(index, e.key === 'ArrowUp' ? -1 : 1);
  };

  // Touch has no HTML5 drag-and-drop: drive the same drop model from pointer
  // events instead (mouse keeps the native path, which gives a real drag image).
  const handleGrabPointerDown = (e: PointerEvent<HTMLButtonElement>): void => {
    if (!canQueue || e.pointerType === 'mouse') return;
    e.currentTarget.setPointerCapture(e.pointerId);
    onDragChange({ id: item.id, overId: null, edge: 'above' });
  };

  const handleGrabPointerMove = (e: PointerEvent<HTMLButtonElement>): void => {
    if (e.pointerType === 'mouse' || drag === null || drag.id !== item.id) return;
    const row = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-queue-item]') ?? null;
    if (row === null) return;
    const overId = row.getAttribute('data-queue-item');
    if (overId === null) return;
    const edge = edgeAt(row, e.clientY);
    if (drag.overId !== overId || drag.edge !== edge) {
      onDragChange({ ...drag, overId: overId as QueueItemId, edge });
    }
  };

  const handleGrabPointerUp = (e: PointerEvent<HTMLButtonElement>): void => {
    if (e.pointerType === 'mouse' || drag === null || drag.id !== item.id) return;
    if (drag.overId !== null) onDropReorder(drag.id, drag.overId, drag.edge);
    onDragChange(null);
  };

  const body = (
    <>
      <span className="group/thumb relative h-12 w-12 shrink-0 overflow-hidden rounded-ctl bg-raised">
        {item.artworkUrl !== null ? (
          <img src={item.artworkUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <span className="flex h-full w-full items-center justify-center">
            <ProviderIcon mediaRef={item.mediaRef} className="text-low" />
          </span>
        )}
        {canQueue && (
          <span
            aria-hidden
            className={cn(
              'absolute inset-0 flex items-center justify-center rounded-ctl',
              'bg-[color-mix(in_oklch,var(--bg-void)_62%,transparent)] text-hi',
              'opacity-0 transition-opacity duration-150',
              'group-hover/thumb:opacity-100 group-focus-within:opacity-100',
            )}
          >
            <PlayIcon size={16} />
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-sm font-medium text-hi">{item.title}</span>
        <span className="mt-0.5 flex items-center gap-1.5 text-xs text-low">
          {isCurrent && (
            <span className="inline-flex shrink-0 items-center gap-1 font-medium text-aurora-1">
              <PlayIcon size={9} />
              Playing
            </span>
          )}
          <span className="truncate">{meta}</span>
        </span>
      </span>
    </>
  );

  const bodyClass = 'flex min-w-0 flex-1 items-center gap-3 rounded-ctl text-left';

  return (
    <li
      data-queue-item={item.id}
      aria-posinset={index + 1}
      aria-setsize={count}
      draggable={canQueue}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onDragEnd={() => onDragChange(null)}
      className={cn(
        'group relative flex items-center gap-2 rounded-card border p-2',
        'transition-[background-color,border-color,opacity,transform] duration-150',
        isCurrent
          ? 'glass-raised border-[color-mix(in_oklch,var(--aurora-1)_45%,transparent)] pl-3'
          : 'border-border-glass bg-glass hover:border-[color-mix(in_oklch,white_16%,transparent)]',
        isDragging && 'opacity-40',
        isDragging && !reducedMotion && 'scale-[0.99]',
      )}
    >
      {isCurrent && (
        <span
          aria-hidden
          className="aurora-gradient pointer-events-none absolute inset-y-1.5 left-0 w-[3px] rounded-r-full"
        />
      )}
      {indicator !== null && (
        <span
          aria-hidden
          className={cn(
            'aurora-gradient pointer-events-none absolute left-1 right-1 h-0.5 rounded-full',
            indicator === 'above' ? '-top-1' : '-bottom-1',
          )}
        />
      )}

      {canQueue && (
        <button
          type="button"
          aria-label="Reorder — use arrow keys"
          title="Drag to reorder"
          onKeyDown={handleGrabKeyDown}
          onPointerDown={handleGrabPointerDown}
          onPointerMove={handleGrabPointerMove}
          onPointerUp={handleGrabPointerUp}
          onPointerCancel={() => onDragChange(null)}
          className={cn(
            'flex h-10 w-5 shrink-0 cursor-grab select-none touch-none items-center justify-center',
            'rounded-ctl text-low hover:text-hi active:cursor-grabbing',
            HOVER_REVEAL,
          )}
        >
          <GripVerticalIcon size={16} />
        </button>
      )}

      {canQueue ? (
        <button
          type="button"
          aria-label={`Play ${item.title}`}
          onClick={() => connection.syncSetTrackByQueue(index)}
          className={bodyClass}
        >
          {body}
        </button>
      ) : (
        <div className={bodyClass}>{body}</div>
      )}

      <span className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          aria-label={
            voted
              ? `Withdraw skip vote — ${votes} of ${needed}`
              : `Vote to skip — ${votes} of ${needed}`
          }
          aria-pressed={voted}
          onClick={() => connection.queueVoteSkip(item.id)}
          className={cn(
            'inline-flex h-10 items-center gap-1 rounded-ctl px-2 text-xs',
            voted ? 'text-aurora-1' : 'text-low hover:text-hi',
            // A live vote tally is information, not an affordance: never hide it.
            votes > 0 ? 'opacity-100 transition-opacity duration-150' : HOVER_REVEAL,
          )}
        >
          <SkipForwardIcon size={14} />
          {votes > 0 && (
            <span className="tabular-nums">
              {votes}/{needed}
            </span>
          )}
        </button>
        {canDelete && (
          <button
            type="button"
            aria-label={`Remove ${item.title} from queue`}
            onClick={() => connection.queueRemove(item.id)}
            className={cn(
              'inline-flex h-10 w-10 items-center justify-center rounded-ctl',
              'text-low hover:text-danger',
              HOVER_REVEAL,
            )}
          >
            <TrashIcon size={16} />
          </button>
        )}
      </span>
    </li>
  );
}

export function QueuePane({ roomId }: { roomId: RoomId }) {
  const connection = useRoomConnection();
  const { room, member } = useRoom();
  const items = connection.useRoomState((s) => s.queue.items);
  const playback = connection.useRoomState((s) => s.playback);
  const presence = connection.useRoomState((s) => s.presence);
  const reducedMotion = useReducedMotion();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const canQueue = canAct(room.policies.queueControl, member.role);
  const memberCount = Math.max(1, Object.keys(presence).length);
  const currentIndex = playback?.queueIndex ?? null;

  const add = (): void => {
    const parsed = parseProviderUrl(draft);
    if (parsed === null) {
      // The registry is no longer a gate, so the only thing left to refuse is
      // something that is not an https web address at all. Say that, and stop
      // implying there is a list the link failed to be on.
      setError('Paste a web address — it has to start with https://');
      return;
    }
    if (parsed.ref === null) {
      // Protected tier: recognized, but there is nothing to embed — honest stop.
      setError(
        `${parsed.provider.name} protects its video, so it can’t play inside Gather. Watch it together with the Gather browser extension — everyone signs in with their own account.`,
      );
      return;
    }
    const title =
      parsed.titleHint ?? (parsed.ref.kind === 'youtube' ? 'YouTube video' : 'Shared media');
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

  /** Adjacent swap (keyboard path) — reads the live snapshot, like the drop does. */
  const move = useCallback(
    (index: number, dir: -1 | 1): void => {
      const snapshot = connection.useRoomState.getState().queue.items;
      const ids = snapshot.map((it) => it.id);
      const j = index + dir;
      const a = ids[index];
      const b = ids[j];
      if (a === undefined || b === undefined) return;
      ids[index] = b;
      ids[j] = a;
      connection.queueReorder(ids);
      setAnnouncement(
        `${snapshot[index]?.title ?? 'Item'} moved to position ${j + 1} of ${ids.length}`,
      );
    },
    [connection],
  );

  /** Drop commit: rebuild the full order from the CURRENT store snapshot. */
  const dropReorder = useCallback(
    (sourceId: QueueItemId, targetId: QueueItemId, edge: DropEdge): void => {
      if (sourceId === targetId) return;
      const snapshot = connection.useRoomState.getState().queue.items;
      const ids = snapshot.map((it) => it.id);
      if (!ids.includes(sourceId) || !ids.includes(targetId)) return; // stale drag
      const rest = ids.filter((id) => id !== sourceId);
      const at = rest.indexOf(targetId) + (edge === 'below' ? 1 : 0);
      rest.splice(at, 0, sourceId);
      if (rest.every((id, i) => ids[i] === id)) return; // no-op drop
      connection.queueReorder(rest);
      const title = snapshot.find((it) => it.id === sourceId)?.title ?? 'Item';
      setAnnouncement(
        `${title} moved to position ${rest.indexOf(sourceId) + 1} of ${rest.length}`,
      );
    },
    [connection],
  );

  return (
    <section aria-label="Queue" data-room={roomId} className="flex h-full min-h-0 flex-col">
      {/* The header always renders: what the room has played is readable by
          everyone in it, whether or not the room's policy lets them queue. */}
      <div className="flex flex-col gap-1 border-b border-border-glass p-2">
        <div className="flex gap-2">
          {canQueue && (
            <>
              <Input
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') add();
                }}
                placeholder="Paste any link — YouTube, Spotify, or any page"
                aria-label="Add to queue"
              />
              <Button size="sm" onClick={add}>Add</Button>
            </>
          )}
          <Button size="sm" variant="secondary" onClick={() => setHistoryOpen(true)}>
            History
          </Button>
        </div>
        {canQueue && parsedPreview !== null && (
          <p className="px-1 text-[10px] text-low">
            {parsedPreview.provider.icon} {parsedPreview.provider.name} ·{' '}
            {parsedPreview.provider.note}
          </p>
        )}
      </div>
      {error !== null && <p className="px-3 pt-1 text-xs text-warn">{error}</p>}

      <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
        {items.length === 0 ? (
          <li className="py-10 text-center text-sm text-low">
            Queue is empty — add something to play together.
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
              reducedMotion={reducedMotion}
              drag={drag}
              onDragChange={setDrag}
              onDropReorder={dropReorder}
              onMove={move}
            />
          ))
        )}
      </ul>

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      <RecentlyPlayed roomId={roomId} open={historyOpen} onOpenChange={setHistoryOpen} />
    </section>
  );
}
