/**
 * The bucket-clear CLI's XML parsing, which is the part that decides what gets
 * deleted and when to stop.
 *
 * A list that under-reports keys leaks storage; one that mis-reads the
 * truncation flag stops early and leaves most of the bucket behind, silently
 * reporting success. Neither is visible without a real bucket, so the parse is
 * pinned here.
 */
import { describe, expect, it } from 'vitest';
import { parseListPage } from '../src/cli/clear-bucket';

const page = (body: string, truncated: boolean, token?: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>ams</Name>
  <IsTruncated>${truncated}</IsTruncated>
  ${token === undefined ? '' : `<NextContinuationToken>${token}</NextContinuationToken>`}
  ${body}
</ListBucketResult>`;

const contents = (...keys: string[]): string =>
  keys.map((k) => `<Contents><Key>${k}</Key><Size>1</Size></Contents>`).join('\n');

describe('parseListPage', () => {
  it('reads every key on the page', () => {
    const xml = page(contents('chat/r1/a1/one.png', 'chat/r1/a2/two.jpg'), false);
    expect(parseListPage(xml).keys).toEqual(['chat/r1/a1/one.png', 'chat/r1/a2/two.jpg']);
  });

  it('stops when the listing is complete', () => {
    expect(parseListPage(page(contents('a'), false)).nextToken).toBeNull();
  });

  it('follows the continuation token when truncated — otherwise most of the bucket survives', () => {
    expect(parseListPage(page(contents('a'), true, 'tok-2')).nextToken).toBe('tok-2');
  });

  it('does not continue on a truncated page with no token, rather than looping forever', () => {
    expect(parseListPage(page(contents('a'), true)).nextToken).toBeNull();
  });

  it('handles an empty bucket', () => {
    const parsed = parseListPage(page('', false));
    expect(parsed.keys).toEqual([]);
    expect(parsed.nextToken).toBeNull();
  });

  it('unescapes XML entities in a key', () => {
    // A filename with & or < is legal in S3 and arrives escaped; deleting the
    // escaped form would 404 and silently leave the real object behind.
    const parsed = parseListPage(page(contents('chat/r1/a1/a&amp;b&lt;c&gt;.png'), false));
    expect(parsed.keys).toEqual(['chat/r1/a1/a&b<c>.png']);
  });
});
