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
  --bg-void:        oklch(0.115 0.006 265);  /* cinema black            */
  --bg-deep:        oklch(0.160 0.008 265);
  --surface-glass:  oklch(1 0 0 / 0.06);     /* + blur(16px) saturate(1.08) */
  --surface-raised: oklch(1 0 0 / 0.09);
  --border-glass:   oklch(1 0 0 / 0.10);
  --surface-0:      var(--bg-void);          /* page ground             */
  --surface-1:      oklch(0.205 0.009 265);  /* rail, cards             */
  --surface-2:      oklch(0.245 0.010 265);  /* hover, raised card      */
  --surface-3:      oklch(0.275 0.011 265);  /* active / selected row   */
  --hairline:       oklch(1 0 0 / 0.07);
  --scrim:          oklch(0.05 0.008 265 / 0.72);
  --text-hi:        oklch(0.97 0.005 285);
  --text-mid:       oklch(0.78 0.015 285);
  --text-low:       oklch(0.65 0.02 285);    /* measured floor          */
  --aurora-1:       oklch(0.62 0.220 292);   /* electric violet  */
  --aurora-2:       oklch(0.65 0.215 328);   /* magenta          */
  --aurora-3:       oklch(0.70 0.170 356);   /* warm rose        */
  --accent:         var(--aurora-1);
  --success:        oklch(0.75 0.17 160);
  --danger:         oklch(0.68 0.21 25);
  --warn:           oklch(0.82 0.16 85);
  --focus-ring:     oklch(0.72 0.20 292);
}
:root[data-theme="light"] {
  --bg-void: oklch(0.965 0.004 265);  --bg-deep: oklch(0.925 0.006 265);
  --surface-glass:  oklch(1 0 0 / 0.70);   --surface-raised: oklch(1 0 0 / 0.85);
  --border-glass:   oklch(0.28 0.012 265 / 0.16);
  /* ladder mirrored: cards go toward white, hover/active come back down */
  --surface-1: oklch(0.995 0.002 265);  --surface-2: oklch(0.950 0.005 265);
  --surface-3: oklch(0.910 0.008 265);
  --hairline:  oklch(0.28 0.012 265 / 0.14);
  --scrim:     oklch(0.05 0.008 265 / 0.72);   /* the same wash in both themes */
  --text-hi: oklch(0.22 0.012 265);  --text-mid: oklch(0.42 0.014 265);
  --text-low: oklch(0.49 0.014 265); /* was 0.55 → 3.83:1 on surface-3 */
  --aurora-1: oklch(0.585 0.175 292);  --aurora-2: oklch(0.615 0.175 328);
  --aurora-3: oklch(0.655 0.145 356);  --accent: var(--aurora-1);
  --success:  oklch(0.55 0.15 160);  --danger:  oklch(0.55 0.19 25);
  --warn:     oklch(0.58 0.14 85);   /* was 0.62 → 2.88:1 on surface-3 */
  --focus-ring: oklch(0.58 0.18 292);
}
```

**The neutrals went cooler, deeper and genuinely neutral (2026-08-19).** The dark
ladder was 0.13 / 0.19 / 0.23 / 0.27 at chroma 0.02–0.03 on hue 285–290, and it had
two problems at once. The chroma was high enough that the "neutrals" were a dark
violet — a tint on every surface in the product, which is what made the whole room
read as one flat mauve field. And the void was not actually dark: at 0.13 it sat
close enough to the rail that a panel did not read as a panel. Chroma is now
0.006–0.011 (a cast you can feel and not name) on hue 265, and the void drops to
0.115, which opens the void → rail step from 0.06 to 0.09 of perceptual lightness.
Daylight took the same move: hue 290 → 265, chroma down, and `--surface-3` 0.92 →
0.91. **The three dark text tokens did not move** — deepening the surfaces under
them only bought headroom, and `--text-low` is still the measured floor of the whole
system.

**`--surface-3` is the rung both themes are pinned by, from opposite directions.**
On dark it is the lightest surface, so it decides how low `--text-low` may go
(4.56:1 there; above ≈0.28 it falls under AA). On light it is the darkest surface,
so it decides how light `--accent` may go (3.43:1 there). Neither can be raised
without moving the other token with it.

**The aurora was narrowed from 140° to 64° (2026-08-19).** It was violet 295 →
fuchsia 340 → amber 75: an arc across half the wheel, which is a *rainbow*, and a
rainbow on a button is decoration rather than identity. It is now violet 292 →
magenta 328 → warm rose 356, each with a notch less chroma, so the three stops read
as **one accent with depth in it** instead of three colours agreeing to share a
surface. Amber did not survive and does not need to: `--warn` is the amber in the
system, and it means something.

**The gradient has a budget, and it is three.** `linear-gradient(135deg, a1, a2,
a3)` is allowed on the **primary action**, the **brand mark**, and the **live /
playing indicator** — and on nothing else, ever. It was on every button in the
product, which is how a brand asset became wallpaper: an accent that appears
everywhere carries no information, and the room had no way to say *this one*. A
screen region contains at most one of the three. Everything that merely wants to be
tinted uses flat `--accent` (which retints with the artwork, §5.1), and everything
that merely wants to be visible uses the surface ladder. Body text NEVER sits on a
gradient.

All token pairs must pass WCAG AA (4.5:1 text, 3:1 large/UI) —
`packages/design/test/palette.test.ts` walks the whole surface ladder and fails the
build, so this is enforced, not remembered. `--text-low` is the measured floor: at
its previous value metadata fell to 3.53:1 (dark) / 3.83:1 (light) on `--surface-3`,
so it sits at 0.65 / 0.49, holding ≥4.56:1 (dark) and ≥4.82:1 (light) on every step
of the ladder.

**The light aurora is a band, not a point, and the reason is the button.** The
primary action's fill is the whole 135° gradient, so *one* ink has to clear all
three stops, and on light that ink can only be black — which gets better as the fill
gets **lighter**. `--accent` aliases `--aurora-1` and is also drawn on light
surfaces as an edge, a ring, a progress fill — which gets better as the fill gets
**darker**. The two pull opposite ways. `--aurora-1: 0.585` sits in the band both
allow: black on the gradient floors at 4.68:1 (text bar 4.5) and the accent floors
at 3.43:1 on `--surface-3` (non-text bar 3).

**The cost is a rule.** On light, `--accent` clears the 3:1 **non-text** bar and not
the 4.5:1 text bar — so it is a fill, a border, a focus ring, a progress bar or an
active edge, and **never a text colour**. Accented text takes `--text-hi` with the
accent carried by an adjacent fill or edge instead. (Dark `--accent` is unaffected;
the rule is written theme-blind so one class cannot be safe in one theme and failing
in the other.) Light `--ink-on-accent` is likewise black, not white, which is why
ink is chosen per fill and never per theme (§2.1).

**`--scrim` is a measured token, not an effect.** It is the wash behind a dialog or
a sheet, and the one it replaced was faint enough that the page underneath stayed
fully readable — a dialog that is modal in the DOM and not to a reader.
`packages/design/test/palette.test.ts` composites *everything the page can show*
under it and fails if any pair still reaches 3:1, so "faint" cannot ship again. It
is one absolute near-black at the same alpha in both themes, because what a scrim
has to suppress is the brightest pixel available and that is a near-white either
way. Use `.scrim` (`apps/web/app/globals.css`), never a hand-rolled `bg-black/50`.

One call site does not follow this yet — known debt, not a counterexample:
a surviving `text-accent-ink` in `components/extension/ExtensionGate.tsx`. (The
`hover:text-accent` glass text buttons this note used to name in
`components/stage/StagePane.tsx` and `ListenStage.tsx` have since been replaced
with tokened variants.) `packages/design/test/palette.test.ts` walks token
*pairs*; it never reads a Tailwind class string, so the shape is not caught
automatically.

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
best — because picking per stop is how the old button ended up at 1.79:1 against the
amber `aurora-3` that preceded the narrowing. Today every one of these resolves to
`--ink-black` except light `--ink-on-danger`, which is `--ink-white`. The narrowed
gradient's floor under black is 5.27:1 on dark and 4.68:1 on light.

`--accent` is not a constant: the listen composition rebinds it to the artwork's
dominant colour at runtime (§5.1). A consumer doing that must recompute the ink at
the same time — `inkForFill(hex)` from `@gather/design` returns it. `--accent-ink`
is still emitted for compatibility; **do not use it in new code.**

Selected/active states are `--surface-3` plus a 3px `--accent` left edge — never a
glow. Anything that should retint with the music uses `bg-accent`, not `aurora-1`.

Tailwind bindings: `bg-surface-0/1/2/3`, `border-hairline`, `bg-scrim`, plus the
`.surface-1`, `.surface-2`, `.surface-3`, `.scrim`, `.grain` and `.aurora-gradient`
component classes in `apps/web/app/globals.css`.

## 3. Typography

- **Display**: Space Grotesk — headings, room names, big timers. The ramp uses
  600 for `display`/`headline`/`title` and 700 for `hero`.
- **Text**: Inter (variable) — everything else. Tabular numerals for timestamps.
- **Mono**: JetBrains Mono — invite codes, debug HUD. (Bundled on web only;
  mobile has no `expo-font`, so RN falls back — see apps/mobile/README.md.)
- Body scales fluidly 16px → 18px across the viewport band (set on `body` in
  `globals.css`, which is where the `body` step's `maxFontSize` is spent — the
  `text-body` utility itself is a flat 16px).

The **type ramp** replaces ad-hoc `text-sm`/`text-xs` sizing. Each utility carries
size, line-height, weight and tracking (defined in `tailwind.config.ts → fontSize`,
so `font-bold` and `sm:` variants still work on top of it):

| Utility | Size/line | Weight · tracking | Use |
|---|---|---|---|
| `text-hero` | fluid 40→88, ratio 1.04 | 700 · −0.045em | Marketing/auth heroes only, one per page |
| `text-display` | 44/48 | 600 · −0.035em | **The oversized moment**: now-playing title, signature empty state |
| `text-headline` | 28/34 | 600 · −0.025em | Room name, page titles, dialog titles |
| `text-title` | 20/28 | 600 · −0.01em | Section headers, card titles |
| `text-body` | 16/26 | 400 | Default |
| `text-label` | 13/18 | 500 | Buttons, meta lines |
| `text-caption` | 11/14 | 500 · +0.08em, uppercase | Overlines, badges |

**The display end was raised 2026-08-19, and it is the single biggest change in this
pass.** The ramp topped out at `display` 32 with `title` 20 under it — a dashboard
ramp. Nothing in the product was ever allowed to be *big*, so the room title
rendered at 14px, the stage's empty state was one 16px line floating in a black
void, and every element on screen argued for the same attention. A composition
without a display moment has no hierarchy. `display` is now 44 and unmistakably a
display setting beside 16px body; `headline` 28 is new and exists so the jump from
20 to 44 does not get bridged by someone inventing a size; `hero` roughly doubles to
a fluid 40→88.

**`title` deliberately did not move.** It is the most-used step in the product and
every surface below already sits correctly against it; what was missing was
everything *above* it. `body` went the other way — 15/22 (1.47) → 16/26 (1.63),
because reading text wants more air, not less.

**Tracking and leading both tighten as the size grows, and never the other way.**
That is optical, not stylistic: −0.045em on an 88px hero is the setting that makes
it read as *set* rather than as *typed*, and the same value at 13px is what makes
small text look squeezed. Leading runs 1.63 at body down to 1.04 at hero.
`packages/design/test/scales.test.ts` enforces both directions — a flat "≥1.2
everywhere" rule would be as wrong at the top as the old 32/36 was in the middle.
`caption` tracking is +0.08em: an 11px uppercase overline is doing structural work
and needs the air to read as a rule rather than as shouting.

**Which step, when.** `hero` is auth and marketing only. `display` is reserved for
the *one* thing a screen is about — the now-playing title, the headline of a
signature empty state — and a screen has at most one. `headline` names the screen
or the dialog. `title` names a section inside it. Below that is text.

Fluidity is a WEB-ONLY property, and so is the desktop display size. React Native
has no viewport unit, so `hero` carries an explicit `rnFontSize: 36`
(`packages/design/src/scales.ts`); `display` carries `rnFontSize: 32` for a
different reason — 44px is display type for a desktop, not for a 390pt phone.
`emitRnTypeRamp` reads `rnFontSize ?? fontSize`, scales the leading by the step's
*ratio* so a resized step keeps its proportions, and `maxFontSize` NEVER reaches
React Native; without that rule the ceiling was about to start leaking into body
text too.

Titles are `text-hi`; metadata is `text-low`, **never** `text-mid` — that two-tier
contrast is what makes lists scan. Numeric readouts use `tabular-nums`.

The ramp lives in `packages/design/src/scales.ts` and is emitted as
`--text-<step>-{size,line,weight,tracking}` alongside `--font-{display,sans,mono}`,
`--dur-{micro,panel,max,reduced}` and `--ease-spring`.

## 4. Surfaces & depth

**Glass is now reserved for surfaces that float over moving video**: the transport
bar, modals/sheets, the theater-mode call overlay, toasts. Those keep `.glass-panel`
/ `.glass-raised` (`--surface-glass` + `backdrop-filter: blur(16px) saturate(1.08)`
+ 1px `--border-glass`). Never stack two glass layers.

Everything else — rails, cards, rows, popovers over static ground — uses the solid
**elevation ladder**: `--surface-0` ground, `--surface-1` rail/cards, `--surface-2`
hover/raised, `--surface-3` active/selected. Surfaces are separated by **background
step, not by border**; a `border-hairline` is allowed only where two same-step
surfaces meet (rail against stage). Remove every other border.

That rule and the hairline ring in the elevation ladder below are not in conflict,
because they answer different questions. A resting surface separates by *step* — it
is part of the page, and a border round it is noise. A surface that has **left** the
page (a menu, a dialog, a toast) is drawn against content it does not own, so it has
to state where it ends: that is the ring, and it comes with the elevation rather than
being written at the call site.

Radii: **6** (`sm` — chips, badges, menu items), **8** (`control` — buttons, inputs,
selects), **14** (`card` — media rows, cards, popovers), **20** (`panel` — glass
panels, sheets, dialogs), **28** (`stage` — the oversized surfaces: now-playing
artwork, the stage frame, a signature empty state's plate), pill. Tailwind:
`rounded-sm / -ctl / -card / -panel / -stage / -pill`.

**The ends were committed to 2026-08-19.** 6 / 8 / 10 / 14 was four values inside
one octave, so a chip, a button, a row and a sheet were all cut roughly the same and
none of them read as a different *kind* of surface. The small end did not move; the
large end did. The rule this replaces said "radii are only ever tightened, never
loosened", which is true of a **control** and false of a large surface: what reads
as cartoonish is a corner that is a large *fraction* of its owner's height, which is
why the guard in `packages/design/test/scales.test.ts` is a ratio and not a value.
`control` stays 8 (0.25 of a 32px button) for exactly that reason; a 28px corner on
a 480px stage plate is 0.06 of its height — the opposite end of the same rule.

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
- **Shadow** is how ordinary chrome says "this floats", and since 2026-08-19 it is
  **hairline-first**: each level is a crisp `0 0 0 1px` ring plus **one** soft,
  wide shadow — never a stack of blurs. Stacked blur reads as *soft*, and soft is
  the opposite of crafted. The edge carries the precision, the shadow carries the
  distance. `--elevation-e1` raised (hovered card, inline popover, `0 2px 8px -3px`),
  `--elevation-e2` floating (dropdowns, tooltips, toasts, the extension overlay
  panel, `0 10px 30px -8px`), `--elevation-e3` modal (dialogs, sheets,
  `0 24px 64px -16px`).

  The two layers name **different** colours and this is load-bearing. The shadow is
  a wash of the absolute `--ink-black` (a shadow is an absence of light and must not
  invert with the palette); the ring is a wash of `--hairline`, which *must* invert,
  because the edge that reads on a near-black ground is a light one and a black ring
  on the dark theme draws nothing at all. Only the shadow climbs — an edge does not
  get realer as a panel floats higher. On React Native the ring is a `borderWidth` /
  `borderColor`, since RN has no ring-shaped shadow; spending the view's border on it
  is what hairline-first costs there.

**Grain (`--grain`, `--grain-size`) is the one texture in the system.** The product's
own line is a private cinema drifting through a nebula and the app had no texture at
all, which is why it read as glossy rather than crafted. It is inline SVG turbulence
at **3.5%** — felt, not seen; above ~5% it is a pattern and below ~2% the display's
own dithering eats it. It is a token, so all three renderers reach the same noise.
Use it on the void and on **large quiet surfaces**: a stage plate, a full-bleed empty
state, a sheet. Do **not** use it on rows, controls, chips or anything under ~200px
(the 160px tile repeats visibly and reads as dirt), never over video, never behind
text, and never load-bearing — a host page with a strict `img-src` drops the data URI
and the surface has to still be complete. Web: `.grain`. There are no external
assets, by requirement: the extension overlay is injected into a page whose CSP it
does not control.

Spacing is the fixed ramp **4 · 8 · 12 · 16 · 24 · 32 · 48 · 64 · 96 · 128**
(emitted as `--space-{xs,sm,md,lg,xl,xxl,xxxl,section,chapter,canvas}`; Tailwind
`p-1 … p-12` for the first seven, plus `p-section` / `p-chapter` / `p-canvas`) — no
arbitrary values in new code.

**The top three rungs were added 2026-08-19 and they are the whitespace half of the
re-composition.** The ramp stopped at 48, so every gap in the product came from the
same four rungs, nothing had more room around it than anything else, and uniform
spacing reads as uniform importance. Editorial hierarchy is made mostly of
whitespace. They are named by role because a reader picking between `xxxl` and
`xxxxl` has no way to guess: **`section` 64** between blocks inside one composition,
**`chapter` 96** around a display moment or between major regions of a page,
**`canvas` 128** the breathing room a signature empty state or hero sits in. The
first seven rungs did not move.

Named layout constants live on the spacing scale too: `row` 56px (media row height),
`tap` 44px (minimum touch target), `rail` 380px, `edge` 3px (the active-row accent
edge), `tabBar` 48px (mobile bottom sheet).

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
   `motion.auroraDriftMs`), GPU-cheap conic aurora at 5% opacity (`.void-aurora`).
   6% → 5% with the deepened void: the same wash reads stronger against a true
   black, and this is ambient light, not a smudge. Off under reduced-motion or
   Battery Saver.

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

**One primary per screen region, and it is the only gradient there** (§2). The
gradient budget is what makes `primary` mean "this is the action"; a second one
beside it makes both mean "a button". Everything else in the region is `secondary`
or `ghost`.

Inputs: glass with inner hairline, focus = 2px `--focus-ring` outside. Chrome paints
an autofilled field with its own light lavender, which no `background-color` rule can
reach — `globals.css` overrides it with an inset `--surface-2` shadow plus
`-webkit-text-fill-color`. Do not re-solve that per component. Chat bubbles:
mine = subtle aurora-1 tint glass, theirs = plain glass; author accent color as a 2px
leading edge on consecutive-group start; reactions bloom from the bubble corner.
Toasts bottom-center glass. Skeletons shimmer with aurora at 8%. Dialogs and sheets
sit on `.scrim` (§2) — never a hand-rolled black wash.

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

And since 2026-08-19: the aurora gradient anywhere outside its three sanctioned
places (§2) — it is an identity, not a fill; grain on a small surface, over video,
behind text, or carrying meaning (§4); a stack of blurred shadows where the
hairline-first ladder belongs; `text-display` more than once on a screen, or on
anything that is not what the screen is about (§3); a modal scrim written by hand
instead of `--scrim`; and uniform spacing — a composition where every gap is `lg`
has told the reader that nothing on it matters more than anything else.

## 11. Locked decisions (owner, 2026-08-16 — do not relitigate)

Absorbed from the UX overhaul spec (removed — see `docs/history/README.md`); this is
the binding copy.

- **D1 — Call layout:** video tiles live in the **right rail above chat**; the
  content stage is never covered. Theater mode collapses the rail; tiles become
  a small overlay the user can hide and restore.
- **D1.1 — Theater mode spec (owner, 2026-08-18; unified 2026-08-20):**
  **Theater and fullscreen are the same mode, and the mode is LOCAL.** One
  latch (`useImmersive`, components/room/ImmersiveStage.tsx), entered by the
  header Theater button, the transport's fullscreen control, the share-stage
  control or `F`, available to **every member** — it fills only the viewer's
  own screen, so it is as personal as mute and never role-gated. The stage
  section takes true browser fullscreen where the platform grants it
  (StagePane's `useFullscreen`); where it cannot (iOS Safari, forbidden
  iframes) the immersive **layout is the mode** — header and rail gone, stage
  full-bleed — and fullscreen is only the enhancement. `F` enters/exits;
  `Esc` exits (browser-owned while the top layer is up, ours otherwise).
  The old server-backed room-wide flag is dead as a driver: nothing PATCHes
  `/rooms/:id/theater` from the header any more, and `room.theater === true`
  is read only as a legacy hint that keeps the control offered in rooms that
  stored it. One person's toggle re-laying-out everyone's room was a lever,
  not a layout.
  In the mode: a glass sidebar (`.glass-panel`) carries **chat**, with an
  explicit hide button on the sidebar and a 48px edge handle to bring it back
  — the handle carries the unread count (the shell's own projection, the same
  number the rail's Chat trigger shows). Call participants render as floating
  circular tiles (Meet-style pills) starting from the top-right, docked to a
  configurable left/right edge (default: right), each showing the avatar or
  camera feed with a speaking ring; the pills collapse to the edge and come
  back, and edge + collapsed are per-viewer preferences in localStorage —
  never room state. The call overlay never covers the stage center — it docks
  to the edge. All immersive chrome mounts **inside the stage section**,
  because the fullscreen top layer paints over everything else. This is the
  one layout where floating chrome is glass, because it genuinely floats over
  moving video. Budget: enter 1 step, chat 1 step, leave 1 step (§12).
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
