/**
 * Provider registry — re-exported from @gather/contracts, the ONE copy shared
 * with the web app (packages/contracts/src/providers.ts). Only the URL-parsing
 * wrappers live here: contracts is environment-free and matches hostnames, so
 * turning a tab URL into a hostname is this module's whole job.
 *
 * Unknown hosts still classify as 'generic' and remain fully drivable —
 * Mode A is player-agnostic. Pure — unit-tested in node.
 */
import { UNKNOWN, providerForHost } from '@gather/contracts';
import type { CastCapability, TabProvider } from '@gather/contracts';

export {
  GENERIC_CAST,
  PROVIDERS,
  UNKNOWN,
  providerById,
  providerForHost,
  providerGrantPatterns,
  tierFor,
} from '@gather/contracts';
export type {
  CastCapability,
  Provider,
  ProviderCapability,
  TabProvider,
  TabProviderTier,
} from '@gather/contracts';

/** Classify a tab URL. Generic pages still work — any <video>/<audio> on the
 *  page is driven (Mode A sync is player-agnostic). */
export function providerForUrl(url: string): TabProvider {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return UNKNOWN;
  }
  return providerForHost(host);
}

/** Cast capability for a tab URL (popup + content script share this). */
export function castCapabilityFor(url: string): CastCapability {
  return providerForUrl(url).cast;
}
