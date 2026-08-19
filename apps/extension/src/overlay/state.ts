/**
 * What the injected room overlay shows, as data — and the plain sentences it
 * says about it.
 *
 * Owns: the state shape the caller pushes in through `update()`, the clamps
 * that make an untrusted string safe to put on a hostile page, the contract of
 * messages the overlay sends to the background, and every user-facing sentence
 * about who is here and how playback is going.
 *
 * Deliberately NOT: any DOM, any chrome.* call, and — importantly — any second
 * vocabulary for sync. The sync sentence comes from driver.ts's
 * {@link syncStatusLabel} and nowhere else, so the overlay, the popup and the
 * web app can never end up describing the same state in two different ways.
 *
 * Everything here is pure, so the wording is unit-testable in node.
 */

import { syncStatusLabel } from '../driver';
import type { ElasticDriverState } from '../driver';

/* ───────────────────────── the state the caller pushes ───────────────────── */

/** How the extension's room connection is doing, in four honest states. */
export type OverlayConnection = 'connecting' | 'live' | 'reconnecting' | 'offline';

export interface OverlayPerson {
  id: string;
  name: string;
  /** This is the local user. */
  you?: boolean;
  /** Their microphone is on. Never rendered as a raw flag. */
  micOn?: boolean;
  /** They are here but not watching right now (tab hidden, connection lost). */
  away?: boolean;
}

export interface OverlayMessage {
  id: string;
  author: string;
  text: string;
  /** Sent by the local user. */
  mine?: boolean;
}

export interface OverlayRoomState {
  connection: OverlayConnection;
  roomName: string | null;
  people: readonly OverlayPerson[];
  messages: readonly OverlayMessage[];
  /** Straight from `ElasticDriver.state()`; only ever read by syncStatusLabel. */
  sync: ElasticDriverState | null;
  /** The title of the row of the room's queue this player is on. Null when the
   *  room is playing something that is not a row of its queue. */
  nowPlaying?: string | null;
  /** The row after it, or null at the end of the queue. */
  upNext?: string | null;
  /** Whether the room's playbackControl policy admits this member. False hides
   *  the skip control; it is not the gate — see background.ts's skipRoomItem. */
  canSkip?: boolean;
  /**
   * Messages that belong to a moment this viewer has not reached yet. Chat is
   * anchored to media time so nothing spoils (docs/EXTENSION_FIRST.md,
   * Consequence A), and holding a message silently would be dishonest — the
   * count is always shown.
   */
  messagesAhead?: number;
  /** False while the room cannot accept a message. Defaults to "live means yes". */
  canSend?: boolean;
}

/* ──────────────────── what the overlay asks the background ───────────────── */

/**
 * Every message the overlay sends. It reaches the background ONLY through the
 * `send` function handed to `mountOverlay`, so this module — and the overlay as
 * a whole — never touches chrome.* and stays testable in node.
 */
export type OverlayOutbound =
  | { kind: 'overlay:state' }
  | { kind: 'overlay:chat'; text: string }
  /** Move the room off the item it is on — the same `sync.advance` the worker
   *  sends when an item runs out of frames. */
  | { kind: 'overlay:skip' }
  | { kind: 'overlay:leave' }
  | { kind: 'overlay:open-app' };

/** Resolves when the background accepted the message; rejects when it did not. */
export type OverlaySend = (message: OverlayOutbound) => Promise<unknown>;

/* ─────────────────────────────── clamps ──────────────────────────────────── */

export const MAX_ROOM_NAME = 60;
/** A queue title is up to 300 characters on the wire and the panel is 320px
 *  wide; past this it is an ellipsis either way, and the clamp says so. */
export const MAX_ITEM_TITLE = 80;
export const MAX_PERSON_NAME = 32;
export const MAX_MESSAGE_TEXT = 1500;
export const MAX_PEOPLE = 60;
export const MAX_MESSAGES = 200;
/** Longest message the composer will send. */
export const MAX_OUTGOING_TEXT = 1000;
/** Names listed before the rest become "and N others". */
const MAX_NAMED = 3;

const C0_END = 0x1f;
const DELETE_CHAR = 0x7f;
const C1_START = 0x80;
const C1_END = 0x9f;
const BIDI_OVERRIDE_START = 0x202a;
const BIDI_OVERRIDE_END = 0x202e;
const BIDI_ISOLATE_START = 0x2066;
const BIDI_ISOLATE_END = 0x2069;
const TAB = 0x09;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;

/**
 * Characters that occupy no space at all. Named one by one, because what a
 * reviewer must be able to check is exactly this list.
 */
const INVISIBLE: ReadonlySet<number> = new Set([
  0x00ad, // soft hyphen
  0x180e, // Mongolian vowel separator
  0x200b, // zero-width space
  0x200c, // zero-width non-joiner
  0x200d, // zero-width joiner
  0x200e, // left-to-right mark
  0x200f, // right-to-left mark
  0x2060, // word joiner
  0xfeff, // zero-width no-break space
]);

/**
 * What a string is FOR, which is what decides how hard it is scrubbed.
 *
 * `name` — anything that stands for somebody or somewhere: a display name, a
 *   room title, an id. It has to be exactly what it looks like.
 * `line` — one line of content, as the user typed it. Their words, minus the
 *   newlines a one-line composer has nowhere to put.
 * `body` — content that arrived from the room, newlines and all.
 */
type TextKind = 'name' | 'line' | 'body';

/**
 * Drop what cannot be seen and should not be trusted.
 *
 * Three families go from everything. Control characters, which are noise at
 * best. The bidirectional overrides and isolates, which are worse than noise: a
 * name padded with one renders right-to-left and can be made to look like
 * somebody else's line — the text would be escaped perfectly and still lie
 * about who said it. And any spelling difference that is only a difference of
 * encoding, which canonical (NFC) composition settles.
 *
 * ── Where the line is drawn on the invisible characters ───────────────────
 * They go from a NAME and stay in a MESSAGE. A name has to be exactly what it
 * looks like: 'A<zero-width space>na' and 'Ana' draw identical pixels, so two
 * people in the list are indistinguishable and no amount of escaping helps. In
 * message text the very same characters do real work — a zero-width joiner is
 * what holds a family emoji together, a zero-width non-joiner is ordinary
 * spelling in Persian — and a message is content, not identity. Names also lose
 * runs of whitespace (the people list collapses them when it draws, so 'A  na'
 * would sit beside 'A na' looking the same) and every exotic space along with
 * them.
 *
 * What is deliberately NOT done: policing scripts. A Cyrillic 'А' looks like a
 * Latin 'A', and a table of look-alikes would turn away real names in Russian,
 * Greek and Serbian to catch a trick whose real answer is identity rather than
 * spelling. Variation selectors stay for the same reason: U+FE0F is what makes
 * an emoji an emoji, and it is not a way to fake a name that U+200B was not.
 *
 * Written as a scan rather than a character class so the code points it drops
 * are named in the source instead of hidden inside an invisible regex.
 */
function scrub(value: string, kind: TextKind): string {
  const name = kind === 'name';
  let out = '';
  for (const ch of value.normalize('NFC')) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === TAB || code === LINE_FEED || code === CARRIAGE_RETURN) {
      out += kind === 'body' ? ch : ' ';
      continue;
    }
    if (code <= C0_END || code === DELETE_CHAR) continue;
    if (code >= C1_START && code <= C1_END) continue;
    if (code >= BIDI_OVERRIDE_START && code <= BIDI_OVERRIDE_END) continue;
    if (code >= BIDI_ISOLATE_START && code <= BIDI_ISOLATE_END) continue;
    if (name && INVISIBLE.has(code)) continue;
    out += ch;
  }
  return name ? out.replace(/\s+/g, ' ') : out;
}

function safeText(value: unknown, max: number, kind: TextKind): string {
  if (typeof value !== 'string') return '';
  const out = scrub(value, kind).trim();
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/** Trim and bound something the user typed, before it goes to the room. */
export function safeOutgoing(value: string): string {
  return safeText(value, MAX_OUTGOING_TEXT, 'line');
}

/* ─────────────────────────── the normalised view ─────────────────────────── */

/** A person with every field decided, so rendering never branches on undefined. */
export interface PersonView {
  id: string;
  name: string;
  you: boolean;
  micOn: boolean;
  away: boolean;
}

export interface MessageView {
  id: string;
  author: string;
  text: string;
  mine: boolean;
}

/** Exactly what the panel renders. Nothing here needs interpreting. */
export interface RoomView {
  connection: OverlayConnection;
  roomTitle: string;
  statusLine: string;
  people: PersonView[];
  messages: MessageView[];
  /** '' when nothing is being held back. */
  aheadLine: string;
  canSend: boolean;
  /** The playing item's title, '' when the room is not on a queued row. */
  nowPlaying: string;
  /** 'Up next: X', '' at the end of the queue and when nothing is playing. */
  upNextLine: string;
  /** Draw the skip control at all. Never true without something to skip. */
  canSkip: boolean;
}

const UNTITLED_ROOM = 'Your room';

export const EMPTY_VIEW: RoomView = {
  connection: 'connecting',
  roomTitle: UNTITLED_ROOM,
  statusLine: 'Connecting to the room…',
  people: [],
  messages: [],
  aheadLine: '',
  canSend: false,
  nowPlaying: '',
  upNextLine: '',
  canSkip: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readConnection(value: unknown): OverlayConnection {
  return value === 'live' || value === 'reconnecting' || value === 'offline' ? value : 'connecting';
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Rebuild the driver's state from whatever arrived. `syncStatusLabel` reads
 * three of these fields and a missing one would quietly become NaN, so they are
 * filled in here rather than trusted.
 */
function readSync(raw: unknown): ElasticDriverState | null {
  if (!isRecord(raw)) return null;
  const profile = raw['profile'];
  return {
    profile: profile === 'listen' || profile === 'strict' ? profile : 'watch',
    anchorOffsetMs: finiteOr(raw['anchorOffsetMs'], 0),
    voiceTightening: raw['voiceTightening'] === true,
    rateControlAvailable: raw['rateControlAvailable'] !== false,
    seekAvailable: raw['seekAvailable'] !== false,
    stalled: raw['stalled'] === true,
    driftMs: finiteOr(raw['driftMs'], 0),
  };
}

/**
 * The room's condition as a person would say it.
 *
 * Only the `live` case has anything to say about playback, and it says it in
 * driver.ts's words — see the module header.
 */
export function statusLine(connection: OverlayConnection, sync: ElasticDriverState | null): string {
  switch (connection) {
    case 'connecting':
      return 'Connecting to the room…';
    case 'reconnecting':
      return 'Reconnecting to the room…';
    case 'offline':
      return 'Not connected';
    case 'live':
      return sync === null ? 'In the room' : syncStatusLabel(sync);
  }
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`;
}

/** "You, Ana and Ben are here" — the sentence the collapsed handle announces. */
export function describePeople(people: readonly PersonView[]): string {
  const youHere = people.some((person) => person.you);
  const others = people.filter((person) => !person.you).map((person) => person.name);
  if (others.length === 0) return youHere ? 'Just you here so far' : 'No one here yet';
  const shown = others.slice(0, MAX_NAMED);
  const hidden = others.length - shown.length;
  const named = youHere ? ['You', ...shown] : [...shown];
  const list =
    hidden > 0
      ? `${named.join(', ')} and ${hidden} ${hidden === 1 ? 'other' : 'others'}`
      : joinNames(named);
  return `${list} ${named.length === 1 && hidden === 0 ? 'is' : 'are'} here`;
}

/** The little tag after a name. '' when there is nothing worth saying. */
export function personNote(person: PersonView): string {
  if (person.away) return 'away';
  if (person.micOn) return 'mic on';
  return '';
}

/**
 * The row after the playing one, as a sentence. '' when there is no next row,
 * because "Up next: nothing" is a line that says less than no line at all —
 * the end of a queue is not news until the item actually ends.
 */
export function upNextLine(title: string): string {
  return title.length > 0 ? `Up next: ${title}` : '';
}

/** Never silently withhold: say how many messages are waiting, in words. */
export function aheadLine(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '';
  const n = Math.min(Math.floor(count), 999);
  return n === 1
    ? 'One message is waiting until you reach that moment.'
    : `${n} messages are waiting until you reach those moments.`;
}

/**
 * Scrubbing alone does NOT stop impersonation — it completes it. Dropping the
 * zero-width characters maps 'A<U+200B>na' onto 'Ana', so the impostor renders
 * byte-identical to the person they are copying instead of merely similar.
 *
 * Normalising is still right (it is what makes the collision detectable at
 * all); the missing half is saying so. When two people in the room resolve to
 * the same visible name, BOTH are marked — marking only the newcomer would
 * tell you which is which only if you already knew.
 *
 * The mark is a short piece of their own id: stable across renders, already
 * known to everyone in the room, and not something the impostor can choose.
 */
function disambiguate(people: PersonView[]): PersonView[] {
  const counts = new Map<string, number>();
  for (const person of people) counts.set(person.name, (counts.get(person.name) ?? 0) + 1);
  return people.map((person) =>
    (counts.get(person.name) ?? 0) > 1
      ? { ...person, name: `${person.name} (${person.id.slice(-4)})` }
      : person,
  );
}

function readPeople(raw: unknown): PersonView[] {
  if (!Array.isArray(raw)) return [];
  const out: PersonView[] = [];
  for (const entry of raw.slice(0, MAX_PEOPLE)) {
    if (!isRecord(entry)) continue;
    const id = safeText(entry['id'], 64, 'name');
    if (id.length === 0) continue;
    const name = safeText(entry['name'], MAX_PERSON_NAME, 'name');
    out.push({
      id,
      name: name.length > 0 ? name : 'Someone',
      you: entry['you'] === true,
      micOn: entry['micOn'] === true,
      away: entry['away'] === true,
    });
  }
  return disambiguate(out);
}

function readMessages(raw: unknown): MessageView[] {
  if (!Array.isArray(raw)) return [];
  const out: MessageView[] = [];
  // The tail is what a person is reading; an unbounded backlog is only memory.
  for (const entry of raw.slice(-MAX_MESSAGES)) {
    if (!isRecord(entry)) continue;
    const id = safeText(entry['id'], 64, 'name');
    const text = safeText(entry['text'], MAX_MESSAGE_TEXT, 'body');
    if (id.length === 0 || text.length === 0) continue;
    const author = safeText(entry['author'], MAX_PERSON_NAME, 'name');
    out.push({
      id,
      author: author.length > 0 ? author : 'Someone',
      text,
      mine: entry['mine'] === true,
    });
  }
  return out;
}

/**
 * Turn anything at all into something renderable.
 *
 * The typed parameter is for the caller's benefit; the validation is for ours.
 * Names and message text come from other people over the network and land on a
 * page that is hostile by assumption, so every string is clamped here and the
 * renderer only ever assigns `textContent`.
 */
export function normalizeRoomState(raw: unknown): RoomView {
  if (!isRecord(raw)) return EMPTY_VIEW;
  const connection = readConnection(raw['connection']);
  const roomName = safeText(raw['roomName'], MAX_ROOM_NAME, 'name');
  // A queue title was typed by whoever added the row, so it is scrubbed as a
  // NAME: it stands for something, it is drawn on one line, and an invisible
  // character in it buys nothing but a title that is not what it looks like.
  const nowPlaying = safeText(raw['nowPlaying'], MAX_ITEM_TITLE, 'name');
  return {
    connection,
    roomTitle: roomName.length > 0 ? roomName : UNTITLED_ROOM,
    statusLine: statusLine(connection, readSync(raw['sync'])),
    people: readPeople(raw['people']),
    messages: readMessages(raw['messages']),
    aheadLine: aheadLine(finiteOr(raw['messagesAhead'], 0)),
    canSend: typeof raw['canSend'] === 'boolean' ? raw['canSend'] : connection === 'live',
    nowPlaying,
    // Both hang off the playing row: there is no "next" without a "now", and a
    // skip with nothing to skip is a control that can only fail.
    upNextLine:
      nowPlaying.length > 0 ? upNextLine(safeText(raw['upNext'], MAX_ITEM_TITLE, 'name')) : '',
    canSkip: nowPlaying.length > 0 && raw['canSkip'] === true,
  };
}
