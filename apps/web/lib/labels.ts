/**
 * Display labels for contract enums — the same pattern as PeoplePane's
 * STATE_LABEL and room-shell's statusLabel, hoisted here for the enums that
 * more than one pane renders. Raw enum values ('moderator', 'cf-sfu', 'poor')
 * must never reach the screen.
 *
 * The relay label is load-bearing copy: the privacy policy promises the room
 * badge always says which mode you are in, and app/billing/success quotes it.
 */
import type { MemberRole, RelayMode, UplinkQuality } from '@playin/contracts';

export const ROLE_LABEL: Record<MemberRole, string> = {
  host: 'Host',
  moderator: 'Moderator',
  member: 'Member',
  guest: 'Guest',
};

/** How the room's media travels — the stage badge (StagePane). */
export const RELAY_LABEL: Record<RelayMode, string> = {
  mesh: 'Private · device-to-device',
  livekit: 'Relayed',
  'cf-sfu': 'Relayed · Theater',
};

/** Same idea, one word, for tight chrome like the call dock's status line. */
export const RELAY_SHORT_LABEL: Record<RelayMode, string> = {
  mesh: 'Private',
  livekit: 'Relayed',
  'cf-sfu': 'Relayed',
};

/** Screen-share quality, in words rather than the raw enum. */
export const UPLINK_LABEL: Record<UplinkQuality, string> = {
  good: 'Good quality',
  degraded: 'Reduced quality',
  poor: 'Low quality',
};
