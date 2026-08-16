/**
 * The overlay's looks: one stylesheet that only ever exists inside the closed
 * shadow root, plus the handful of properties that are locked onto the host
 * element itself.
 *
 * Owns: every rule the panel is drawn with, the light/dark palette, and the
 * host-level layout guarantees.
 *
 * Deliberately NOT: anything that touches the page. No rule here can match a
 * page element (a shadow tree's styles do not escape it), nothing is added to
 * `document`, no font is fetched, and no page CSS variable is read — the panel
 * has to look the same on a site whose stylesheet is actively hostile.
 *
 * ── Why the host is locked with inline `!important` ────────────────────────
 * `:host` rules lose to the *page's* rules that match the host element: that
 * ordering is in the spec, so a page's `div { display: none }` would simply
 * switch us off. Inline styles with `!important` are the only declarations a
 * page author cannot outrank, so the few properties that decide "is this thing
 * visible, where, and does it steal clicks" are set that way, on our own
 * element, and nowhere else. Everything else lives in the stylesheet below.
 */

/** Just under the 32-bit ceiling: leave room for a site that stacks above us. */
const Z_INDEX = '2147483000';

/**
 * The host is a fixed-position box that is EXACTLY the panel: it takes no part
 * in the page's layout and, being `pointer-events: none`, cannot make any part
 * of the page unclickable. Only the panel and the handle take clicks back.
 */
export const HOST_LOCKS: ReadonlyArray<readonly [string, string]> = [
  ['position', 'fixed'],
  ['display', 'block'],
  // `left` and `top` are the position; the other two edges must stay unset or
  // the box is stretched between them. The page can set them, and so does the
  // browser's own `[popover] { inset: 0 }` when the overlay joins the top layer
  // to sit above a fullscreen film.
  ['right', 'auto'],
  ['bottom', 'auto'],
  ['width', 'auto'],
  ['height', 'auto'],
  ['margin', '0'],
  ['padding', '0'],
  ['border', '0'],
  // The panel draws its own background and its own rounded corners. Anything
  // painted on the host itself shows up as a square behind them — which is what
  // both a page rule and the browser's `[popover] { background-color: Canvas }`
  // would do.
  ['background', 'transparent'],
  ['overflow', 'visible'],
  ['max-width', 'none'],
  ['max-height', 'none'],
  ['min-width', '0'],
  ['min-height', '0'],
  ['transform', 'none'],
  ['float', 'none'],
  ['clip-path', 'none'],
  ['filter', 'none'],
  ['opacity', '1'],
  ['visibility', 'visible'],
  ['pointer-events', 'none'],
  ['z-index', Z_INDEX],
];

/**
 * The stylesheet. Colours follow the reader's system setting; motion is only
 * added when the reader has not asked for less of it. Both are media queries
 * rather than JavaScript, so a change of setting is picked up with no listener
 * to leak and nothing to re-render.
 */
export const OVERLAY_CSS = `
:host {
  all: initial;
  position: fixed;
  z-index: ${Z_INDEX};
  pointer-events: none;
  color-scheme: light dark;

  --playin-bg: #ffffff;
  --playin-bg-soft: #f3f4f6;
  --playin-line: rgba(0, 0, 0, 0.12);
  --playin-ink: #14161a;
  --playin-ink-soft: #5b6270;
  --playin-accent: #3b5bdb;
  --playin-accent-ink: #ffffff;
  --playin-focus: #1c7ed6;
  --playin-shadow: 0 8px 28px rgba(0, 0, 0, 0.22);
  --playin-font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue',
    Arial, sans-serif;
}

@media (prefers-color-scheme: dark) {
  :host {
    --playin-bg: #16181d;
    --playin-bg-soft: #202329;
    --playin-line: rgba(255, 255, 255, 0.14);
    --playin-ink: #f2f4f8;
    --playin-ink-soft: #a9b0be;
    --playin-accent: #5c7cfa;
    --playin-accent-ink: #0b0d12;
    --playin-focus: #74c0fc;
    --playin-shadow: 0 8px 28px rgba(0, 0, 0, 0.55);
  }
}

*,
*::before,
*::after {
  box-sizing: border-box;
}

button {
  font: inherit;
  color: inherit;
  background: none;
  border: 0;
  margin: 0;
  padding: 0;
  cursor: pointer;
  text-align: left;
}

/* A focus ring that stays visible on any backdrop, including a black player. */
button:focus-visible,
input:focus-visible {
  outline: 2px solid var(--playin-focus);
  outline-offset: 2px;
}

.handle {
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 13px;
  border-radius: 999px;
  background: var(--playin-accent);
  color: var(--playin-accent-ink);
  font: 600 12px/1.2 var(--playin-font);
  box-shadow: var(--playin-shadow);
  white-space: nowrap;
}
.handle[hidden] {
  display: none;
}

.panel {
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  width: 320px;
  max-width: calc(100vw - 32px);
  max-height: 70vh;
  background: var(--playin-bg);
  color: var(--playin-ink);
  font: 400 13px/1.45 var(--playin-font);
  border: 1px solid var(--playin-line);
  border-radius: 12px;
  box-shadow: var(--playin-shadow);
  overflow: hidden;
}
.panel[hidden] {
  display: none;
}

.head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  background: var(--playin-bg-soft);
  border-bottom: 1px solid var(--playin-line);
  cursor: grab;
  user-select: none;
  touch-action: none;
}
.head[data-dragging='true'] {
  cursor: grabbing;
}
.head-text {
  flex: 1 1 auto;
  min-width: 0;
}

.room {
  margin: 0;
  font-weight: 600;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.status {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--playin-ink-soft);
  overflow-wrap: anywhere;
}

.hide {
  flex: 0 0 auto;
  padding: 3px 9px;
  border: 1px solid var(--playin-line);
  border-radius: 8px;
  background: var(--playin-bg);
  color: var(--playin-ink-soft);
  font-size: 12px;
}
.hide:hover {
  color: var(--playin-ink);
}

.people {
  padding: 10px 12px;
  border-bottom: 1px solid var(--playin-line);
}
.section-title {
  margin: 0 0 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--playin-ink-soft);
}
.people-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 78px;
  overflow-y: auto;
}
.person {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  max-width: 100%;
  padding: 3px 9px;
  border: 1px solid var(--playin-line);
  border-radius: 999px;
  background: var(--playin-bg-soft);
}
.person-name {
  font-weight: 600;
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.person-note {
  font-size: 11px;
  color: var(--playin-ink-soft);
}
.person-empty {
  color: var(--playin-ink-soft);
}

.messages {
  list-style: none;
  margin: 0;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 7px;
  flex: 1 1 auto;
  min-height: 90px;
  max-height: 34vh;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.msg {
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.msg-author {
  font-weight: 600;
  margin-right: 6px;
}
.msg[data-mine='true'] .msg-author {
  color: var(--playin-accent);
}

.ahead,
.notice {
  margin: 0;
  padding: 0 12px 8px;
  font-size: 12px;
  color: var(--playin-ink-soft);
}
.ahead[hidden],
.notice[hidden] {
  display: none;
}

.composer {
  display: flex;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid var(--playin-line);
  background: var(--playin-bg-soft);
}
.input {
  flex: 1 1 auto;
  min-width: 0;
  font: inherit;
  color: var(--playin-ink);
  background: var(--playin-bg);
  border: 1px solid var(--playin-line);
  border-radius: 8px;
  padding: 7px 9px;
}
.send {
  flex: 0 0 auto;
  padding: 7px 13px;
  border-radius: 8px;
  background: var(--playin-accent);
  color: var(--playin-accent-ink);
  font-weight: 600;
}
.input[disabled],
.send[disabled] {
  opacity: 0.55;
  cursor: not-allowed;
}

.foot {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  border-top: 1px solid var(--playin-line);
}
.link {
  color: var(--playin-ink-soft);
  font-size: 12px;
  text-decoration: underline;
}
.link:hover {
  color: var(--playin-ink);
}

@media (prefers-reduced-motion: no-preference) {
  .handle,
  .hide,
  .link,
  .send {
    transition: background-color 120ms ease, color 120ms ease, opacity 120ms ease;
  }
}
`;
