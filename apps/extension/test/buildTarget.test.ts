import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  MANIFEST_DESCRIPTION_MAX,
  PROD_BUILD_COMMAND,
  buildLabel,
  formatBuildBanner,
  formatBuildInfo,
  isLoopbackUrl,
  isReleaseVersion,
  manifestIconPaths,
  manifestPatternOrigin,
  manifestShipErrors,
  originsMissingFromManifest,
  parseWebOriginsStrict,
  resolveBuildTarget,
  stampManifest,
} from '../src/buildTarget';
import { DEFAULT_API_URL, DEFAULT_WEB_ORIGINS, parseWebOrigins } from '../src/config';

const PROD = { GATHER_BUILD: 'prod', GATHER_API_URL: 'https://api.gather.watch' };

/**
 * The defect this file exists for: the artifact that was actually on disk and
 * actually deployed was a localhost build. Nothing at build time said so,
 * nothing in the artifact said so, and the extension it produced installs
 * cleanly and then fails every call it ever makes.
 */
describe('a production build cannot be a localhost build by accident', () => {
  it('refuses to guess an API origin — there is no production default', () => {
    expect(() => resolveBuildTarget({ GATHER_BUILD: 'prod' })).toThrow(
      /must name the API origin/i,
    );
  });

  it('names the exact command that fixes it, in the error itself', () => {
    let message = '';
    try {
      resolveBuildTarget({ GATHER_BUILD: 'prod' });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('build:prod');
    expect(message).toContain('GATHER_API_URL=');
  });

  it('refuses a loopback origin, however it is spelt', () => {
    for (const url of [
      'http://localhost:4000',
      'http://127.0.0.1:4000',
      'https://127.0.0.1',
      'http://[::1]:4000',
      'http://0.0.0.0:4000',
    ]) {
      expect(() => resolveBuildTarget({ ...PROD, GATHER_API_URL: url }), url).toThrow(
        /machine that is building it/i,
      );
    }
  });

  it('refuses a plaintext origin — the room token is sent to it on every call', () => {
    expect(() =>
      resolveBuildTarget({ ...PROD, GATHER_API_URL: 'http://api.gather.watch' }),
    ).toThrow(/not https/i);
  });

  it('refuses a near-miss mode rather than quietly downgrading to dev', () => {
    // 'production' silently meaning 'dev' is the original defect, rebuilt.
    for (const mode of ['production', 'PROD', 'release']) {
      expect(() => resolveBuildTarget({ GATHER_BUILD: mode }), mode).toThrow(/GATHER_BUILD/);
    }
  });

  it('accepts a real production origin, and says it is production', () => {
    const target = resolveBuildTarget({ ...PROD, GATHER_API_URL: 'https://api.gather.watch/' });

    expect(target.mode).toBe('prod');
    // Trailing slash stripped exactly as src/config.ts strips it, so the
    // inlined value and the runtime constant cannot disagree.
    expect(target.apiUrl).toBe('https://api.gather.watch');
    expect(target.loopback).toBe(false);
  });
});

describe('the dev build', () => {
  it('still needs no configuration — `pnpm build` is unchanged', () => {
    const target = resolveBuildTarget({});

    expect(target.mode).toBe('dev');
    expect(target.apiUrl).toBe(DEFAULT_API_URL);
    expect(target.loopback).toBe(true);
  });

  it('says what it is, and how to build the real one, on stdout', () => {
    const banner = formatBuildBanner(resolveBuildTarget({}));

    expect(banner).toContain('DEV BUILD');
    expect(banner).toContain(DEFAULT_API_URL);
    expect(banner).toContain(PROD_BUILD_COMMAND);
  });

  it('leaves the same fact in the artifact, for whoever finds it later', () => {
    const info = formatBuildInfo(resolveBuildTarget({}), '2026-08-18T00:00:00.000Z');

    expect(info).toContain('mode:        dev');
    expect(info).toContain(DEFAULT_API_URL);
    expect(info).toMatch(/do not ship it/i);
  });

  it('renames itself in chrome://extensions, where the owner will see it', () => {
    const stamped = stampManifest(
      { name: 'Gather — Watch Together', version: '0.1.0' },
      resolveBuildTarget({}),
    );

    expect(stamped['name']).toBe('Gather — Watch Together (DEV)');
    expect(stamped['version_name']).toBe(`0.1.0 — dev — ${DEFAULT_API_URL}`);
  });

  it('a production artifact keeps the shipped name, and records its origin', () => {
    const stamped = stampManifest(
      { name: 'Gather — Watch Together', version: '0.1.0' },
      resolveBuildTarget(PROD),
    );

    expect(stamped['name']).toBe('Gather — Watch Together');
    expect(stamped['version_name']).toBe('0.1.0 — prod — https://api.gather.watch');
  });

  /**
   * The one host permission every artifact must carry: its own API origin.
   * An extension bypasses CORS only for origins it holds host permissions
   * on; when the manifest went to zero host access, every worker fetch to
   * the API died in preflight ("Failed to fetch" on join, members, room,
   * events) — in the REAL browser only, because the suite fakes fetch. The
   * grant is stamped from the SAME baked-in origin the calls use, so the
   * two cannot drift.
   */
  it('stamps the API origin as the one host permission, in both modes', () => {
    const prod = stampManifest({ version: '1.0.0' }, resolveBuildTarget(PROD));
    expect(prod['host_permissions']).toEqual(['https://api.gather.watch/*']);

    // Match patterns carry no port — one WITH a port is invalid to Chrome
    // and would kill the dev artifact at load. Portless matches every port.
    const dev = stampManifest({ version: '1.0.0' }, resolveBuildTarget({}));
    expect(dev['host_permissions']).toEqual(['http://localhost/*']);
  });

  it('keeps and dedupes host permissions the source manifest already carries', () => {
    const stamped = stampManifest(
      { version: '1.0.0', host_permissions: ['https://api.gather.watch/*', 'https://other.example/*'] },
      resolveBuildTarget(PROD),
    );
    expect(stamped['host_permissions']).toEqual([
      'https://api.gather.watch/*',
      'https://other.example/*',
    ]);
  });
});

/**
 * The dev script pointed at a real origin is a THIRD thing, and calling it
 * either of the other two is a lie: the https, loopback and manifest-subset
 * checks did not run on it, but it is not a localhost artifact either.
 */
describe('a dev-script build with a remote origin says exactly that', () => {
  const target = resolveBuildTarget({ GATHER_API_URL: 'https://api.gather.watch' });

  it('is neither labelled production nor described as local', () => {
    expect(buildLabel(target)).toMatch(/^UNVERIFIED BUILD/);
    expect(target.loopback).toBe(false);
    expect(formatBuildBanner(target)).not.toContain('PRODUCTION BUILD');
  });

  it('does not tell the reader it talks to the build machine, because it does not', () => {
    const info = formatBuildInfo(target, '2026-08-18T00:00:00.000Z');

    expect(info).not.toMatch(/machine it was built on/);
    expect(info).toMatch(/never ran/);
    expect(info).toContain('https://api.gather.watch');
  });
});

/* ── the second gate: GATHER_WEB_ORIGINS ──────────────────────────────── */

/**
 * `src/config.ts` has declared `__GATHER_WEB_ORIGINS__` and the README has
 * documented it for as long as either existed — but tsup never defined it, so
 * the documented command set an env var that nothing read and the allowlist
 * silently stayed the built-in one.
 */
describe('the web-origin allowlist is actually wired to the build', () => {
  it('inlines a normalised list the runtime parser round-trips exactly', () => {
    const target = resolveBuildTarget({
      ...PROD,
      GATHER_WEB_ORIGINS: ' https://Gather.Watch/room/1 , https://www.gather.watch ',
    });

    expect(target.webOrigins).toBe('https://gather.watch,https://www.gather.watch');
    // config.ts is what reads the inlined string in the browser; what the
    // build writes and what the extension reads must be the same list.
    expect(parseWebOrigins(target.webOrigins)).toEqual([...target.effectiveWebOrigins]);
  });

  it('falls back to the built-in list when unset', () => {
    const target = resolveBuildTarget(PROD);

    expect(target.webOrigins).toBe('');
    expect(target.effectiveWebOrigins).toEqual(DEFAULT_WEB_ORIGINS);
  });

  it('fails the build on a typo instead of dropping it', () => {
    // At runtime a bad entry is dropped so the allowlist fails closed. At
    // build time the same entry means an origin the owner meant to allow is
    // missing — and the person who can fix that is standing right here.
    expect(() => parseWebOriginsStrict('https://gather.watch,gather.watch')).toThrow(
      /not an http\(s\) origin/,
    );
    expect(parseWebOriginsStrict('')).toEqual([]);
    expect(parseWebOriginsStrict('https://a.test,https://a.test/x')).toEqual(['https://a.test']);
  });
});

describe('the manifest is checked against the in-code allowlist at build time', () => {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../public/manifest.json', import.meta.url)), 'utf8'),
  ) as { externally_connectable: { matches: string[] } };

  it('admits every origin the default list would allow', () => {
    expect(
      originsMissingFromManifest(DEFAULT_WEB_ORIGINS, manifest.externally_connectable.matches),
    ).toEqual([]);
  });

  it('catches an origin Chrome would block before any code runs', () => {
    expect(
      originsMissingFromManifest(
        ['https://gather.watch', 'https://staging.gather.watch'],
        manifest.externally_connectable.matches,
      ),
    ).toEqual(['https://staging.gather.watch']);
  });

  it('treats a wildcard pattern as covering nothing — too strict, never too loose', () => {
    expect(manifestPatternOrigin('https://gather.watch/*')).toBe('https://gather.watch');
    expect(manifestPatternOrigin('https://*.gather.watch/*')).toBeNull();
    expect(manifestPatternOrigin('*://gather.watch/*')).toBeNull();
    expect(originsMissingFromManifest(['https://a.gather.watch'], ['https://*.gather.watch/*'])).toEqual(
      ['https://a.gather.watch'],
    );
  });
});

/* ── the artifact itself: icons, the announce entry, a real version ─────── */

/**
 * All three fail SILENTLY at install time — an icon path with no file behind
 * it and a placeholder version surface at store review, and a content-script
 * entry that misses a Gather origin kills the extension-id announce there.
 * The build refuses instead; these pins keep the refusal honest.
 */
describe('the manifest cannot ship broken', () => {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../public/manifest.json', import.meta.url)), 'utf8'),
  ) as Record<string, unknown>;
  const publicFiles = readdirSync(fileURLToPath(new URL('../public', import.meta.url)));

  it('the shipped manifest and the shipped public/ pass', () => {
    expect(manifestShipErrors(manifest, publicFiles, DEFAULT_WEB_ORIGINS)).toEqual([]);
  });

  it('reads every icon path the manifest carries, both surfaces, deduped', () => {
    const paths = manifestIconPaths(manifest);
    for (const size of [16, 32, 48, 128]) {
      expect(paths).toContain(`icon-${String(size)}.png`);
    }
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('names the icon file that is missing from public/', () => {
    const errors = manifestShipErrors(
      manifest,
      publicFiles.filter((f) => f !== 'icon-48.png'),
      DEFAULT_WEB_ORIGINS,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('icon-48.png');
  });

  it('names the Gather origin the content-script entry fails to reach', () => {
    const narrowed = {
      ...manifest,
      content_scripts: [{ matches: ['https://gather.watch/*'], js: ['content.js'] }],
    };
    const errors = manifestShipErrors(narrowed, publicFiles, DEFAULT_WEB_ORIGINS);
    expect(errors.some((e) => e.includes('http://localhost:3000'))).toBe(true);
    expect(errors.some((e) => e.includes('https://app.gather.watch'))).toBe(true);
  });

  /**
   * The announce is checked against the BUILD's origin list, not the hardcoded
   * defaults: a custom-origins build (GATHER_WEB_ORIGINS=…) replaces the
   * defaults wholesale, and its announce has to reach the origins it will
   * actually allow — the externally_connectable check already uses the same
   * list, and the two gates must not read different ones.
   */
  it('checks the announce against the origins the build actually allows', () => {
    const errors = manifestShipErrors(manifest, publicFiles, [
      'https://gather.watch',
      'https://rooms.example.org',
    ]);
    const announce = errors.filter((e) => e.includes('content_scripts'));
    expect(announce).toHaveLength(1);
    expect(announce[0]).toContain('https://rooms.example.org');
  });

  it('refuses a placeholder version', () => {
    const errors = manifestShipErrors({ ...manifest, version: '0' }, publicFiles, DEFAULT_WEB_ORIGINS);
    expect(errors.some((e) => e.includes('"0"'))).toBe(true);
  });

  /**
   * Chrome caps the manifest description at 132 characters and the Web Store
   * rejects the upload — the last possible moment. The shipped description sat
   * at 165 with nothing checking it; now the build refuses first.
   */
  it('refuses an over-long description, naming its count', () => {
    const long = 'x'.repeat(165);
    const errors = manifestShipErrors({ ...manifest, description: long }, publicFiles, DEFAULT_WEB_ORIGINS);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('165');
    expect(errors[0]).toContain('132');
  });

  it('refuses a missing or empty description', () => {
    for (const description of [undefined, '', '   ']) {
      const broken: Record<string, unknown> = { ...manifest, description };
      if (description === undefined) delete broken['description'];
      const errors = manifestShipErrors(broken, publicFiles, DEFAULT_WEB_ORIGINS);
      expect(errors.some((e) => e.includes('description')), String(description)).toBe(true);
    }
  });

  it('the shipped description is under the cap', () => {
    const description = manifest['description'];
    expect(typeof description).toBe('string');
    expect(String(description).length).toBeLessThanOrEqual(MANIFEST_DESCRIPTION_MAX);
  });

  it('knows a release version from everything else', () => {
    expect(isReleaseVersion('1.0.0')).toBe(true);
    expect(isReleaseVersion('12.3.456')).toBe(true);
    for (const bad of ['0', '1.0', '1.0.0.0', '1.0.0-beta', 'v1.0.0', 0, undefined]) {
      expect(isReleaseVersion(bad), String(bad)).toBe(false);
    }
  });
});

describe('isLoopbackUrl', () => {
  it('is false for a real host, and for anything unparseable', () => {
    expect(isLoopbackUrl('https://api.gather.watch')).toBe(false);
    expect(isLoopbackUrl('localhost:4000')).toBe(false);
  });
});
