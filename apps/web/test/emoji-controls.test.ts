/**
 * DESIGN.md §8's icon rule, as a guard instead of a sentence.
 *
 * The rule has been written down since the redesign — "Icons come from
 * `components/ui/icons.tsx` only … Emoji are content (reactions, chat), never
 * controls" — and the product shipped `✕` as the toast's dismiss button, `⚙` as
 * room settings, `📌` as pin, `👑` as the host marker, `☾`/`☀` as the theme
 * toggle, `🔕` as mute, `🌌` at 36px as the error illustration. A rule that only
 * exists in prose is a rule that is already being broken somewhere.
 *
 * ── Why an emoji is not an icon ───────────────────────────────────────────
 * It is a glyph from the platform's emoji font, so it ignores `currentColor`
 * (it arrives full-colour into a greyscale toolbar), ignores `stroke-width`,
 * sits on the text baseline rather than optically centred in its hit area, and
 * renders as a different picture on every OS. `components/ui/icons.tsx` is
 * inline SVG at stroke-width 1.75 that inherits colour and size from the
 * control it sits in.
 *
 * ── How this test is shaped, and why ──────────────────────────────────────
 * `components/ui/**` is held at ZERO: it is the primitive layer, and a
 * violation there is inherited by every surface. Everywhere else is held to a
 * SUBSET of the inventory below rather than to an exact match, because the
 * remaining sites belong to other people's files — fixing one must never turn
 * this test red, and adding a new one always must.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Emoji and the dingbat/geometric glyphs that get pressed into service as
 * icons: `✕` U+2715, `⚙` U+2699, `☾` U+263E, `▾` U+25BE.
 *
 * Arrows (U+2190–U+21FF) are deliberately NOT here. `→` is real punctuation in
 * running copy ("Settings → Your data") and flagging it would bury the signal;
 * the one arrow that IS a control, `←` in app/admin, is called out by hand.
 */
// U+FE0F (the emoji variation selector) is an alternative rather than a member
// of the class: inside one it combines with the preceding range into a single
// "character" as far as the regex engine is concerned, which is both wrong and
// what `no-misleading-character-class` exists to catch.
const PICTOGRAPH =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{25A0}-\u{25FF}]|\u{FE0F}/u;

/**
 * Strip `//` and block comments before scanning.
 *
 * Not cosmetic: this very file, icons.tsx and toast.tsx all NAME the offending
 * glyphs in prose to explain them, and a scanner that cannot tell code from
 * commentary would flag the explanation as the crime.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  let mode: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (mode === 'code') {
      if (two === '//') {
        mode = 'line';
        i += 2;
        continue;
      }
      if (two === '/*') {
        mode = 'block';
        i += 2;
        continue;
      }
      if (source[i] === "'") mode = 'single';
      else if (source[i] === '"') mode = 'double';
      else if (source[i] === '`') mode = 'template';
      out += source[i];
      i += 1;
      continue;
    }
    if (mode === 'line') {
      if (source[i] === '\n') {
        mode = 'code';
        out += '\n';
      }
      i += 1;
      continue;
    }
    if (mode === 'block') {
      if (two === '*/') {
        mode = 'code';
        i += 2;
        continue;
      }
      // Keep newlines so reported line numbers stay true.
      if (source[i] === '\n') out += '\n';
      i += 1;
      continue;
    }
    // Inside a string literal: copy through, honouring escapes.
    if (source[i] === '\\') {
      out += source.slice(i, i + 2);
      i += 2;
      continue;
    }
    const closer = mode === 'single' ? "'" : mode === 'double' ? '"' : '`';
    if (source[i] === closer) mode = 'code';
    out += source[i];
    i += 1;
  }
  return out;
}

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(WEB_ROOT, dir), { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      out.push(...tsxFiles(rel));
    } else if (entry.name.endsWith('.tsx')) {
      out.push(rel);
    }
  }
  return out.sort();
}

interface Site {
  readonly file: string;
  readonly line: number;
}

function pictographSites(dir: string): Site[] {
  const sites: Site[] = [];
  for (const file of tsxFiles(dir)) {
    const source = stripComments(readFileSync(join(WEB_ROOT, file), 'utf8'));
    source.split('\n').forEach((line, index) => {
      if (PICTOGRAPH.test(line)) sites.push({ file, line: index + 1 });
    });
  }
  return sites;
}

const key = (site: Site): string => `${site.file.replaceAll('\\', '/')}:${site.line}`;

/**
 * Emoji that ARE content and must never be "fixed" into icons — the whole
 * second half of the rule. A reaction picker full of stroked SVGs is not a
 * reaction picker.
 */
const CONTENT_EMOJI: readonly string[] = [
  'components/chat/Composer.tsx', // the emoji picker's palette
  'components/chat/MessageBubble.tsx', // QUICK_REACTIONS, and the reaction chips
  'components/chat/ChatPane.tsx', // "No messages yet — say hi 👋"
  'app/admin/page.tsx', // "Inbox zero — no open reports. 🎉"
];

/**
 * The inventory, taken 2026-08-18. Every entry is an emoji standing in for a
 * control or for chrome, in a file this change does not own; each is listed
 * with the icon that replaces it.
 *
 * Entries may be REMOVED freely (that is the point). Nothing may be added
 * without also adding it here, which is the conversation this guard exists to
 * force.
 */
const KNOWN_UNCONVERTED: readonly string[] = [
  'components/room/RoomMenu.tsx', // ⚙ → <SettingsIcon />
  'components/chat/ChatPane.tsx', // 📌 → <PinIcon />, ▾/▸ → Chevron{Down,Right}Icon, 🔍 → <SearchIcon />
  'components/chat/MessageBubble.tsx', // 📎 → <PaperclipIcon />, 📌 → <PinIcon />
  'components/people/PeoplePane.tsx', // 🎙/🔇 → <MicIcon />/<MicOffIcon />, 👑 → <CrownIcon />
  'app/home/page.tsx', // ☾/☀ → <MoonIcon />/<SunIcon />, 🔕 → <BellOffIcon />
  'app/settings/page.tsx', // 📱/💻 → <SmartphoneIcon />/<MonitorIcon />
  'app/admin/page.tsx', // 🔑 → <KeyIcon />, 🛡 → <ShieldIcon />, 🎭 → <TheaterIcon />
  'app/error.tsx', // 🌌 → <OrbitIcon />
  'app/global-error.tsx', // 🌌 → <OrbitIcon />
  'app/not-found.tsx', // 🌌 → <OrbitIcon />
  'app/room/[id]/error.tsx', // 🌌 → <OrbitIcon />
  'app/room/[id]/room-shell.tsx', // 🌌 → <OrbitIcon />
];

const ALLOWED_FILES = new Set([...CONTENT_EMOJI, ...KNOWN_UNCONVERTED]);

describe('the ui primitives carry no emoji at all', () => {
  it('components/ui/** is clean, because everything else inherits it', () => {
    const sites = pictographSites('components/ui').map(key);
    expect(
      sites,
      `emoji in a ui primitive: ${sites.join(', ')} — use components/ui/icons.tsx`,
    ).toEqual([]);
  });

  it('and icons.tsx actually supplies what the remaining sites need', () => {
    // Listing a replacement above that does not exist would be a promise, not a
    // fix. These are the icons this change added for the call sites in
    // KNOWN_UNCONVERTED; the test is what stops one being dropped later.
    const icons = readFileSync(join(WEB_ROOT, 'components/ui/icons.tsx'), 'utf8');
    for (const name of [
      'SettingsIcon',
      'PinIcon',
      'ChevronRightIcon',
      'CrownIcon',
      'SunIcon',
      'MoonIcon',
      'BellOffIcon',
      'SmartphoneIcon',
      'MonitorIcon',
      'KeyIcon',
      'ShieldIcon',
      'ArrowUpIcon',
      'ArrowDownIcon',
      'OrbitIcon',
      'XIcon',
    ]) {
      expect(icons, `${name} is named as a replacement but not exported`).toContain(
        `export function ${name}(`,
      );
    }
  });
});

describe('no NEW emoji-as-control appears anywhere in the app', () => {
  it('every emoji site is one already accounted for', () => {
    const sites = [...pictographSites('components'), ...pictographSites('app')];
    const unexpected = sites
      .map((site) => site.file.replaceAll('\\', '/'))
      .filter((file) => !ALLOWED_FILES.has(file));
    expect(
      [...new Set(unexpected)],
      'new emoji in a file the inventory does not know about — if it is a ' +
        'CONTROL use components/ui/icons.tsx; if it is genuinely CONTENT, add ' +
        'the file to CONTENT_EMOJI and say why',
    ).toEqual([]);
  });

  it('the toast no longer dismisses with a glyph', () => {
    // The specific site the audit named. Pinned by hand because it is the one
    // that had an icon sitting in icons.tsx the whole time.
    const toast = readFileSync(join(WEB_ROOT, 'components/ui/toast.tsx'), 'utf8');
    expect(stripComments(toast)).not.toContain('✕');
    expect(toast).toContain('<XIcon');
  });
});

describe('the scanner can tell code from commentary', () => {
  it('ignores an emoji named inside a comment', () => {
    expect(stripComments("const a = 1; // the ✕ button\n")).not.toMatch(PICTOGRAPH);
    expect(stripComments('/* ⚙ was here */ const b = 2;\n')).not.toMatch(PICTOGRAPH);
  });

  it('does NOT ignore one inside a string or JSX text', () => {
    expect(stripComments("const a = '✕';\n")).toMatch(PICTOGRAPH);
    expect(stripComments('<button>⚙</button>\n')).toMatch(PICTOGRAPH);
  });

  it('keeps line numbers true across a multi-line comment', () => {
    const stripped = stripComments("a\n/* ⚙\n   more\n*/\nb ✕\n");
    expect(stripped.split('\n')[4]).toContain('✕');
  });

  it('names this repo relative to apps/web, so the messages are actionable', () => {
    expect(relative(WEB_ROOT, join(WEB_ROOT, 'components/ui'))).toBe('components/ui');
  });
});
