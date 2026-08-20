'use client';

/**
 * The immersive stage — DESIGN.md §11 D1.1, unified 2026-08-20.
 *
 * Theater mode and fullscreen ARE THE SAME THING now, and the thing is LOCAL.
 * The old model was a server-backed room-wide flag (`room.theater`, PATCHed by
 * canManage members) that re-laid-out everyone's screen when one person
 * pressed a button, while the fullscreen control next to it changed only your
 * own. Two near-identical modes, one of them a lever over other people's
 * layout, and a plain member could use neither the flag nor understand why the
 * two looked different. Both entries now drive this one latch, it belongs to
 * the viewer alone, and the wire flag is read as a legacy hint at most (the
 * header keeps offering the control in rooms that stored it) and never written.
 *
 * The latch is a MODULE STORE, not component state, because it has three
 * owners in two subtrees that must not prop-drill through each other: the
 * room header's Theater button (room-shell), the stage's own F key, transport
 * button and share-stage button (StagePane), and the overlay's exit control
 * (here). Same pattern as ScreenShareStage's `useShareHost`. It starts false,
 * which is also what the SSR pass must render, and the shell resets it on the
 * way out of a room so the next room never inherits the layout.
 *
 * Browser fullscreen is the ENHANCEMENT, not the mode: StagePane asks for the
 * top layer when the latch flips on and the platform can give it one, and the
 * layout here works identically where it cannot (iOS Safari fullscreens only
 * <video>). Everything in this file therefore mounts INSIDE the stage
 * <section> — the fullscreen top layer paints over the whole document, so
 * chrome outside the section would simply not be on screen.
 *
 * Glass is sanctioned on every surface here: this is the one layout where the
 * chrome genuinely floats over moving video (§4, D1.1).
 */
import { useState } from 'react';
import { create } from 'zustand';
import type { RoomId } from '@gather/contracts';
import { CallPills, useCallSession } from '@/components/call/CallSurface';
import { ChatPane } from '@/components/chat/ChatPane';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ArrowLeftIcon, XIcon } from '@/components/ui/icons';
import { UnreadCount } from '@/components/ui/tabs';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { cn } from '@/lib/cn';

/* ── the one latch ───────────────────────────────────────────────────────── */

interface ImmersiveState {
  active: boolean;
}

/** Is this viewer in the immersive (theater/fullscreen) layout? Local, never
 *  on the wire — per-viewer chrome, exactly like mute or volume. */
export const useImmersive = create<ImmersiveState>()(() => ({ active: false }));

export function setImmersive(active: boolean): void {
  useImmersive.setState({ active });
}

export function toggleImmersive(): void {
  useImmersive.setState((s) => ({ active: !s.active }));
}

/** Room unmount: the next room must open windowed, whatever this one did. */
export function resetImmersive(): void {
  useImmersive.setState({ active: false });
}

/* ── per-viewer chrome preferences ───────────────────────────────────────── */

export type PillsEdge = 'left' | 'right';

/** localStorage, not room state: where YOUR tiles sit is nobody else's layout.
 *  Session storage would forget a preference the next visit has every reason
 *  to keep. */
const EDGE_KEY = 'gather.immersive.pills-edge';
const COLLAPSED_KEY = 'gather.immersive.pills-collapsed';

function readEdge(): PillsEdge {
  // D1.1: configurable left/right edge, default right.
  try {
    return window.localStorage.getItem(EDGE_KEY) === 'left' ? 'left' : 'right';
  } catch {
    return 'right';
  }
}

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function persist(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage blocked (private mode / embedded): the choice still holds for
    // this mount, it just will not survive it.
  }
}

/* ── the live path badge ─────────────────────────────────────────────────── */

/**
 * The stage's media-path badge — THE SAME TRUTH THE CALL RAIL RENDERS, from
 * the same source, in the same words ({@link useCallSession}'s `relayLabel`,
 * which is CALL_PATH_LABEL over the call's live links).
 *
 * It replaces a static "Private · device-to-device" read off `room.relayMode`,
 * which was an architectural claim, not an observation: the rail beside it
 * said "Private · direct" from live link stats, and the owner stood in front
 * of the pair asking "am I using TURN or P2P?". One vocabulary now.
 *
 * 'alone' means NO LINK EXISTS — nothing is flowing, so the stage claims
 * nothing rather than guessing (the same refusal the rail's 'unknown' makes
 * about an unclassifiable route). The rail still carries the label in that
 * state as an advertisement on the join button; the stage is not an advert.
 *
 * Injected into StagePane as a prop rather than imported by it, so a bare
 * StagePane stays mountable without a call session (every stage test does).
 */
export function StageLivePathBadge() {
  const call = useCallSession();
  if (call.mediaPath === 'alone') return null;
  return (
    <Badge variant="muted" className="pointer-events-auto">
      {call.relayLabel}
    </Badge>
  );
}

/* ── the immersive chrome ────────────────────────────────────────────────── */

/**
 * Everything the immersive layout floats over the picture: the exit control,
 * the call pills docked to a configurable edge, and the chat sidebar with its
 * 48px handle. Mounted by the shell INSIDE the stage section (see the header
 * comment), only while the mode is on.
 *
 * The ≤3-step budget (§12): entering the mode was 1 (Theater, F, or the
 * transport button), showing chat in here is 1 (the handle), leaving is 1
 * (Esc, F, or the exit control here).
 */
export function ImmersiveOverlay({
  roomId,
  unreadChat,
}: {
  roomId: RoomId;
  /** The shell's own unread projection — the same number the mobile control
   *  and the rail's Chat trigger render. Never recounted here: one signal. */
  unreadChat: number;
}) {
  const reduced = useReducedMotion();
  /** Chat starts as the handle: the mode exists to give the picture the whole
   *  screen, so nothing opens over it uninvited. */
  const [chatOpen, setChatOpen] = useState(false);
  const [edge, setEdge] = useState<PillsEdge>(() =>
    typeof window === 'undefined' ? 'right' : readEdge(),
  );
  const [pillsCollapsed, setPillsCollapsed] = useState<boolean>(() =>
    typeof window === 'undefined' ? false : readCollapsed(),
  );

  const flipEdge = (): void => {
    const next: PillsEdge = edge === 'right' ? 'left' : 'right';
    setEdge(next);
    persist(EDGE_KEY, next);
  };
  const toggleCollapsed = (): void => {
    const next = !pillsCollapsed;
    setPillsCollapsed(next);
    persist(COLLAPSED_KEY, next ? '1' : '0');
  };

  /**
   * The pills column. Its top offset clears the stage's own top-right chrome
   * (path badge, waiting badge, share entry — and during a share, the
   * fullscreen button at top-14), which owns the corner on both edges so the
   * two docks match. CallPills renders the people; this column owns only
   * WHERE they sit — the component contract.
   */
  const pills = (
    <div
      className={cn(
        'pointer-events-auto flex min-w-0 flex-col gap-2 pt-24',
        // Mutually exclusive on purpose: cn() is a plain joiner, and a column
        // carrying both alignments would let CSS source order pick the edge.
        edge === 'right' ? 'items-end pr-4' : 'items-start pl-4',
      )}
    >
      <CallPills edge={edge} collapsed={pillsCollapsed} onToggleCollapsed={toggleCollapsed} />
      <Button
        variant="ghost"
        size="icon"
        className="glass-panel"
        aria-label={
          edge === 'right' ? 'Move call tiles to the left edge' : 'Move call tiles to the right edge'
        }
        onClick={flipEdge}
      >
        {/* One glyph, flipped — the set has no ArrowRightIcon and two nearly
            identical arrows would drift apart. */}
        <ArrowLeftIcon size={16} className={edge === 'right' ? '' : 'rotate-180'} aria-hidden />
      </Button>
    </div>
  );

  return (
    <div className="pointer-events-none absolute inset-0 z-30 flex">
      {/* The way out, always visible and always in the same corner. Esc and F
          also leave (StagePane's map); this is the one a pointer can find. */}
      <div className="pointer-events-auto absolute left-4 top-4">
        <Button
          variant="ghost"
          size="icon"
          className="glass-panel"
          aria-label="Exit theater mode"
          onClick={() => setImmersive(false)}
        >
          <XIcon size={16} aria-hidden />
        </Button>
      </div>

      {edge === 'left' && pills}
      <div className="min-w-0 flex-1" />
      {edge === 'right' && pills}

      {/* Chat: a glass sidebar on the right edge, or its 48px handle. The
          sidebar mounts ChatPane only while open — ChatPane marks messages
          seen while mounted, and a hidden pane that kept reading would zero
          the very count the handle exists to show. */}
      {chatOpen ? (
        <aside
          aria-label="Chat"
          className={cn(
            'glass-panel pointer-events-auto my-4 mr-4 flex w-rail shrink-0 flex-col overflow-hidden rounded-panel shadow-e2',
            !reduced && 'animate-fade-in',
          )}
        >
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-hairline px-4 py-2">
            <span className="text-caption text-low">Chat</span>
            <button
              type="button"
              aria-label="Hide chat"
              onClick={() => setChatOpen(false)}
              className="rounded-ctl p-1 text-low transition-colors duration-150 hover:text-hi"
            >
              <XIcon size={14} aria-hidden />
            </button>
          </div>
          <div className="min-h-0 flex-1 px-3 pb-3 pt-4">
            <ChatPane roomId={roomId} />
          </div>
        </aside>
      ) : (
        <button
          type="button"
          // D1.1: the dismissed sidebar collapses to a 48px handle on the
          // edge (w-12), tall enough to be unmissable and to carry the count.
          className="glass-panel pointer-events-auto my-4 mr-4 flex w-12 shrink-0 flex-col items-center justify-center gap-3 rounded-panel px-2 py-4 text-mid transition-colors duration-150 hover:text-hi"
          aria-label={unreadChat > 0 ? `Show chat — ${unreadChat} unread` : 'Show chat'}
          onClick={() => setChatOpen(true)}
        >
          <span aria-hidden className="text-label [writing-mode:vertical-rl]">
            Chat
          </span>
          <UnreadCount count={unreadChat} />
        </button>
      )}
    </div>
  );
}
