/**
 * ENABLE_MEDIA_PIPELINE is gone. It was parsed into `AppConfig` and reported
 * by GET /admin/overview as `features.mediaPipeline`, and nothing else ever
 * read it — there is no media pipeline left to enable (`services/media` was
 * deleted). The overview field itself survives as a hardcoded `false` only
 * because the contracts schema still requires it.
 *
 * This is the tombstone for the setting, same shape as config-coturn.test.ts.
 * A parsed-but-unread config key is worse than no key: an operator sets it,
 * and the deploy silently behaves as if it were never there. So the test pins
 * the absence at the config layer — where the key was — rather than trusting
 * a grep for the (nonexistent) reader to stay empty.
 */
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config';

describe('media pipeline config is gone', () => {
  it('exposes no enableMediaPipeline field', () => {
    const config = loadConfig({});
    expect(Object.keys(config)).not.toContain('enableMediaPipeline');
  });

  it('ignores ENABLE_MEDIA_PIPELINE entirely', () => {
    const withFlag = loadConfig({ ENABLE_MEDIA_PIPELINE: 'true' });
    // Not just absent under the old name — the whole config tree is identical
    // to an unset environment, so a rename cannot resurrect the flag without
    // this test noticing.
    expect(withFlag).toEqual(loadConfig({}));
    expect(JSON.stringify(withFlag)).not.toContain('MediaPipeline');
  });
});
