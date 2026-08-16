# Gather Design System — "The room floats in space"

Binding for `apps/web` and `apps/mobile`. The feeling: you and your people in a
private cinema drifting through a nebula. Cinematic, weightless, alive — never busy.

## 1. Core idea

The **Stage** (whatever is playing) is the sun; everything else orbits it. UI chrome
is glass that gets out of the way. The room breathes with the media: ambient light
bleeds from the artwork/video into the void behind it.

## 2. Color — tokens (CSS custom properties, OKLCH)

Dark is the primary theme; light ("Daylight") is a first-class variant.

```css
:root[data-theme="dark"] {
  --bg-void:        oklch(0.13 0.02 285);   /* near-black indigo */
  --bg-deep:        oklch(0.17 0.03 290);
  --surface-glass:  color-mix(in oklch, white 5%, transparent);  /* + blur(20px) */
  --surface-raised: color-mix(in oklch, white 8%, transparent);
  --border-glass:   color-mix(in oklch, white 9%, transparent);
  --surface-0:      var(--bg-void);         /* page ground             */
  --surface-1:      oklch(0.19 0.025 290);  /* rail, cards             */
  --surface-2:      oklch(0.23 0.028 290);  /* hover, raised card      */
  --surface-3:      oklch(0.27 0.030 290);  /* active / selected row   */
  --hairline:       color-mix(in oklch, white 6%, transparent);
  --text-hi:        oklch(0.97 0.005 285);
  --text-mid:       oklch(0.78 0.015 285);
  --text-low:       oklch(0.65 0.02 285);   /* was 0.58: AA on surface-3 */
  --aurora-1:       oklch(0.62 0.23 295);   /* electric violet  */
  --aurora-2:       oklch(0.66 0.26 340);   /* fuchsia          */
  --aurora-3:       oklch(0.80 0.16 75);    /* solar amber      */
  --accent:         var(--aurora-1);
  --accent-ink:     oklch(0.98 0.01 295);
  --success:        oklch(0.75 0.17 160);
  --danger:         oklch(0.68 0.21 25);
  --warn:           oklch(0.82 0.16 85);
  --focus-ring:     oklch(0.72 0.20 295);
}
:root[data-theme="light"] {
  --bg-void: oklch(0.97 0.006 290);  --bg-deep: oklch(0.94 0.01 290);
  --surface-glass: color-mix(in oklch, white 65%, transparent);
  /* ladder mirrored: cards go toward white, hover/active come back down */
  --surface-1: oklch(0.995 0.003 290);  --surface-2: oklch(0.955 0.008 290);
  --surface-3: oklch(0.920 0.012 290);
  --hairline:  color-mix(in oklch, oklch(0.30 0.03 285) 12%, transparent);
  --text-hi: oklch(0.22 0.02 285);   --text-mid: oklch(0.42 0.02 285);
  --text-low: oklch(0.50 0.02 285);  /* was 0.55: AA on surface-3 */
  /* aurora hues persist — dial chroma down ~15% for AA on light */
}
```

Rules: gradients only from the three aurora hues (`135deg, a1 → a2 → a3` for primary
actions and brand moments). Body text NEVER sits on a gradient. All token pairs must
pass WCAG AA (4.5:1 text, 3:1 large/UI) — check when tweaking. `--text-low` is the
measured floor: at its previous value metadata fell to 3.5:1 on `--surface-3`, so it
moved to 0.65 (dark) / 0.50 (light), which holds ≥4.6:1 on every step of the ladder.

The aurora gradient is reserved for **three** things: the primary action button, the
brand mark, and the active/playing indicator. Selected/active states are
`--surface-3` plus a 3px `--accent` left edge — never a glow. Listen rooms rebind
`--accent` to the artwork's dominant colour (see §5.1); anything that should retint
with the music uses `bg-accent`, not `aurora-1`.

Tailwind bindings: `bg-surface-0/1/2/3`, `border-hairline`, plus the `.surface-1`,
`.surface-2`, `.surface-3` component classes.

## 3. Typography

- **Display**: Space Grotesk (700/500) — headings, room names, big timers.
- **Text**: Inter (variable) — everything else. Tabular numerals for timestamps.
- **Mono**: JetBrains Mono — invite codes, debug HUD.
- Body scales fluidly 15px → 17px on ≥1440px (set on `body`).

The **type ramp** replaces ad-hoc `text-sm`/`text-xs` sizing. Each utility carries
size, line-height, weight and tracking (defined in `tailwind.config.ts → fontSize`,
so `font-bold` and `sm:` variants still work on top of it):

| Utility | Size/line | Weight · tracking | Use |
|---|---|---|---|
| `text-display` | 32/36 | 600 · −0.02em | Room name, page titles |
| `text-title` | 20/26 | 600 · −0.01em | Section headers, now-playing title |
| `text-body` | 15/22 | 400 | Default |
| `text-label` | 13/18 | 500 | Buttons, meta lines |
| `text-caption` | 11/14 | 500 · +0.04em, uppercase | Overlines, badges |
| `text-hero` | fluid 28→56 | 700 · −0.02em | Marketing/auth heroes only |

Titles are `text-hi`; metadata is `text-low`, **never** `text-mid` — that two-tier
contrast is what makes lists scan. Numeric readouts use `tabular-nums`.

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

Radii: **8** (sm/chips-in-rows), **12** (controls *and* cards), **20** (panels/
sheets), pill. Tighter than before (card 16→12, panel 24→20) — tighter corners read
as more precise. Elevation is **glow, not shadow**: raised elements get a faint
aurora underglow (`box-shadow: 0 0 40px -12px var(--aurora-1)` at 15–25% alpha). A
grain overlay (2% opacity SVG noise) on the void kills banding.

Spacing is the fixed ramp **4 · 8 · 12 · 16 · 24 · 32 · 48** (Tailwind `1 2 3 4 6 8
12`) — no arbitrary values in new code. Named layout constants live on the spacing
scale too: `row` 56px (media row height), `tap` 44px (minimum touch target), `rail`
380px, `edge` 3px (the active-row accent edge).

## 5. Signature moments (build these; they are the product's soul)

1. **Ambient stage glow** — sample the dominant color of the playing artwork and
   bleed it behind the Stage, Apple-Music-style; cross-fade on track change.
   Implemented in `apps/web/lib/artwork-color.ts`: `loadArtworkAccent(src)` →
   16×16 canvas downscale → modal bucket → clamped into the OKLCH band
   L 0.55–0.72 / C 0.06–0.18 so the result stays AA as a fill on both themes.
   Remote artwork usually taints the canvas; that path returns the aurora accent
   silently — a tainted canvas is the expected case, not an error. Listen rooms
   bind the result to `--accent`; `<ArtworkBackdrop>` does the blurred backdrop.
2. **Presence orbs** — participants are floating avatar orbs beneath/beside the Stage
   with a 2px speaking-ring that pulses with voice activity; orbs drift ±4px on a slow
   sine (paused on reduced-motion).
3. **Emote bursts** — reactions float up over the Stage with slight horizontal drift,
   scale-in spring, 2.5 s fade, light parallax between layers.
4. **Sync pulse** — when a seek/track-change lands, a single soft ring expands from
   the play position across the room: the room breathes together.
5. **Aurora drift** — the void background hosts an extremely slow (60 s loop),
   GPU-cheap conic aurora at 6% opacity. Off under reduced-motion or Battery Saver.

## 6. Motion

Framer Motion (web) / Reanimated (mobile). Springs: `stiffness 260, damping 30`.
Micro-interactions 180–240 ms; panels/sheets 280–320 ms; never > 400 ms. Page
transitions: fade + 12px rise. Chat bubbles pop in with 0.96→1 scale spring.
Typing indicator: three dots, staggered 120 ms. `prefers-reduced-motion`: kill
ambient/parallax/drift, keep opacity fades ≤ 150 ms.

## 7. Layout

- **Desktop**: Stage center-left (16:9, letterboxed on the void), right rail 380px —
  glass panel with tabs **Chat / Queue / People**; call strip (PiP orbs) docks above
  the rail. Player chrome auto-hides after 3 s of stillness (cursor or focus wakes it).
- **Mobile (web + native)**: Stage on top (safe-area aware), bottom sheet with the
  same three tabs, swipe between; mini-player pill when scrolled away. Controls ≥44px.
- **Listen rooms**: Stage becomes oversized artwork + progress; queue is promoted
  next to it as a track list; `<ArtworkBackdrop>` behind the page and an
  artwork-derived `--accent` are what make it read as a different product.

## 8. Components (shadcn/ui base, reskinned via tokens)

Buttons: primary = aurora gradient + `--accent-ink`, hover lifts glow; secondary =
glass; destructive = `--danger` fill. Inputs: glass with inner hairline, focus =
2px `--focus-ring` outside. Chat bubbles: mine = subtle aurora-1 tint glass, theirs =
plain glass; author accent color as a 2px leading edge on consecutive-group start;
reactions bloom from the bubble corner. Toasts bottom-center glass. Skeletons shimmer
with aurora at 8%.

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
shortcut sheet; `aria-live="polite"` for incoming chat, `assertive` only for errors;
captions/CC rendered from HLS text tracks with a styling menu; hit targets ≥44px;
reduced-motion + reduced-transparency honored (`prefers-reduced-transparency` swaps
glass for solid `--bg-deep`).

## 10. Never

Default-gray admin-dashboard shadcn look; drop shadows on dark; more than one
gradient in a viewport region; chrome that fights the video; modal overload (prefer
sheets/popovers); spinner walls (skeletons + optimistic UI instead); cheesy 3D
planets — the space vibe comes from color, glow, and motion, not clip-art.

And, since the redesign: glass on anything that isn't floating over moving video;
borders where a background step would do; blank grey artwork boxes; `text-mid` for
list metadata; two primary (aurora) actions in one screen region; hover-only
controls that vanish on touch.
