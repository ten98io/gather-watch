/**
 * A write door must never be looser than the door that reads the field back.
 *
 * This class has bitten twice. `UpdateProfileBody.avatarUrl` was
 * `z.string().url()` while `User.avatarUrl` is `WebUrl`, so a guest could
 * PATCH a `data:` URI and make `GET /rooms/:id/members` unparseable for every
 * member of a room they had merely joined. Fixing that one field left the same
 * hole open on `ClientChatSend.gifUrl` against `Message.gifUrl`, which bricked
 * chat history the same way — a per-field fix, when the defect was a class.
 *
 * The asymmetry is what makes it severe: the writer poisons a document that
 * OTHER people's clients then fail to parse, so the blast radius is everyone
 * who reads it rather than the person who wrote it.
 */
import { describe, expect, it } from 'vitest';
import { ClientEvent, QueueItemInput, UnfurlBody, UpdateProfileBody } from '../src/index';

/** Schemes that must never survive a write door. */
const HOSTILE = [
  'javascript:fetch("https://evil.example")',
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox(1)',
  'file:///etc/passwd',
  'blob:https://example.com/abc',
];

function chatSend(gifUrl: string) {
  return {
    type: 'chat.send' as const,
    roomId: '00000000-0000-4000-8000-000000000000',
    seq: 0 as const,
    ts: 1_700_000_000_000,
    payload: {
      kind: 'gif' as const,
      body: 'x',
      gifUrl,
      attachment: null,
      replyTo: null,
      mentions: [],
    },
  };
}

describe('write doors are no looser than the read doors', () => {
  it.each(HOSTILE)('chat.send refuses gifUrl %s', (url) => {
    expect(ClientEvent.safeParse(chatSend(url)).success).toBe(false);
  });

  it('chat.send still accepts a real https gif', () => {
    expect(ClientEvent.safeParse(chatSend('https://media.example/cat.gif')).success).toBe(true);
  });

  it.each(HOSTILE)('profile update refuses avatarUrl %s', (url) => {
    expect(UpdateProfileBody.safeParse({ avatarUrl: url }).success).toBe(false);
  });

  it('profile update still accepts a real image URL, and null', () => {
    expect(UpdateProfileBody.safeParse({ avatarUrl: 'https://cdn.example/a.png' }).success).toBe(
      true,
    );
    expect(UpdateProfileBody.safeParse({ avatarUrl: null }).success).toBe(true);
  });

  it.each(HOSTILE)('queue add refuses artworkUrl %s', (url) => {
    expect(
      QueueItemInput.safeParse({
        mediaRef: { kind: 'youtube', videoId: 'abc123' },
        title: 'x',
        durationMs: null,
        artworkUrl: url,
      }).success,
    ).toBe(false);
  });

  it.each(HOSTILE)('unfurl refuses %s — the SERVER fetches this one', (url) => {
    expect(UnfurlBody.safeParse({ url }).success).toBe(false);
  });
});
