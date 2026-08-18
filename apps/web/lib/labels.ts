/**
 * Display labels for contract enums — the same pattern as PeoplePane's
 * STATE_LABEL and room-shell's statusLabel, hoisted here for the enums that
 * more than one pane renders. Raw enum values ('moderator', 'cf-sfu', 'poor')
 * must never reach the screen.
 *
 * The relay label is load-bearing copy: the privacy policy promises the room
 * badge always says which mode you are in, so it has to describe where the
 * media ACTUALLY goes. This build has exactly one media path — the
 * device-to-device mesh (CallSurface always joins it, whatever the room says)
 * — so a legacy room still storing 'cf-sfu' meshes too, and its badge must say
 * that rather than claim a relay nothing routes through. Give 'cf-sfu' its own
 * wording again the day a relay actually carries media.
 */
import type { MediaRef, MemberRole, RelayMode, UplinkQuality } from '@gather/contracts';
import { providerById } from '@/lib/providers';

export const ROLE_LABEL: Record<MemberRole, string> = {
  host: 'Host',
  moderator: 'Moderator',
  member: 'Member',
  guest: 'Guest',
};

/** How the room's media travels — the stage badge (StagePane). */
export const RELAY_LABEL: Record<RelayMode, string> = {
  mesh: 'Private · device-to-device',
  'cf-sfu': 'Private · device-to-device',
};

/** Same idea, one word, for tight chrome like the call dock's status line. */
export const RELAY_SHORT_LABEL: Record<RelayMode, string> = {
  mesh: 'Private',
  'cf-sfu': 'Private',
};

/** Human display name for a media source — never render MediaRef.kind raw. */
export function providerLabel(mediaRef: MediaRef): string {
  switch (mediaRef.kind) {
    case 'youtube':
      return 'YouTube';
    case 'soundcloud':
      return 'SoundCloud';
    case 'vimeo':
      return 'Vimeo';
    case 'hls':
      // Said "Library" until the library was deleted. Nothing produces an
      // `hls` ref any more — only rows stored before services/media went —
      // and for those the honest word is what the URL actually is.
      return 'Stream';
    case 'url':
      return 'Direct link';
    case 'embed':
      return providerById(mediaRef.provider)?.name ?? 'Embed';
    case 'page':
      // The row's TITLE already carries the host (parseProviderUrl's
      // titleHint), so the meta line names the tier, not the site again.
      return 'Web page';
  }
}

/** Screen-share quality, in words rather than the raw enum. */
export const UPLINK_LABEL: Record<UplinkQuality, string> = {
  good: 'Good quality',
  degraded: 'Reduced quality',
  poor: 'Low quality',
};
