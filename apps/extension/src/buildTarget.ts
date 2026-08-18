/**
 * BUILD-TIME ONLY — nothing in the extension imports this, and it is in no
 * bundle. It lives under src/ so it is typechecked and linted like everything
 * else; `tsup.config.ts` is its only caller.
 *
 * WHY IT EXISTS. MV3 bundles cannot read env at runtime, so the API origin is
 * INLINED (see src/config.ts). An unset `GATHER_API_URL` used to quietly bake
 * in `http://localhost:4000` and print nothing — and an artifact built that
 * way looks completely healthy: it installs, the web app finds it and reports
 * "extension connected", and then every single call it makes goes to a port
 * on the user's own machine that nothing is listening on. That artifact was
 * shipped. It is the worst failure shape available: silent at build, silent
 * at install, broken only in the user's hands.
 *
 * So the localhost default is no longer a thing that can happen by accident:
 *
 *   - a `dev` build says so, loudly, on stdout AND in `dist/BUILD.txt` AND in
 *     the extension's own name in chrome://extensions;
 *   - a `prod` build REFUSES to run without an https, non-loopback origin —
 *     there is no default to fall back to;
 *   - the web-origin allowlist is validated against the manifest here, at
 *     build time, instead of being trusted to stay a subset by hand.
 */
import { DEFAULT_API_URL, DEFAULT_WEB_ORIGINS, originOfUrl } from './config';

/** Which artifact is being produced. Set by the npm script, not by hand. */
export type BuildMode = 'dev' | 'prod';

/** Copy-pasteable, and the only command that produces a shippable artifact. */
export const PROD_BUILD_COMMAND = [
  'GATHER_API_URL=https://<api-domain> \\',
  '  GATHER_WEB_ORIGINS=https://gather.watch,https://www.gather.watch \\',
  '  pnpm --filter ./apps/extension build:prod',
].join('\n');

/**
 * Hosts that mean "this machine". An artifact pointing at any of them works
 * for exactly one developer and nobody else.
 */
const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1'];

export interface BuildTarget {
  mode: BuildMode;
  /** Inlined as `__GATHER_API_URL__`. Trailing slashes already stripped. */
  apiUrl: string;
  /** Inlined as `__GATHER_WEB_ORIGINS__`; '' keeps config.ts's built-in list. */
  webOrigins: string;
  /** The origins that will really be allowed — after the fallback resolves. */
  effectiveWebOrigins: readonly string[];
  /** True when {@link apiUrl} names this machine. Never shippable. */
  loopback: boolean;
}

/** http(s) URL → the same URL without trailing slashes (config.ts's rule). */
function trimUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Does this URL point at the machine that built it? */
export function isLoopbackUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return LOOPBACK_HOSTS.includes(parsed.hostname.toLowerCase());
}

/**
 * Like config.ts's `parseWebOrigins`, but LOUD. At runtime a malformed entry
 * is dropped so a typo fails closed rather than widening the allowlist; at
 * build time the same typo means the origin the owner intended is missing,
 * and the person who can fix it is standing right here.
 */
export function parseWebOriginsStrict(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const origin = originOfUrl(trimmed);
    if (origin === null) {
      throw new Error(
        `GATHER_WEB_ORIGINS: "${trimmed}" is not an http(s) origin. ` +
          'Give scheme + host (+ port), comma separated, no wildcards — ' +
          'e.g. https://gather.watch,https://www.gather.watch',
      );
    }
    if (!out.includes(origin)) out.push(origin);
  }
  return out;
}

/**
 * The single origin an `externally_connectable` match pattern admits, or null
 * when it admits more than one (any `*` in the scheme or host). A pattern we
 * cannot pin to one origin is treated as covering NOTHING, so the check below
 * can only ever be too strict — never too permissive.
 */
export function manifestPatternOrigin(pattern: string): string | null {
  const withoutPath = pattern.replace(/\/\*$/, '');
  if (withoutPath.includes('*')) return null;
  return originOfUrl(withoutPath);
}

/**
 * Which of `origins` no manifest pattern admits. The manifest is the
 * browser-level gate and the in-code list is the second one, so an in-code
 * origin the manifest does not admit is simply dead — a message from it never
 * reaches the extension at all, and the owner would debug the wrong gate.
 */
export function originsMissingFromManifest(
  origins: readonly string[],
  patterns: readonly string[],
): string[] {
  const covered = new Set(
    patterns.map(manifestPatternOrigin).filter((o): o is string => o !== null),
  );
  return origins.filter((o) => !covered.has(o));
}

/**
 * Resolve what to inline, or throw with the command that fixes it.
 *
 * `env` is passed in rather than read from `process` so this stays pure and
 * the tests can put it in any state they like.
 */
export function resolveBuildTarget(env: Record<string, string | undefined>): BuildTarget {
  const rawMode = (env['GATHER_BUILD'] ?? '').trim();
  if (rawMode !== '' && rawMode !== 'dev' && rawMode !== 'prod') {
    // A near miss ('production', 'PROD') must not silently downgrade the
    // artifact to a localhost dev build — that is the whole defect again.
    throw new Error(
      `GATHER_BUILD must be "dev" or "prod" (got "${rawMode}"). ` +
        'Use the npm scripts: `build` for dev, `build:prod` for the real thing.',
    );
  }
  const mode: BuildMode = rawMode === 'prod' ? 'prod' : 'dev';

  const rawApi = (env['GATHER_API_URL'] ?? '').trim();
  if (rawApi === '' && mode === 'prod') {
    throw new Error(
      'A production build must name the API origin: MV3 inlines it at build ' +
        'time and the bundle can never read it later. There is no default — ' +
        'a localhost artifact installs cleanly and then fails every call.\n\n' +
        `${PROD_BUILD_COMMAND}\n`,
    );
  }
  const apiUrl = rawApi === '' ? DEFAULT_API_URL : trimUrl(rawApi);
  if (originOfUrl(apiUrl) === null) {
    throw new Error(
      `GATHER_API_URL must be an http(s) URL (got "${rawApi}"). ` +
        'Include the scheme — e.g. https://api.gather.watch',
    );
  }
  const loopback = isLoopbackUrl(apiUrl);
  if (mode === 'prod' && loopback) {
    throw new Error(
      `GATHER_API_URL="${apiUrl}" points at the machine that is building it. ` +
        'That artifact announces itself as installed and then fails every ' +
        'call for everyone who loads it.',
    );
  }
  if (mode === 'prod' && !apiUrl.startsWith('https://')) {
    throw new Error(
      `GATHER_API_URL="${apiUrl}" is not https. The room's access token is ` +
        'sent to this origin on every call; a plaintext origin hands it to ' +
        "anyone on the user's network.",
    );
  }

  const parsedOrigins = parseWebOriginsStrict(env['GATHER_WEB_ORIGINS'] ?? '');
  return {
    mode,
    apiUrl,
    // Re-joined from the PARSED list, so what gets inlined is already
    // normalised and config.ts's runtime parse is a formality.
    webOrigins: parsedOrigins.join(','),
    effectiveWebOrigins: parsedOrigins.length > 0 ? parsedOrigins : DEFAULT_WEB_ORIGINS,
    loopback,
  };
}

/**
 * How an artifact describes itself, in three honest states. A build is not
 * "production" because a script was named that — it is production when the
 * checks that make it shippable actually ran.
 */
export function buildLabel(target: BuildTarget): string {
  if (target.mode === 'prod') return 'PRODUCTION BUILD';
  if (target.loopback) return 'DEV BUILD — localhost only, nobody else’s browser can use it';
  // Built by the dev script but pointed somewhere real: the https, loopback
  // and manifest-subset checks did NOT run on it. Saying "dev" would be a lie
  // and saying "production" would be a worse one.
  return 'UNVERIFIED BUILD — dev script, remote origin, none of the prod checks ran';
}

/**
 * What the build prints. Every build says which of the three it is, because
 * the whole defect was an artifact that said nothing at all.
 */
export function formatBuildBanner(target: BuildTarget): string {
  const rule = '─'.repeat(72);
  const lines = [
    rule,
    ` @gather/extension — ${buildLabel(target)}`,
    `   API origin   ${target.apiUrl}${target.loopback ? '   ← this machine only' : ''}`,
    `   Web origins  ${target.effectiveWebOrigins.join(', ')}`,
  ];
  if (target.mode !== 'prod') {
    lines.push(
      '',
      ' The artifact you load into a real browser is built with:',
      '',
      PROD_BUILD_COMMAND,
    );
  }
  lines.push(rule);
  return lines.join('\n');
}

/** The record left in `dist/`, so an artifact on disk can always be identified. */
export function formatBuildInfo(target: BuildTarget, builtAt: string): string {
  const verdict =
    target.mode === 'prod'
      ? 'Production artifact.'
      : target.loopback
        ? 'DEV artifact — it talks to the machine it was built on. Do not ship it.'
        : 'UNVERIFIED artifact — built by the dev script, so the https, loopback ' +
          'and manifest-subset checks never ran. Rebuild with build:prod before shipping.';
  return [
    `mode:        ${target.mode}`,
    `label:       ${buildLabel(target)}`,
    `api:         ${target.apiUrl}`,
    `webOrigins:  ${target.effectiveWebOrigins.join(', ')}`,
    `builtAt:     ${builtAt}`,
    '',
    verdict,
    '',
  ].join('\n');
}

/**
 * The dist manifest, stamped so the artifact identifies itself in the one
 * place the owner is guaranteed to look: chrome://extensions. A dev build
 * carries the marker in its NAME, which is unmissable in a list of extensions;
 * every build records the baked-in origin in `version_name`.
 */
export function stampManifest(
  manifest: Record<string, unknown>,
  target: BuildTarget,
): Record<string, unknown> {
  const version = typeof manifest['version'] === 'string' ? manifest['version'] : '0';
  const name = typeof manifest['name'] === 'string' ? manifest['name'] : 'Gather';
  return {
    ...manifest,
    ...(target.mode === 'prod' ? {} : { name: `${name} (DEV)` }),
    version_name: `${version} — ${target.mode} — ${target.apiUrl}`,
  };
}
