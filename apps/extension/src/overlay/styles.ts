/**
 * The overlay's looks: one stylesheet that only ever exists inside the closed
 * shadow root, plus the handful of properties that are locked onto the host
 * element itself.
 *
 * Owns: every rule the panel is drawn with, and the host-level layout
 * guarantees.
 *
 * Deliberately NOT: colour. Every value comes from @gather/design through
 * tokens.generated.ts — the same palette web and mobile render. A hex literal
 * here is how the overlay became a third design system once already, and
 * test/design-tokens.test.ts now fails if one comes back.
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

import { TOKEN_CSS } from './tokens.generated';

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
 * The stylesheet. The token block leads, then the rules that read it.
 *
 * Colours follow the reader's system setting; motion is only added when the
 * reader has not asked for less of it. Both are media queries rather than
 * JavaScript, so a change of setting is picked up with no listener to leak and
 * nothing to re-render.
 *
 * `all: initial` does not touch custom properties (it is excluded from the
 * shorthand along with `direction` and `unicode-bidi`), so the tokens declared
 * above survive the reset regardless of block order.
 */
export const OVERLAY_CSS = `${TOKEN_CSS}
:host {
  all: initial;
  position: fixed;
  z-index: ${Z_INDEX};
  pointer-events: none;
  color-scheme: light dark;
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
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

/*
 * The panel and the handle float over a page nobody chose, so they take the
 * NEUTRAL elevation the design system emits (--elevation-e2), not the aurora
 * glow they used to carry. A coloured halo around a chat panel sitting on top
 * of someone else's site is the definition of a thing shouting: it reads as a
 * notification, not as a surface. Glow stays what DESIGN.md §5 makes it — a
 * signature moment — and the overlay has none.
 *
 * The ink on an accent fill is --ink-on-accent: the package measuring, per
 * theme, which of the two absolute inks clears WCAG AA on the colour that
 * actually landed. This used to name --bg-void, a hand-measured answer that
 * held at 5.00:1 dark / 4.85:1 light — and then stopped holding (4.06:1) the
 * moment light --aurora-1 moved for the primary button's gradient. The
 * measured token is 5.21:1 dark and 4.72:1 light and cannot fall out of step
 * with the palette, because it IS the palette answering.
 *
 * Sized from --control-h-sm, so the handle is a 28px chip beside a mouse and a
 * 44px target under a finger, with no media query written here.
 */
.handle {
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  gap: var(--control-gap-sm);
  height: var(--control-h-sm);
  padding: 0 var(--control-px-sm);
  border-radius: var(--radius-pill);
  background: var(--accent);
  color: var(--ink-on-accent);
  font: var(--text-label-weight) var(--text-label-size) / var(--text-label-line) var(--font-sans);
  box-shadow: var(--elevation-e2);
  white-space: nowrap;
}
.handle[hidden] {
  display: none;
}

/*
 * OPAQUE, deliberately: --surface-1, not --surface-glass. The panel is drawn
 * over a page nobody chose, so a wash would take its readability from whatever
 * happens to be behind it. Every text pair below is measured against this
 * surface and against --surface-2, in both themes.
 */
.panel {
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  width: 320px;
  max-width: calc(100vw - 32px);
  max-height: 70vh;
  background: var(--surface-1);
  color: var(--text-hi);
  /* The label step's SIZE at running-text weight. The ramp has no 13px/400
     step because web has no need of one; a 320px overlay does — the body step
     at 15px is a page's size, not a panel's, and 400 is what running text
     takes. (No backticks in this file: OVERLAY_CSS is a template literal.) */
  font: 400 var(--text-label-size) / 1.45 var(--font-sans);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-card);
  box-shadow: var(--elevation-e2);
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
  background: var(--surface-2);
  border-bottom: 1px solid var(--hairline);
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
  font-size: var(--text-label-size);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.status {
  margin: 2px 0 0;
  font-size: var(--text-label-size);
  color: var(--text-mid);
  overflow-wrap: anywhere;
}

/* A real control, sized from the tokens: 28px beside a mouse, 44px under a
   finger. It was a 3px-padded 12px chip, which is under any touch target. */
.hide {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  height: var(--control-h-sm);
  padding: 0 var(--control-px-sm);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  background: var(--surface-1);
  color: var(--text-mid);
  font-size: var(--text-label-size);
}
.hide:hover {
  background: var(--surface-3);
  color: var(--text-hi);
}

.people {
  padding: 10px 12px;
  border-bottom: 1px solid var(--hairline);
}
/* The ramp's caption step, by name — it was a hand-copy of it that had already
   drifted on weight (600 against the ramp's 500) and tracking (0.04 vs 0.06). */
.section-title {
  margin: 0 0 6px;
  font-size: var(--text-caption-size);
  font-weight: var(--text-caption-weight);
  letter-spacing: var(--text-caption-tracking);
  text-transform: uppercase;
  color: var(--text-low);
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
  border: 1px solid var(--hairline);
  border-radius: var(--radius-pill);
  background: var(--surface-2);
}
.person-name {
  font-weight: 600;
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.person-note {
  font-size: var(--text-caption-size);
  color: var(--text-low);
}
.person-empty {
  color: var(--text-mid);
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
/*
 * "Mine" is an accent EDGE, not an accent-coloured name.
 *
 * --accent used to paint this author name, and the design package's guard
 * caught what that actually was: --accent has three jobs already (a gradient
 * stop, a standalone graphic, and a fill under a measured ink), and body text
 * on the lightest surface is a fourth it was never measured for. It cannot be
 * both — black has to sit ON the accent for the primary button, which wants the
 * accent LIGHT, and the accent has to sit on near-white here, which wants it
 * DARK. It measured 4.38:1 in light, under the text bar.
 *
 * As a 3px edge it is a graphic (WCAG 1.4.11, 3:1) and the token holds 3.49:1
 * at its worst rung — and it is the same "this row is yours" language the app
 * already uses for the active queue row.
 */
.msg[data-mine='true'] {
  border-left: var(--layout-edge) solid var(--accent);
  padding-left: 7px;
  margin-left: -10px;
}

.ahead,
.notice {
  margin: 0;
  padding: 0 12px 8px;
  font-size: var(--text-label-size);
  color: var(--text-mid);
}
.ahead[hidden],
.notice[hidden] {
  display: none;
}

.composer {
  display: flex;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid var(--hairline);
  background: var(--surface-2);
}
.input {
  flex: 1 1 auto;
  min-width: 0;
  height: var(--control-h-md);
  font: inherit;
  color: var(--text-hi);
  background: var(--surface-1);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-control);
  padding: 0 9px;
}
/* --ink-on-accent for the same measured reason as .handle. */
.send {
  flex: 0 0 auto;
  height: var(--control-h-md);
  padding: 0 var(--control-px-md);
  border-radius: var(--radius-control);
  background: var(--accent);
  color: var(--ink-on-accent);
  font-weight: var(--text-label-weight);
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
  border-top: 1px solid var(--hairline);
}
.link {
  color: var(--text-mid);
  font-size: var(--text-label-size);
  text-decoration: underline;
}
.link:hover {
  color: var(--text-hi);
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
