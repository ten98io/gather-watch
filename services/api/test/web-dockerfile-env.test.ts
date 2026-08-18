/**
 * apps/web/Dockerfile must declare every NEXT_PUBLIC_ variable the web app
 * reads — and the required one must fail the BUILD when it is missing.
 *
 * NEXT_PUBLIC_* are inlined into the client bundle at `next build` time, and a
 * variable the Dockerfile does not declare as an ARG never reaches the build:
 * Next quietly falls back to whatever default the source has and the image
 * ships broken with a green deploy. The Dockerfile declared one of three, so
 * both the extension-id pin and the install-funnel link were dead in every
 * built image — invisible until someone tried to install the extension.
 *
 * This lives in the api suite because it is the only test surface in scope for
 * the change; what it guards is a repo invariant, not an api behaviour. It
 * DERIVES the list from apps/web source rather than hardcoding it, so adding a
 * new `process.env.NEXT_PUBLIC_*` read without declaring it fails here.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const WEB_ROOT = resolve(import.meta.dirname, '../../../apps/web');
const DOCKERFILE = join(WEB_ROOT, 'Dockerfile');
const SKIP_DIRS = new Set(['node_modules', '.next', '.turbo', 'test', 'tests']);
const SOURCE_EXT = /\.(tsx?|jsx?|mjs|cjs)$/;

/** Every source file the built bundle could include (tests excluded). */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.') || SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
    } else if (SOURCE_EXT.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** The NEXT_PUBLIC_ names apps/web actually reads. */
function readNames(): string[] {
  const names = new Set<string>();
  for (const file of sourceFiles(WEB_ROOT)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/process\.env\.(NEXT_PUBLIC_[A-Z0-9_]+)/g)) {
      names.add(match[1] as string);
    }
  }
  return [...names].sort();
}

describe('apps/web/Dockerfile build args', () => {
  const dockerfile = readFileSync(DOCKERFILE, 'utf8');

  it('finds the NEXT_PUBLIC_ reads it is supposed to be guarding', () => {
    // A regex that silently matches nothing would make every assertion below
    // vacuously true.
    const names = readNames();
    expect(names.length).toBeGreaterThanOrEqual(3);
    expect(names).toContain('NEXT_PUBLIC_API_URL');
  });

  it('declares an ARG for every one of them', () => {
    for (const name of readNames()) {
      expect(dockerfile).toMatch(new RegExp(`^ARG ${name}\\s*$`, 'm'));
    }
  });

  it('promotes each declared ARG into the build ENV', () => {
    // ARG alone is invisible to `next build`; only ENV reaches the process.
    for (const name of readNames()) {
      expect(dockerfile).toMatch(new RegExp(`${name}=\\$\\{${name}\\}`));
    }
  });

  it('fails the build loudly when the required one is missing', () => {
    expect(dockerfile).toMatch(/if \[ -z "\$NEXT_PUBLIC_API_URL" \]/);
    expect(dockerfile).toMatch(/exit 1/);
    // The message has to name the variable, or the operator is back to
    // guessing — which is the whole failure being fixed.
    expect(dockerfile).toMatch(/ERROR: build arg NEXT_PUBLIC_API_URL is required/);
  });

  it('runs the guard before the build, not after it', () => {
    const guardAt = dockerfile.indexOf('if [ -z "$NEXT_PUBLIC_API_URL" ]');
    const buildAt = dockerfile.indexOf("pnpm --filter '{./apps/web}...'");
    expect(guardAt).toBeGreaterThan(-1);
    expect(buildAt).toBeGreaterThan(guardAt);
  });
});
