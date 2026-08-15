# Playin Design System — "The room floats in space"

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
  --text-hi:        oklch(0.97 0.005 285);
  --text-mid:       oklch(0.78 0.015 285);
  --text-low:       oklch(0.58 0.02 285);
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
  --text-hi: oklch(0.22 0.02 285);   --text-mid: oklch(0.42 0.02 285);
  /* aurora hues persist — dial chroma down ~15% for AA on light */
}
```

Rules: gradients only from the three aurora hues (`135deg, a1 → a2 → a3` for primary
actions and brand moments). Body text NEVER sits on a gradient. All token pairs must
pass WCAG AA (4.5:1 text, 3:1 large/UI) — check when tweaking.

## 3. Typography

- **Display**: Space Grotesk (700/500) — headings, room names, big timers.
- **Text**: Inter (variable) — everything else. Tabular numerals for timestamps.
- **Mono**: JetBrains Mono — invite codes, debug HUD.
- Fluid scale: `clamp()` from 15px body to 17px on ≥1440px; display sizes
  `clamp(1.75rem, 1rem + 2.5vw, 3.5rem)`. Tracking −1% on display, 0 on body.

## 4. Surfaces & depth

Glassmorphism, disciplined: max two glass layers over the void. Panels =
`--surface-glass` + `backdrop-filter: blur(20px) saturate(1.3)` + 1px `--border-glass`
+ radius. Radii: 12 (controls), 16 (cards/bubbles), 24 (panels/sheets), pill (chips).
Elevation is **glow, not shadow**: raised elements get a faint aurora underglow
(`box-shadow: 0 0 40px -12px var(--aurora-1)` at 15–25% alpha). A grain overlay
(2% opacity SVG noise) on the void kills banding.

## 5. Signature moments (build these; they are the product's soul)

1. **Ambient stage glow** — sample the dominant color of the playing video/artwork
   (offscreen canvas, 1 fps) and bleed it as a huge soft radial behind the Stage,
   Apple-Music-style. Crossfade 800 ms on track change.
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
- **Listen rooms**: Stage becomes oversized artwork + waveform seek bar; queue is
  promoted next to it; visual language identical.

## 8. Components (shadcn/ui base, reskinned via tokens)

Buttons: primary = aurora gradient + `--accent-ink`, hover lifts glow; secondary =
glass; destructive = `--danger` fill. Inputs: glass with inner hairline, focus =
2px `--focus-ring` outside. Chat bubbles: mine = subtle aurora-1 tint glass, theirs =
plain glass; author accent color as a 2px leading edge on consecutive-group start;
reactions bloom from the bubble corner. Toasts bottom-center glass. Skeletons shimmer
with aurora at 8%.

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
