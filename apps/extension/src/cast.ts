/**
 * Native cast driving (docs/EXTENSION_FIRST.md, Part 3).
 *
 * Playin never captures, mirrors or re-encodes a protected surface — output
 * protection blacks it out by design, and doing it would be a licence
 * violation regardless. The one honest route to a TV is to press the site's
 * OWN cast control, so casting happens inside the site's DRM-legal session.
 *
 * The per-site descriptor lives in the provider registry (`CastCapability`);
 * this module is the sequencing, kept pure by taking its DOM through
 * `CastDeps`. Adding a site is data, not code.
 */
import type { CastCapability, TabProvider } from './providers';

/** A clickable the content script found (usually an HTMLElement). */
export interface CastTarget {
  visible: boolean;
  click(): void;
}

export interface CastDeps {
  /** Deep query: pierces open shadow roots. First match or null. */
  query(selector: string): CastTarget | null;
  /** Await a UI transition (menus animate open). */
  wait(ms: number): Promise<void>;
}

export interface CastResult {
  clicked: boolean;
  /** Selector that was pressed, for logs/telemetry. */
  selector: string | null;
  /** Plain language, always populated — the UI shows this verbatim. */
  reason: string;
}

/** How long to let an overflow menu animate open before re-looking. */
export const REVEAL_DELAY_MS = 250;

function findVisible(deps: CastDeps, selectors: readonly string[]): { el: CastTarget; selector: string } | null {
  for (const selector of selectors) {
    const el = deps.query(selector);
    if (el !== null && el.visible) return { el, selector };
  }
  return null;
}

/**
 * Press the site's own cast button on the user's behalf.
 *
 * Note on user activation: Chrome requires a user gesture for the Remote
 * Playback prompt, and this click originates from the extension, not from the
 * page. Sites that call `RemotePlayback.prompt()` synchronously in their
 * handler may refuse — which surfaces as an honest "nothing happened", never
 * as a fallback to capture.
 */
export async function performNativeCast(
  capability: CastCapability,
  deps: CastDeps,
  siteName = 'This site',
): Promise<CastResult> {
  if (!capability.native) {
    return { clicked: false, selector: null, reason: capability.reason };
  }

  const direct = findVisible(deps, capability.buttons);
  if (direct !== null) {
    direct.el.click();
    return { clicked: true, selector: direct.selector, reason: `Opened ${siteName}'s cast picker.` };
  }

  for (const selector of capability.reveal) {
    const opener = deps.query(selector);
    if (opener === null || !opener.visible) continue;
    opener.click();
    await deps.wait(REVEAL_DELAY_MS);
    const revealed = findVisible(deps, capability.buttons);
    if (revealed !== null) {
      revealed.el.click();
      return { clicked: true, selector: revealed.selector, reason: `Opened ${siteName}'s cast picker.` };
    }
  }

  return {
    clicked: false,
    selector: null,
    reason: `Couldn't find ${siteName}'s cast control on this page — start playback first, or cast from the site's own player.`,
  };
}

/** What the popup shows before anything is clicked. */
export interface CastAffordance {
  /** The button is pressable (never hidden — an honest reason beats a
   *  vanishing control, see EXTENSION_FIRST.md Part 3). */
  enabled: boolean;
  label: string;
  reason: string;
}

export function castAffordanceFor(provider: TabProvider | null): CastAffordance {
  // `provider` crosses the message boundary, where an older bundle may have
  // sent a shape without `cast` at all.
  const cast: CastCapability | undefined = provider?.cast;
  if (provider === undefined || provider === null || cast === undefined) {
    return { enabled: false, label: 'Cast', reason: 'Open a site with a player first.' };
  }
  if (cast.native) {
    return { enabled: true, label: `Cast from ${provider.name}`, reason: '' };
  }
  return { enabled: false, label: 'Cast', reason: cast.reason };
}
