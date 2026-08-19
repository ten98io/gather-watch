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
 *
 * ── The composition (2026-08-19) ──────────────────────────────────────────
 * This pane read as a FORM — a field, two buttons of equal weight, then rows
 * that were bordered glass cards in a system where glass is reserved for
 * surfaces over moving video (DESIGN.md §4). It is three blocks now, and the
 * whitespace between them is UNEVEN on purpose (§10): a header that says what
 * this pane holds and demotes History to a ghost, then the composer at 16,
 * then the list at 24 with 4 between its rows. Even gaps would say the three
 * blocks rank the same. Rows are <MediaRow>, like every other list of media in
 * the product — artwork, title, who added it, how long it runs, and the
 * Extension chip when it needs one to play at all.
 *
 * THE RAIL'S GRADIENT BUDGET. §2 allows the aurora on the primary action, the
 * brand mark and the live indicator, at most one per screen region. In this
 * pane it is spent on the PLAYING chip — at most one row can wear it, and it
 * is the one thing here that is genuinely singular. "Add" is therefore
 * `secondary`: it is the obvious action of a field you have just typed into
 * and does not need an identity to be found, whereas nothing else in the rail
 * points at what is playing.
 */
import { useCallback, useMemo, useState } from 'react';
import type { DragEvent, KeyboardEvent, PointerEvent } from 'react';
import type { QueueItem, QueueItemId, RoomId } from '@gather/contracts';
import { canAct } from '@/lib/permissions';
import { formatDurationMs } from '@/lib/format';
import { mediaKindFor } from '@/lib/media-kind';
import { parseProviderUrl } from '@/lib/providers';
import { providerLabel } from '@/lib/labels';
import { useRoom, useRoomConnection } from '@/lib/room-context';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { HOVER_REVEAL, MediaRow } from '@/components/ui/media-row';
import { RecentlyPlayed } from '@/components/queue/HistoryDialog';
import {
  GripVerticalIcon,
  HistoryIcon,
  PlusIcon,
  SkipForwardIcon,
  TrashIcon,
} from '@/components/ui/icons';
import { cn } from '@/lib/cn';

/**
 * Meta-line source words for a `page` row, in place of labels.ts's tier word
 * ("Web page"). A page row is the one kind that plays somewhere other than
 * this tab, and the composer note saying so is gone the second the item is
 * added — so the row has to carry it, for the person who queued a Netflix link
 * and for everyone who sees it afterwards. The row TITLE already names the
 * site (parseProviderUrl's titleHint), so this names the mechanism instead.
 *
 * Two forms, because they answer to different readers. A chip is what a
 * property of an item looks like and it costs the meta line ~60px; but
 * "Extension" on its own is not a sentence, so the sentence is what assistive
 * technology reads out. Neither is decoration: without the extension installed
 * this row does not play, and that is the single most useful thing the row
 * knows about itself.
 */
const PAGE_SOURCE_CHIP = 'Extension';
const PAGE_SOURCE = 'Plays in the Gather extension';

/**
 * The queue's total runtime in words — "1 hr 12 min", "48 min".
 *
 * Null when ANY item's length is still unknown, and that is the whole design
 * of it. Durations arrive when an item is played (the room reports them), so a
 * freshly pasted queue legitimately has none; a total that quietly leaves
 * three items out is a WRONG number in the one place a reader would trust one,
 * and no number is the honest state. Exported for the guard in
 * test/queue-composition.test.tsx.
 */
export function totalRuntime(items: readonly QueueItem[]): string | null {
  if (items.length === 0) return null;
  let ms = 0;
  for (const item of items) {
    if (item.durationMs === null) return null;
    ms += item.durationMs;
  }
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
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
  const isPage = item.mediaRef.kind === 'page';

  /** Words after the chip. A live skip tally is INFORMATION, so it belongs on
   *  the always-visible meta line and never inside the hover-revealed
   *  `actions` slot, where it would disappear the moment the cursor left. */
  const words = [
    isPage ? null : providerLabel(item.mediaRef),
    item.addedBy === me ? 'added by you' : null,
    votes > 0 ? `${votes} of ${needed} voting to skip` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');

  const handleDragStart = (e: DragEvent<HTMLElement>): void => {
    if (!canQueue) return;
    e.dataTransfer.effectAllowed = 'move';
    // Firefox refuses to start a drag without payload.
    e.dataTransfer.setData('text/plain', item.id);
    onDragChange({ id: item.id, overId: null, edge: 'above' });
  };

  const handleDragOver = (e: DragEvent<HTMLElement>): void => {
    if (drag === null) return; // not our drag (a file, a link) — don't accept it.
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const edge = edgeAt(e.currentTarget, e.clientY);
    if (drag.overId !== item.id || drag.edge !== edge) {
      onDragChange({ ...drag, overId: item.id, edge });
    }
  };

  const handleDrop = (e: DragEvent<HTMLElement>): void => {
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

  const meta = (
    <>
      {isCurrent && (
        // The rail's one sanctioned gradient (§2): the live/playing indicator.
        // At most one row is playing, so at most one of these exists.
        <Badge variant="aurora" className="mr-1.5 align-middle">
          Playing
        </Badge>
      )}
      {isPage && (
        <>
          <Badge variant="outline" className="mr-1.5 align-middle">
            {PAGE_SOURCE_CHIP}
          </Badge>
          <span className="sr-only">{PAGE_SOURCE} · </span>
        </>
      )}
      {words}
    </>
  );

  // Undefined rather than an empty fragment when the room's policy says this
  // person may not reorder: MediaRow lays `leading` out as a flex child, so an
  // empty one is 12px of gutter on every row for no reason.
  const leading = !canQueue ? undefined : (
    <>
      {indicator !== null && (
        // Flat `--accent`, not the gradient: an insertion line wants to be
        // VISIBLE (the 3:1 non-text bar), not to be the room's identity. It
        // rides `leading` rather than `actions` because `actions` hides behind
        // hover, and a drop target you cannot see during a drag is not one.
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute left-1 right-1 h-0.5 rounded-full bg-accent',
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
            'flex h-ctl-md w-4 cursor-grab select-none touch-none items-center justify-center',
            'rounded-ctl text-low hover:text-hi active:cursor-grabbing',
            HOVER_REVEAL,
          )}
        >
          <GripVerticalIcon size={16} />
        </button>
      )}
    </>
  );

  return (
    <MediaRow
      as="li"
      data-queue-item={item.id}
      aria-posinset={index + 1}
      aria-setsize={count}
      draggable={canQueue}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onDragEnd={() => onDragChange(null)}
      artwork={{
        src: item.artworkUrl,
        alt: item.title,
        // `mediaKindFor` is null only for a null ref, which a queued item
        // cannot have; the fallback is the same one the classifier gives a page.
        kind: mediaKindFor(item.mediaRef) ?? 'video',
        // Square in the rail whatever the medium: see MediaRowArtwork.shape.
        shape: 'square',
      }}
      title={item.title}
      meta={meta}
      // `formatDurationMs`, not permissions.formatMs: the latter has no hours
      // field, so a 97-minute film read "97:12" in the queue and "1:37:12" in
      // the history dialog — two spellings of one length, in two lists of the
      // same media, three centimetres apart.
      trailing={item.durationMs !== null ? formatDurationMs(item.durationMs) : null}
      leading={leading}
      active={isCurrent}
      {...(canQueue ? { onActivate: () => connection.syncSetTrackByQueue(index) } : {})}
      activateLabel={`Play ${item.title}`}
      className={cn(
        isDragging && 'opacity-40',
        isDragging && !reducedMotion && 'scale-[0.99]',
      )}
      actions={
        <>
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
              'inline-flex h-ctl-md w-ctl-md items-center justify-center rounded-ctl',
              // cn() is a plain joiner: the on/off colours are one ternary,
              // never two stacked text-* utilities.
              voted ? 'text-hi' : 'text-low hover:text-hi',
            )}
          >
            <SkipForwardIcon size={16} />
          </button>
          {canDelete && (
            <button
              type="button"
              aria-label={`Remove ${item.title} from queue`}
              onClick={() => connection.queueRemove(item.id)}
              className={cn(
                'inline-flex h-ctl-md w-ctl-md items-center justify-center rounded-ctl',
                'text-low hover:text-danger',
              )}
            >
              <TrashIcon size={16} />
            </button>
          )}
        </>
      }
    />
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
    // No second refusal here. The DRM tier used to stop at this line with
    // "X protects its video, so it can't play inside Gather" — i.e. Gather
    // recommended the extension and then declined the eight services the
    // extension exists for. They queue as page refs now; what needs saying
    // about them is a note (the composer preview, and the Extension chip on
    // the row), and a note costs no step.
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

  const runtime = totalRuntime(items);

  return (
    <section aria-label="Queue" data-room={roomId} className="flex h-full min-h-0 flex-col">
      {/* Block one: the header, and the same shape People wears — overline,
          one line at `title`, one ghost action. Two panes of one rail that
          each invented their own header is how a rail stops reading as one
          object. The count and the runtime ARE the pane's subject, so they get
          the type; "Up next" is the dateline over them. */}
      <header className="flex items-end justify-between gap-3 px-1">
        <h3 className="min-w-0">
          <span className="block text-caption text-low">Up next</span>
          <span className="block truncate font-display text-title text-hi">
            {items.length === 0 ? (
              'Nothing queued'
            ) : (
              <>
                <span className="tabular-nums">{items.length}</span>
                {items.length === 1 ? ' item' : ' items'}
                {/* Metadata inside a title stays `text-low` (§3): the count is
                    what the line is about, the runtime is a detail of it. */}
                {runtime !== null && <span className="text-low"> · {runtime}</span>}
              </>
            )}
          </span>
        </h3>
        <Button
          variant="ghost"
          size="sm"
          className="-mr-2 shrink-0"
          onClick={() => setHistoryOpen(true)}
        >
          <HistoryIcon size={16} aria-hidden />
          History
        </Button>
      </header>

      {/* Block two: the composer. Absent entirely when the room's policy says
          this person may not queue — an inert field is worse than no field. */}
      {canQueue && (
        <div className="mt-4 flex flex-col gap-2">
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
              placeholder="Paste any link — YouTube, Spotify, or any page"
              aria-label="Add to queue"
            />
            <Button variant="secondary" onClick={add} className="shrink-0">
              <PlusIcon size={16} aria-hidden />
              Add
            </Button>
          </div>
          {error !== null && <p className="px-1 text-label text-warn">{error}</p>}
          {parsedPreview !== null && (
            <p className="flex items-center gap-1.5 px-1 text-label text-low">
              <span aria-hidden>{parsedPreview.provider.icon}</span>
              <span className="shrink-0 text-hi">{parsedPreview.provider.name}</span>
              <span className="truncate">{parsedPreview.provider.note}</span>
            </p>
          )}
        </div>
      )}

      {/* Block three: the list. The gap above it is wider than the one inside
          the composer and wider than the one between rows — that ladder is
          what says composer, then list, rather than "five things in a rail". */}
      {items.length === 0 ? (
        <div className="mt-6 min-h-0 flex-1 overflow-y-auto">
          <EmptyState
            variant="signature"
            icon={<PlusIcon size={24} />}
            // An invitation, not an apology. This is the first thing anyone
            // sees of a new room's queue, and "Nothing queued yet" tells them
            // only that the product is empty — which they can see.
            title={canQueue ? 'Queue the first thing' : 'Nothing queued yet'}
            description={
              canQueue
                ? 'Paste any link above — a video, a track, or a page. Everyone lands on the same second of it.'
                : 'Whoever is running the room can add something for everyone to watch together.'
            }
          />
        </div>
      ) : (
        <ul className="mt-6 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pb-2">
          {items.map((item, index) => (
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
          ))}
        </ul>
      )}

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      <RecentlyPlayed roomId={roomId} open={historyOpen} onOpenChange={setHistoryOpen} />
    </section>
  );
}
