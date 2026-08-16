/**
 * Tenor GIF search behind a defensive mapper. When TENOR_API_KEY is not
 * configured the route still answers 200 with an empty list plus a `notice`
 * (a deliberate soft-degrade, not an error). Upstream JSON is unknown-typed
 * and mapped field-by-field; malformed entries are skipped, never trusted.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { SearchGifsResponse } from '@gather/contracts';
import { AppError } from '../../lib/errors';
import type { AppConfig } from '../../config';

export interface GifSearchResult {
  results: SearchGifsResponse['results'];
  notice: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

export async function searchGifs(
  args: { config: AppConfig; log: FastifyBaseLogger; fetchImpl?: typeof fetch },
  q: string,
  limit: number,
): Promise<GifSearchResult> {
  const { config } = args;
  const fetchImpl = args.fetchImpl ?? globalThis.fetch;

  if (config.tenorApiKey === null) {
    return {
      results: [],
      notice: 'gif search is disabled: TENOR_API_KEY is not configured',
    };
  }

  const url =
    `https://tenor.googleapis.com/v2/search?key=${encodeURIComponent(config.tenorApiKey)}` +
    `&q=${encodeURIComponent(q)}&limit=${limit}&media_filter=gif,tinygif`;
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new AppError('INTERNAL', 'gif search upstream failed');
  }

  const data: unknown = await response.json();
  const list = asRecord(data)?.results;
  const results: SearchGifsResponse['results'] = [];
  if (Array.isArray(list)) {
    for (const item of list) {
      const entry = asRecord(item);
      if (entry === null) {
        continue;
      }
      const media = asRecord(entry.media_formats);
      const gif = asRecord(media?.gif);
      const tinygif = asRecord(media?.tinygif);
      const gifUrl = typeof gif?.url === 'string' ? gif.url : null;
      if (gifUrl === null) {
        continue;
      }
      const dims = Array.isArray(gif?.dims) ? gif.dims : [];
      const width = positiveInt(dims[0]);
      const height = positiveInt(dims[1]);
      if (width === null || height === null) {
        continue;
      }
      results.push({
        id: String(entry.id),
        url: gifUrl,
        previewUrl: typeof tinygif?.url === 'string' ? tinygif.url : gifUrl,
        width,
        height,
        title: typeof entry.content_description === 'string' ? entry.content_description : null,
      });
    }
  }

  return { results, notice: null };
}
