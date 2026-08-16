/**
 * The line between the overlay and the page it was injected into.
 *
 * Owns: every listener the overlay puts on the page's window, the decision of
 * which events belong to us, and the delivery of those events to the overlay's
 * own controls.
 *
 * Deliberately NOT: any element, any styling, and any knowledge of what the
 * controls DO. It is handed nodes and handlers by mount.ts and knows only where
 * each event was aimed.
 *
 * ── Why this is not `stopPropagation()` on the host ───────────────────────
 * An event that starts inside the overlay travels down the PAGE first: window,
 * document, <html>, <body>, and only then our host and the shadow tree beneath
 * it. A player that wants to win registers on the document in the capture
 * phase, so it has already read the key — or the clipboard — long before the
 * host is reached. Stopping an event at the host stops the bubble half of the
 * journey and nothing else: a space bar typed into our chat box still paused
 * everyone's film.
 *
 * So the guard sits at the very top of that path instead, in the capture phase,
 * on the window. An event that started inside the overlay goes no further than
 * that: the page's document never hears it, in either phase.
 *
 * ── Why the overlay then has to be handed its own events ──────────────────
 * The shadow tree is below the guard too, so stopping an event there cuts the
 * overlay off from its own clicks and keys. The guard therefore works out which
 * of our controls the event was really for and runs the handlers registered for
 * it, walking up the shadow tree the way the event would have. Handlers are
 * given the ORIGINAL event, so `preventDefault()` still means what it says, and
 * the browser's own default actions — typing a character, moving focus,
 * scrolling the chat — are untouched, because none of them depend on
 * propagation.
 *
 * Which control an event was for cannot simply be read off the event: the root
 * is closed, so from outside it every one of our events claims to come from the
 * host, and `composedPath()` stops there. It is resolved instead the way the
 * browser resolved it — the focused element for anything the keyboard, an input
 * method or the clipboard produced, and the browser's own hit test for anything
 * a pointer produced.
 *
 * ── What this cannot promise ──────────────────────────────────────────────
 * Listeners on the same target in the same phase run in the order they were
 * registered, and the overlay is mounted when the tab joins a room — long after
 * the page's own scripts have had their turn. So a page listener that is on the
 * WINDOW and in the capture phase still runs before ours and still sees the
 * event. Everything below the window — the document included, which is where a
 * player's hotkeys actually live, and where the reproduced leak was — is beaten
 * whatever order it registered in, because the window comes first in the path
 * rather than first in a list.
 *
 * Closing that last sliver means not being in the page's event path at all,
 * which means a cross-origin frame, which cannot hold this UI
 * (docs/EXTENSION_FIRST.md, Part 2). It is named here rather than papered over.
 */

/** One of the overlay's own handlers. `target` is the control it was aimed at. */
export type OverlayHandler = (event: Event, target: Element) => void;

export interface BoundaryOptions {
  /** The page the overlay was injected into. */
  document: Document;
  /** The overlay's host element, and the only thing of ours the page can see. */
  host: Element;
  /** The closed root the overlay's controls live in. */
  root: ShadowRoot;
}

export interface OverlayBoundary {
  /** Register one of the overlay's handlers, in place of `addEventListener`. */
  on(node: Node, type: string, handler: OverlayHandler): void;
  /** Take every listener off the page. Idempotent. */
  destroy(): void;
}

/**
 * The events that must not escape.
 *
 * The keyboard and pointer families because a player acts on them, and would
 * act twice: Space pauses, arrows seek, a click on the picture toggles play.
 * The clipboard and editing families because they carry what the user wrote or
 * pasted, and one `document.addEventListener('paste', …)` on the page reads it
 * straight out of our chat box. Both the pointer and the mouse families are
 * listed because a page may listen for either, and `drop` and `dragstart`
 * because text dragged into or out of the composer is the clipboard by another
 * route.
 *
 * Touch is deliberately absent: this runs on desktop Chromium, where a finger
 * arrives as a pointer event as well.
 */
export const GUARDED_EVENTS: readonly string[] = [
  'keydown',
  'keyup',
  'keypress',
  'beforeinput',
  'input',
  'compositionstart',
  'compositionupdate',
  'compositionend',
  'paste',
  'copy',
  'cut',
  'pointerdown',
  'pointerup',
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'contextmenu',
  'wheel',
  'dragstart',
  'drop',
];

/** Guarded events that go to whatever has focus rather than to a place on screen. */
const FOCUS_EVENTS: ReadonlySet<string> = new Set([
  'keydown',
  'keyup',
  'keypress',
  'beforeinput',
  'input',
  'compositionstart',
  'compositionupdate',
  'compositionend',
  'paste',
  'copy',
  'cut',
]);

interface Route {
  node: Node;
  type: string;
  run: OverlayHandler;
}

/** Put the guard on the page. Registers listeners; creates and styles nothing. */
export function guardOverlayEvents(opts: BoundaryOptions): OverlayBoundary {
  const { document: doc, host, root } = opts;
  const routes: Route[] = [];
  const offs: Array<() => void> = [];

  /**
   * Which of our controls the event was really for.
   *
   * Null means "none of ours": nothing is run, and the event is still stopped,
   * because it started inside the overlay either way.
   */
  const aimedAt = (event: Event): Element | null => {
    if (FOCUS_EVENTS.has(event.type)) return root.activeElement;
    const spot = event as MouseEvent;
    if (typeof spot.clientX !== 'number' || typeof spot.clientY !== 'number') {
      return root.activeElement;
    }
    // A button worked from the keyboard fires a click with nothing behind it:
    // no detail, and the corner of the screen for coordinates. The panel is
    // never in that corner — it is held a margin clear of every edge — so this
    // asks focus rather than the screen.
    if (spot.detail === 0 && spot.clientX === 0 && spot.clientY === 0) return root.activeElement;
    return root.elementFromPoint(spot.clientX, spot.clientY);
  };

  /** Run the handlers for `target` and for everything it sits inside. */
  const deliver = (event: Event, target: Element | null): void => {
    if (target === null) return;
    let node: Node | null = target;
    while (node !== null) {
      for (const route of routes) {
        if (route.type === event.type && route.node === node) route.run(event, target);
      }
      if (node === root) return;
      node = node.parentNode;
    }
  };

  const guard = (event: Event): void => {
    // Retargeting hides our tree, so everything that starts inside the overlay
    // arrives here claiming the host. Anything else is the page's own event,
    // and not ours to read, delay or stop.
    if (event.target !== host) return;
    // Immediate, so that a page listener registered on the window after ours
    // does not get the event either.
    event.stopImmediatePropagation();
    deliver(event, aimedAt(event));
  };

  // The window is the first thing on an event's way down. A document with no
  // window cannot be seen by a page script either, so it is as high as we go.
  const top: EventTarget = doc.defaultView ?? doc;
  for (const type of GUARDED_EVENTS) {
    top.addEventListener(type, guard, true);
    offs.push(() => top.removeEventListener(type, guard, true));
  }

  return {
    on(node: Node, type: string, handler: OverlayHandler): void {
      routes.push({ node, type, run: handler });
    },
    destroy(): void {
      routes.splice(0);
      for (const off of offs.splice(0)) off();
    },
  };
}
