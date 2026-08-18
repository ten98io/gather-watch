/**
 * The coturn REST strategy is gone. `TURN_STATIC_AUTH_SECRET` used to mint
 * time-limited HMAC credentials for an external coturn you ran yourself; the
 * only relay the API knows about now is Cloudflare TURN (CF_TURN_*), with
 * STUN-only as the last resort.
 *
 * This is the tombstone for that setting. A parsed-but-unread config key is
 * worse than no key: `.env.example` documents it, an operator sets it, and
 * the deploy silently behaves as if it were never there. So the test pins the
 * absence at the config layer — where the key was — rather than trusting a
 * grep for the (nonexistent) reader to stay empty.
 */
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config';

describe('coturn config is gone', () => {
  it('exposes no turnStaticAuthSecret field', () => {
    const config = loadConfig({});
    expect(Object.keys(config)).not.toContain('turnStaticAuthSecret');
  });

  it('ignores TURN_STATIC_AUTH_SECRET entirely', () => {
    const secret = 'a-long-random-coturn-shared-secret';
    const withSecret = loadConfig({ TURN_STATIC_AUTH_SECRET: secret });
    // Not just absent under the old name — absent from the whole config tree,
    // so a rename cannot resurrect the strategy without this test noticing.
    expect(JSON.stringify(withSecret)).not.toContain(secret);
    expect(withSecret).toEqual(loadConfig({}));
  });

  it('still parses the Cloudflare TURN settings that replaced it', () => {
    const config = loadConfig({
      CF_TURN_KEY_ID: 'key-id',
      CF_TURN_API_TOKEN: 'api-token',
    });
    expect(config.cloudflare.turnKeyId).toBe('key-id');
    expect(config.cloudflare.turnApiToken).toBe('api-token');
  });
});
