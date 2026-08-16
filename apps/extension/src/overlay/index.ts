/**
 * The overlay's front door. The content script imports this and nothing else
 * from `overlay/`.
 *
 * Owns: the public surface — `mountOverlay`, the state pushed to `update()`,
 * and the messages the background is expected to answer.
 *
 * Deliberately NOT: any behaviour of its own. Importing it must stay free of
 * side effects, so there is nothing here but re-exports.
 */

export { mountOverlay } from './mount';
export type { OverlayHandle, OverlayOptions, OverlayStorage } from './mount';

export {
  aheadLine,
  describePeople,
  normalizeRoomState,
  personNote,
  safeOutgoing,
  statusLine,
} from './state';
export type {
  MessageView,
  OverlayConnection,
  OverlayMessage,
  OverlayOutbound,
  OverlayPerson,
  OverlayRoomState,
  OverlaySend,
  PersonView,
  RoomView,
} from './state';

export { clampPoint, defaultPoint, memoryKey, readMemory } from './position';
export type { OverlayMemory, OverlayPoint, Viewport } from './position';
