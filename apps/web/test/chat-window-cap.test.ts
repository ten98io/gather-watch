/**
 * The chat window is capped at MAX_MESSAGES, and that cap is a trap for any
 * consumer keyed on `messages.length`.
 *
 * ChatPane's auto-scroll was keyed that way. Past 300 messages the window
 * slides without growing, so the dependency froze at 300 and the effect never
 * ran again: messages kept arriving and rendering while the viewport sat
 * still. Indistinguishable from a dead socket, and immune to every transport
 * fix — the reported symptom was "chat updates are missing".
 *
 * These assert the property that makes a length dependency wrong and a seq
 * dependency right, so the next person keying off this window has a test
 * telling them which one to pick.
 */
import { describe, expect, it } from 'vitest';
import type { Message, MessageId, RoomId, UserId } from '@gather/contracts';
import { MAX_MESSAGES, insertMessage } from '@/lib/room-connection';

function msg(seq: number): Message {
  return {
    id: `m${seq}` as MessageId,
    roomId: 'r1' as RoomId,
    authorId: 'u1' as UserId,
    kind: 'text',
    body: `message ${seq}`,
    gifUrl: null,
    attachment: null,
    replyTo: null,
    mentions: [],
    reactions: {},
    seq,
    createdAt: 1_000 + seq,
    editedAt: null,
    deletedAt: null,
    pinned: false,
  };
}

/** Fill the window to exactly the cap. */
function fullWindow(): Message[] {
  let list: Message[] = [];
  for (let i = 1; i <= MAX_MESSAGES; i += 1) list = insertMessage(list, msg(i));
  return list;
}

describe('the capped chat window', () => {
  it('stops growing at the cap', () => {
    const list = fullWindow();
    expect(list).toHaveLength(MAX_MESSAGES);
    expect(insertMessage(list, msg(MAX_MESSAGES + 1))).toHaveLength(MAX_MESSAGES);
  });

  it('LENGTH IS CONSTANT once capped — never key a live-update effect on it', () => {
    let list = fullWindow();
    const lengths = new Set<number>();
    for (let i = 1; i <= 25; i += 1) {
      list = insertMessage(list, msg(MAX_MESSAGES + i));
      lengths.add(list.length);
    }
    // Twenty-five new messages, one distinct length. A React dependency on
    // this value fires zero times across all of them.
    expect([...lengths]).toEqual([MAX_MESSAGES]);
  });

  it('the newest seq advances on every message, capped or not — key on this instead', () => {
    let list = fullWindow();
    const seqs: number[] = [];
    for (let i = 1; i <= 25; i += 1) {
      list = insertMessage(list, msg(MAX_MESSAGES + i));
      seqs.push(list[list.length - 1]?.seq ?? -1);
    }
    expect(seqs).toEqual(
      Array.from({ length: 25 }, (_, i) => MAX_MESSAGES + i + 1),
    );
    // Strictly increasing, so a dependency on it fires exactly once per message.
    expect(seqs.every((s, i) => i === 0 || s > (seqs[i - 1] ?? 0))).toBe(true);
  });

  it('drops from the OLD end, so the newest message is always last', () => {
    let list = fullWindow();
    list = insertMessage(list, msg(MAX_MESSAGES + 1));
    expect(list[0]?.seq).toBe(2);
    expect(list[list.length - 1]?.seq).toBe(MAX_MESSAGES + 1);
  });
});
