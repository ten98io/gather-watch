/**
 * Display labels for contract enums — the same pattern as PeoplePane's
 * STATE_LABEL and room-shell's statusLabel, hoisted here for the enums that
 * more than one pane renders. Raw enum values ('moderator', 'poor') must
 * never reach the screen.
 *
 * THE MEDIA-PATH VOCABULARY DOES NOT LIVE HERE, and that is a decision:
 * where media goes is a LIVE OBSERVATION folded over the mesh's link stats
 * (`CALL_PATH_LABEL` beside `callPathFrom` in components/call/CallSurface —
 * 'Private · direct', 'Relayed · encrypted', 'Connecting…'), never a static
 * claim off `room.relayMode`. The RELAY_LABEL map that used to sit here was
 * exactly that static claim, and the stage wore it beside the rail's live
 * badge until the two disagreed in front of the owner ("am I using TURN or
 * P2P?"). One vocabulary, one source, and it is the one that measures.
 * `room.relayMode` stays on the wire; nothing renders it any more.
 */
import type { MediaRef, MemberRole, UplinkQuality } from '@gather/contracts';
import { providerById } from '@/lib/providers';

export const ROLE_LABEL: Record<MemberRole, string> = {
  host: 'Host',
  moderator: 'Moderator',
  member: 'Member',
  guest: 'Guest',
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
