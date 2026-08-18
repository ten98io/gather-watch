# Gather Design System — "The room floats in space"

Binding for `apps/web` and `apps/mobile`. The feeling: you and your people in a
private cinema drifting through a nebula. Cinematic, weightless, alive — never busy.

## 1. Core idea

The **Stage** (whatever is playing) is the sun; everything else orbits it. UI chrome
gets out of the way — by *stepping back on the elevation ladder*, and only by
turning to glass where it genuinely floats over moving video (§4). The room breathes
with the media: ambient light bleeds from the artwork/video into the void behind it.

## 2. Color — tokens (CSS custom properties, OKLCH)

Dark is the primary theme; light ("Daylight") is a first-class variant.

**Colour values are authored in exactly one place: `packages/design/src/tokens.ts`.**
Web reads them through the CSS emitter (`apps/web/app/tokens.generated.css`,
regenerate with `pnpm --filter @gather/web tokens:generate`), mobile through the RN
emitter (`apps/mobile/src/theme.ts`), the extension overlay through the shadow-root
emitter (`apps/extension/src/overlay/tokens.generated.ts`). **A hex or oklch literal
anywhere else is a bug** — that is exactly how mobile once shipped `--text-low` a
whole accessibility fix behind web. The block below mirrors the emitted output; if
the two ever disagree, `tokens.ts` is right and this section is stale.

```css
:root[data-theme="dark"] {
  --bg-void:        oklch(0.13 0.02 285);   /* near-black indigo */
  --bg-deep:        oklch(0.17 0.03 290);
  --surface-glass:  oklch(1 0 0 / 0.05);    /* + blur(20px) saturate(1.3) */
  --surface-raised: oklch(1 0 0 / 0.08);
  --border-glass:   oklch(1 0 0 / 0.09);
  --surface-0:      var(--bg-void);         /* page ground             */
  --surface-1:      oklch(0.19 0.025 290);  /* rail, cards             */
  --surface-2:      oklch(0.23 0.028 290);  /* hover, raised card      */
  --surface-3:      oklch(0.27 0.030 290);  /* active / selected row   */
  --hairline:       oklch(1 0 0 / 0.06);
  --text-hi:        oklch(0.97 0.005 285);
  --text-mid:       oklch(0.78 0.015 285);
  --text-low:       oklch(0.65 0.02 285);   /* was 0.58 → 3.53:1 on surface-3 */
  --aurora-1:       oklch(0.62 0.23 295);   /* electric violet  */
  --aurora-2:       oklch(0.66 0.26 340);   /* fuchsia          */
  --aurora-3:       oklch(0.80 0.16 75);    /* solar amber      */
  --accent:         var(--aurora-1);
  --success:        oklch(0.75 0.17 160);
  --danger:         oklch(0.68 0.21 25);
  --warn:           oklch(0.82 0.16 85);
  --focus-ring:     oklch(0.72 0.20 295);
}
:root[data-theme="light"] {
  --bg-void: oklch(0.97 0.006 290);  --bg-deep: oklch(0.94 0.01 290);
  --surface-glass:  oklch(1 0 0 / 0.65);   --surface-raised: oklch(1 0 0 / 0.8);
  --border-glass:   oklch(0.30 0.03 285 / 0.14);
  /* ladder mirrored: cards go toward white, hover/active come back down */
  --surface-1: oklch(0.995 0.003 290);  --surface-2: oklch(0.955 0.008 290);
  --surface-3: oklch(0.920 0.012 290);
  --hairline:  oklch(0.30 0.03 285 / 0.12);
  --text-hi: oklch(0.22 0.02 285);   --text-mid: oklch(0.42 0.02 285);
  --text-low: oklch(0.50 0.02 285);  /* was 0.55 → 3.83:1 on surface-3 */
  --aurora-1: oklch(0.59 0.19 295);  --aurora-2: oklch(0.60 0.21 340);
  --aurora-3: oklch(0.70 0.14 75);   --accent: var(--aurora-1);
  --success:  oklch(0.55 0.15 160);  --danger:  oklch(0.55 0.19 25);
  --warn:     oklch(0.58 0.14 85);   /* was 0.62 → 2.88:1 on surface-3 */
  --focus-ring: oklch(0.58 0.18 295);
}
```

Rules: gradients only from the three aurora hues (`135deg, a1 → a2 → a3` for primary
actions and brand moments). Body text NEVER sits on a gradient. All token pairs must
pass WCAG AA (4.5:1 text, 3:1 large/UI) — `packages/design/test/palette.test.ts`
walks the whole surface ladder and fails the build, so this is enforced, not
remembered. `--text-low` is the measured floor: at its previous value metadata fell
to 3.53:1 (dark) / 3.83:1 (light) on `--surface-3`, so it moved to 0.65 / 0.50,
which holds ≥4.68:1 on every step of the ladder.

**The light aurora was lightened 2026-08-18, and the reason is the button.** The
primary action's fill is the 135° gradient, so *one* ink has to clear all three
stops. On light the best single ink measured 3.96:1 — under the 4.5:1 text bar.
Black is the only ink that can win there (light `aurora-3` is amber: 7.69:1 with
black, 2.73:1 with white), and black gets better as the fill gets lighter. So
`aurora-1` went 0.55 → 0.59 (black: 3.96 → 4.72:1) and `aurora-2` 0.58 → 0.60
(4.33 → 4.74:1), each dropping one notch of chroma so the hue does not go neon.

**The stated cost, and it is a rule now:** `--accent` aliases `aurora-1`, and as
a standalone light colour its worst rung fell 4.17 → 3.49:1 on `--surface-3`.
That still clears the 3:1 **non-text** bar and no longer clears the 4.5:1 text
bar — so on light, `--accent` is a fill, a border, a focus ring, a progress bar
or an active edge, and **never a text colour**. Accented text takes `--text-hi`
with the accent carried by an adjacent fill or edge instead. (Dark `--accent` is
unaffected; the rule is written theme-blind so one class cannot be safe in one
theme and failing in the other.) Light `--ink-on-accent` also flipped white →
black, 5.31 → 4.72:1, which is why ink is chosen per fill and never per theme
(§2.1).

Three call sites do not follow this yet — known debt, not counterexamples:
`hover:text-accent` on the glass text buttons in `components/stage/StagePane.tsx`
and `components/stage/ListenStage.tsx`, and one surviving `text-accent-ink` in
`components/extension/ExtensionGate.tsx`. `packages/design/test/palette.test.ts`
walks token *pairs*; it never reads a Tailwind class string, so neither shape is
caught automatically.

### 2.1 Ink on a fill — never theme-relative

A fill and the ink on it are a **pair**, and the ink is chosen against the fill it
lands on, never against the theme. `--accent-ink` was the theme's answer and being
theme-relative is exactly what broke it: a near-white in *both* themes, it sat on
dark's vivid fills at 3.80:1 on `--accent`, 2.99:1 on `--danger`, 1.67:1 on `--warn`.
Every filled label in the dark theme shipped under AA.

The replacement is two absolute inks — the sRGB endpoints, neither of them a
palette token, so no colour tuning can flip one out from under a fill:

```css
--ink-black: oklch(0 0 0);   --ink-white: oklch(1 0 0);
```

and one emitted `--ink-on-<fill>` per fill token (`aurora-1/2/3`, `accent`,
`success`, `danger`, `warn`), each set to whichever ink measures higher against
that fill in that theme. A label crossing the whole gradient takes
**`--ink-on-aurora-gradient`**, which is a *maximin* — the ink whose worst stop is
best — because picking per stop is how the old button ended up at 1.79:1 against
`aurora-3`. Today every one of these resolves to `--ink-black` except light
`--ink-on-danger`, which is `--ink-white`.

`--accent` is not a constant: the listen composition rebinds it to the artwork's
dominant colour at runtime (§5.1). A consumer doing that must recompute the ink at
the same time — `inkForFill(hex)` from `@gather/design` returns it. `--accent-ink`
is still emitted for compatibility; **do not use it in new code.**

The aurora gradient is reserved for **three** things: the primary action button, the
brand mark, and the active/playing indicator. Selected/active states are
`--surface-3` plus a 3px `--accent` left edge — never a glow. Anything that should
retint with the music uses `bg-accent`, not `aurora-1`.

Tailwind bindings: `bg-surface-0/1/2/3`, `border-hairline`, plus the `.surface-1`,
`.surface-2`, `.surface-3` and `.aurora-gradient` component classes in
`apps/web/app/globals.css`.

## 3. Typography

- **Display**: Space Grotesk — headings, room names, big timers. The ramp uses
  600 for `display`/`title` and 700 for `hero`.
- **Text**: Inter (variable) — everything else. Tabular numerals for timestamps.
- **Mono**: JetBrains Mono — invite codes, debug HUD. (Bundled on web only;
  mobile has no `expo-font`, so RN falls back — see apps/mobile/README.md.)
- Body scales fluidly 15px → 17px on ≥1440px (set on `body` in `globals.css`,
  which is where the `body` step's `maxFontSize` is spent — the `text-body`
  utility itself is a flat 15px).

The **type ramp** replaces ad-hoc `text-sm`/`text-xs` sizing. Each utility carries
size, line-height, weight and tracking (defined in `tailwind.config.ts → fontSize`,
so `font-bold` and `sm:` variants still work on top of it):

| Utility | Size/line | Weight · tracking | Use |
|---|---|---|---|
| `text-display` | 32/40 | 600 · −0.02em | Room name, page titles |
| `text-title` | 20/28 | 600 · −0.01em | Section headers, now-playing title |
| `text-body` | 15/22 | 400 | Default |
| `text-label` | 13/18 | 500 | Buttons, meta lines |
| `text-caption` | 11/14 | 500 · +0.06em, uppercase | Overlines, badges |
| `text-hero` | fluid 28→56, ratio 1.05 | 700 · −0.02em | Marketing/auth heroes only |

**Leading was retuned 2026-08-18.** `display` was 32/36 — a ratio of 1.125, a poster
setting, and one of the things that made the product read as a toy at a glance. A
page title is a document, not a banner: 32/40 is 1.25. `title` took the same
correction one step down, 20/26 (1.30) → 20/28 (1.40). `caption` tracking went
+0.04 → +0.06em: 11px uppercase is the one place in the ramp where under-tracking
reads as cramped rather than tight.

`hero` is the only genuinely fluid step. React Native has no viewport unit and takes
the 28px floor, which is why mobile's hero is currently smaller than its
pre-redesign 34px `displayL` (HANDOFF open item 10).

Titles are `text-hi`; metadata is `text-low`, **never** `text-mid` — that two-tier
contrast is what makes lists scan. Numeric readouts use `tabular-nums`.

The ramp lives in `packages/design/src/scales.ts` and is emitted as
`--text-<step>-{size,line,weight,tracking}` alongside `--font-{display,sans,mono}`,
`--dur-{micro,panel,max,reduced}` and `--ease-spring`.

## 4. Surfaces & depth

**Glass is now reserved for surfaces that float over moving video**: the transport
bar, modals/sheets, the theater-mode call overlay, toasts. Those keep `.glass-panel`
/ `.glass-raised` (`--surface-glass` + `backdrop-filter: blur(20px) saturate(1.3)` +
1px `--border-glass`). Never stack two glass layers.

Everything else — rails, cards, rows, popovers over static ground — uses the solid
**elevation ladder**: `--surface-0` ground, `--surface-1` rail/cards, `--surface-2`
hover/raised, `--surface-3` active/selected. Surfaces are separated by **background
step, not by border**; a `border-hairline` is allowed only where two same-step
surfaces meet (rail against stage). Remove every other border.

Radii: **6** (`sm` — chips, badges, menu items), **8** (`control` — buttons, inputs,
selects), **10** (`card` — media rows, cards, popovers), **14** (`panel` — glass
panels, sheets, dialogs), pill. Retightened 2026-08-18 from 8/12/12/20: a corner is
only legible relative to the height it is cut into, and this ladder holds every rung
at 0.18–0.25 of its owner's height (6/28, 8/32, 10/56). `control` and `card` were the
same value before, so a 32px button and a 56px row were cut identically; separating
them is what makes a control read as a control. **Radii are only ever tightened here,
never loosened** — a looser corner is the cheapest way back to looking cartoonish.

**Control geometry carries desktop density across all three clients.** Web used to
hard-code `h-9 / h-11 / h-12`, so the default button was 44px tall beside 15px body
text — the single loudest reason the product read as cartoonish. Professional desktop
density is 32–36px. Each size therefore carries *two* heights, selected by a media
query rather than a breakpoint guess:

| Size | `(pointer: fine)` | `(pointer: coarse)` | padding-x · gap | text · radius |
|---|---|---|---|---|
| `sm` | 28 | 44 | 10 · 6 | `label` · `sm` |
| `md` | 32 | 44 | 12 · 8 | `label` · `control` |
| `lg` | 40 | 48 | 20 · 8 | `body` · `control` |

Tightening desktop density is never paid for out of the touch target: a guard test
holds `touchHeight ≥ layout.tap`. Emitted as `--control-h/px/gap-{sm,md,lg}`.

**Elevation is two systems, and mixing them is the bug that was fixed.** "Glow, not
shadow" was taken literally everywhere — a 40px aurora glow sat under the dropdown
menu, the dialog, the toast and a secondary button on hover. A coloured glow under
ordinary chrome is a toy tell; it says "look at me" about a context menu.

- **Glow** stays, and is now *only* for signature moments (§5): the listen hero
  artwork, the playing indicator. `box-shadow: 0 0 40px -12px var(--aurora-1)` at
  15–25% alpha.
- **Shadow** is how ordinary chrome says "this floats": three neutral, directional
  ladders, two layers each (one contact, one ambient), with alphas of the **absolute**
  `--ink-black` so a shadow never inverts with the palette. `--elevation-e1` raised
  (hovered card, inline popover), `--elevation-e2` floating (dropdowns, tooltips,
  toasts, the extension overlay panel), `--elevation-e3` modal (dialogs, sheets).

A grain overlay (2% opacity SVG noise, `--grain`) on the void kills banding.

Spacing is the fixed ramp **4 · 8 · 12 · 16 · 24 · 32 · 48** (Tailwind `1 2 3 4 6 8
12`, emitted as `--space-{xs,sm,md,lg,xl,xxl,xxxl}`) — no arbitrary values in new
code. Named layout constants live on the spacing scale too: `row` 56px (media row
height), `tap` 44px (minimum touch target), `rail` 380px, `edge` 3px (the active-row
accent edge), `tabBar` 48px (mobile bottom sheet).

## 5. Signature moments (all five are built; they are the product's soul)

These are the only places glow, drift and parallax are allowed. Ordinary chrome
gets the shadow ladder instead (§4).

1. **Ambient stage glow** — sample the dominant color of the playing artwork and
   bleed it behind the Stage, Apple-Music-style; cross-fade on track change.
   Implemented in `apps/web/lib/artwork-color.ts`: `loadArtworkAccent(src)` →
   16×16 canvas downscale → modal bucket → clamped into the OKLCH band
   L 0.55–0.72 / C 0.06–0.18 so the result stays AA as a fill on both themes.
   Remote artwork usually taints the canvas; that path returns the aurora accent
   silently — a tainted canvas is the expected case, not an error. The listen
   composition binds the result to `--accent`; `<ArtworkBackdrop>` does the
   blurred backdrop.
2. **Presence orbs** — participants are floating avatar orbs with a 2px
   speaking-ring that pulses with voice activity; orbs drift ±4px on a slow sine
   (paused on reduced-motion). `components/call/CallSurface.tsx`. The ring is
   measured from the actual audio (WebAudio peak), not from a mic-on flag, and it
   is suppressed while the browser is refusing to play the call — a ring that
   pulses for audio nobody can hear is a lie.
3. **Emote bursts** — reactions float up over the Stage with slight horizontal drift,
   scale-in spring, 2.5 s fade (`motion.emoteBurstMs`), light parallax between
   layers. `components/stage/EmoteOverlay.tsx`.
4. **Sync pulse** — when a seek/track-change lands, a single soft ring expands from
   the play position across the room: the room breathes together. `SyncPulse` in
   `components/stage/StagePane.tsx` + the `sync-pulse` keyframes in `globals.css`;
   skipped entirely under reduced-motion.
5. **Aurora drift** — the void background hosts an extremely slow (60 s loop,
   `motion.auroraDriftMs`), GPU-cheap conic aurora at 6% opacity (`.void-aurora`).
   Off under reduced-motion or Battery Saver.

## 6. Motion

Framer Motion (web) / core RN Animated (mobile — Reanimated is deferred for install
weight). Springs: `stiffness 260, damping 30`, with `cubic-bezier(0.34, 1.3, 0.64, 1)`
as the CSS approximation for transitions that cannot use a spring
(`--ease-spring`). Micro-interactions 180–240 ms (default **220**, `--dur-micro`);
panels/sheets 280–320 ms (default **300**, `--dur-panel`); never > 400 ms
(`--dur-max`). Page transitions: fade + 12px rise. Chat bubbles pop in with 0.96→1
scale spring. Typing indicator: three dots, staggered 120 ms.
`prefers-reduced-motion`: kill ambient/parallax/drift, keep opacity fades ≤ 150 ms
(`--dur-reduced`).

## 7. Layout

- **Desktop**: Stage center-left (16:9, letterboxed on the void), right rail 380px
  (`--layout-rail`) with tabs **Chat / Queue / People**; the call surface docks
  above the tabs at the same elevation step, separated by a hairline. The rail is
  solid `--surface-1`, **not** glass — glass is for things floating over moving
  video, which in theater mode the rail becomes (it collapses to a floating panel,
  §11 D1). Player chrome auto-hides after 3 s of stillness (cursor or focus wakes
  it).
- **Mobile (web + native)**: Stage on top (safe-area aware), bottom sheet with the
  same three tabs, swipe between; mini-player pill when scrolled away. Controls ≥44px.
- **Listen composition** (per playing item, not per room — §11 D3): Stage becomes
  oversized artwork + progress; queue is promoted next to it as a track list;
  `<ArtworkBackdrop>` behind the page and an artwork-derived `--accent` are what
  make it read as a different product.

## 8. Components (shadcn/ui base, reskinned via tokens)

Buttons (`components/ui/button.tsx`, variants `primary | secondary | destructive |
ghost`, sizes `sm | md | lg | icon`): primary = `.aurora-gradient`, which sets
`--ink-on-aurora-gradient` itself — do not restate an ink on it; secondary =
`--surface-2` (solid ladder, **not** glass — a button in a settings page is not
floating over video); destructive = `--danger` fill with `--ink-on-danger`; ghost =
`text-mid` with a `--surface-2` hover. Labels are weight **500**, not 600 — the ramp
already carries the weight and stacking a heavier one is how every control ended up
shouting equally. Hover is `brightness-105`, never a glow: a 40px aurora halo under
"Cancel" is the loudest toy tell in the product. Heights come from
`--control-h-{sm,md,lg}`, never a Tailwind step, so the same class is 32px under a
mouse and 44px under a finger.

Inputs: glass with inner hairline, focus = 2px `--focus-ring` outside. Chat bubbles:
mine = subtle aurora-1 tint glass, theirs = plain glass; author accent color as a 2px
leading edge on consecutive-group start; reactions bloom from the bubble corner.
Toasts bottom-center glass. Skeletons shimmer with aurora at 8%.

Icons come from `components/ui/icons.tsx` only — inline SVG, `currentColor`,
stroke-width **1.75**, 16px inside buttons, 20px standalone. Emoji are content
(reactions, chat), never controls.

### 8.1 Content-forward primitives (`components/ui/`)

The media is the interface; these five carry it. Prefer composing them over
hand-rolling a row or a thumbnail.

- **`<Artwork>`** `{src?, alt, kind: 'video'|'music', size?: 40|48|64|96|'full',
  shape?: 'square'|'video', rounded?: 'sm'|'ctl'|'card'|'panel'|'full', className?}`
  — poster/thumbnail. **Never renders an empty box**: with no/broken/loading `src`
  it shows a deterministic gradient hashed from `alt` plus the provider glyph.
  `alt=''` marks it decorative (the adjacent title already names the item).
- **`<MediaRow>`** `{artwork, title, meta?, leading?, actions?, active?, onActivate?,
  as?: 'div'|'li', titleLines?: 1|2, activateLabel?, …HTML/drag props}` — the single
  row primitive for queue, history, search results and playlist import. 56px tall,
  active = `surface-3` + 3px accent left edge. `actions` are hover/focus-revealed on
  pointer devices and **always visible on touch** via the exported `HOVER_REVEAL`
  class string — reuse it, don't retype it (the duplicated
  `group-focus-within:opacity-100` is load-bearing, see the comment).
- **`<NowPlaying>`** `{title, kind, artworkUrl?, provider?, meta?, positionMs?,
  durationMs?, variant?: 'hero'|'compact', actions?}` — large artwork + title +
  provider + progress (hero) or the 48px row version (compact). Progress is a
  read-only `role="progressbar"`; the fill is `bg-accent`.
- **`<ArtworkBackdrop>`** `{src?, blur?, dim?}` — fixed, blurred, darkened artwork
  behind the page, cross-fading on track change, instant under reduced motion.
- **`<EmptyState>`** `{icon, title, description?, action?}` — icon + one sentence +
  **at most one** primary action. Every empty list uses it; no bare "Nothing here".

## 9. Accessibility & compliance (non-negotiable)

WCAG 2.1 AA contrast on every token pair; visible `:focus-visible` rings everywhere;
full keyboard map (space play/pause, ←/→ seek 10 s, C captions, M mute) with a "?"
shortcut sheet (`SHORTCUTS` in `app/room/[id]/room-shell.tsx` is the single list —
the sheet renders it, so the sheet cannot drift from the bindings);
`aria-live="polite"` for incoming chat, `assertive` only for errors; captions
rendered from the playing element's own text tracks, and the CC control is hidden
outright when the source has none (`captionsAvailable`) rather than offered and
inert; hit targets ≥44px;
reduced-motion + reduced-transparency honored (`prefers-reduced-transparency` swaps
glass for solid `--bg-deep`).

## 10. Never

Default-gray admin-dashboard shadcn look; ad-hoc drop shadows (the only shadows in
the system are `--elevation-e1/e2/e3`, and they are for chrome that floats — never
for a resting card or a hover state); more than one gradient in a viewport region;
chrome that fights the video; modal overload (prefer sheets/popovers); spinner walls
(skeletons + optimistic UI instead); cheesy 3D planets — the space vibe comes from
color, glow, and motion, not clip-art.

And, since the redesign: glass on anything that isn't floating over moving video;
glow on anything that isn't a signature moment (§5); borders where a background step
would do; blank grey artwork boxes; `text-mid` for list metadata; two primary
(aurora) actions in one screen region; hover-only controls that vanish on touch;
a hard-coded colour, radius, duration or type size anywhere outside
`packages/design`; `--accent-ink` in new code; `--accent` as a **text** colour
(it is a 3:1 non-text colour on light — §2).

## 11. Locked decisions (owner, 2026-08-16 — do not relitigate)

Absorbed from the UX overhaul spec (now `docs/history/UX_OVERHAUL.md`); this is
the binding copy.

- **D1 — Call layout:** video tiles live in the **right rail above chat**; the
  content stage is never covered. Theater mode collapses the rail; tiles become
  a small overlay the user can hide and restore.
- **D1.1 — Theater mode spec (owner, 2026-08-18):** fullscreen stage (true
  browser fullscreen, not just maximized). Hover or click toggles a floating
  glass-effect sidebar for chat, queue, and people. The sidebar uses
  `.glass-panel` (`--surface-glass` + `backdrop-filter`) and collapses to a
  48px handle when dismissed. Call participants render as floating circular
  tiles on a configurable left/right edge (default: right), each tile showing
  the avatar or camera feed in a 64px circle with a 2px speaking ring. The
  call overlay never covers the stage center — it docks to the edge. This is
  the only layout where the rail is glass, because it genuinely floats over
  moving video. Keyboard shortcut: `F` enters/exits theater mode; `Esc` exits.
- **D2 — Camera default:** mic on, camera off, with a prominent "Turn on
  camera" affordance on your own tile. No pre-join device dialog. Never render
  a silent empty call region — everyone in the call gets a tile.
- **D3 — Listen composition, now per item:** centred large artwork, dominant
  visualiser, up-next as a track list, artwork-derived `--accent`, none of the
  video-stage furniture. **Superseding note (2026-08-17):** this composition is
  no longer bound to a "listen room". Rooms are adaptive — `mediaKindFor(ref)`
  routes the stage per **playing item**, so the same room renders the listen
  composition for a track and the video composition for a video. `room.kind`
  is vestigial on the wire and drives nothing.
- **D4 — Refresh depth: all three levels.** Design-system pass **and** full
  visual redesign **and** bug/flow fixes. Reference points are best-in-class
  consumer apps (Spotify for listening, modern video apps for watching):
  artwork, posters, thumbnails and real titles everywhere content appears.

## 12. The ≤3-step budget (binding on every flow)

"Step" = one user-initiated interaction (click, tap, keypress-to-submit) from
the **room screen** (in-room features) or the **home screen** (account-level
features). Typing into an already-focused field does not count; opening a
dialog does. Measure by walking the running app — never guess the count.

| Flow | Budget |
|---|---|
| Create a room | 3 |
| Join by code | 2 |
| Join a password-protected room | 3 |
| Invite someone | 2 |
| Add content to queue | 2 |
| Play a queued item | 1 |
| Reorder / remove a queue item | 1 |
| Join the call | 1 |
| Turn camera/mic on | 1 |
| Share your screen | 2 |
| Cast to a TV | 2 |
| Send a message / emoji / GIF | 1–2 |
| Open the room's playback history and replay an item | 3 |
| Link a music/video account | 3 |
| Delete / rename a room | 2 |

**Password-gated rooms:** the passphrase step adds one interaction to the join
flow. A room with no password stays at the original budget. The passphrase is
entered on the same screen as the invite code, not as a separate page, so the
step is a field fill + submit, not a navigation.

**Sanctioned exceptions** (never counted against the budget): third-party OAuth
consent, browser/OS pickers (screen share, cast), and destructive-action
confirmations.

Two rows describe flows that are budgets rather than measurements, because the
flow does not exist yet: **link a music/video account** is backlog. Playback
history is built — it is a dialog off the Queue tab
(`components/queue/HistoryDialog.tsx`, `GET /rooms/:roomId/history`), reached as
rail tab → History → row, which is why its budget is 3 and not 2. There is no
account-level "library"; history is per room and dies with it.
