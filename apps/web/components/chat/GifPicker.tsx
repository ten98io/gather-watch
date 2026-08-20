'use client';

/**
 * GifPicker — GIF search (Tenor via the API's /gifs/search proxy; server
 * returns an honest empty result set when no key is configured). Picked GIFs
 * send as kind:'gif' messages.
 */
import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';

interface GifResult {
  id: string;
  url: string;
  previewUrl: string;
  width: number;
  height: number;
  title: string | null;
}

export function GifPicker({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onPick(gif: GifResult): void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GifResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    const handle = setTimeout(
      () => {
        setLoading(true);
        api.gifs
          .search({ q: q.length > 0 ? q : 'trending', limit: 24 })
          .then((res) => {
            setResults(res.results);
            setSearched(true);
          })
          .catch(() => {
            setResults([]);
            setSearched(true);
          })
          .finally(() => setLoading(false));
      },
      q.length > 0 ? 350 : 0,
    );
    return () => clearTimeout(handle);
  }, [query, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-label="Pick a GIF" className="max-w-lg">
        <DialogTitle>Send a GIF</DialogTitle>
        <p className="mt-1 text-label text-low">
          {query.trim().length > 0 ? `Results for “${query.trim()}”` : 'Trending right now'}
        </p>
        <div className="mt-4">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search GIFs…"
            aria-label="Search GIFs"
            autoFocus
          />
        </div>
        <div className="mt-3 grid max-h-80 grid-cols-3 gap-2 overflow-y-auto">
          {loading &&
            Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="aspect-video" />)}
          {!loading &&
            results.map((gif) => (
              <button
                key={gif.id}
                type="button"
                /* A colour change, not a transform. `hover:scale-*` on a tile in
                   a tight grid pushes it under its neighbours and re-rasterises
                   the image every frame; a ring says "this one" without moving
                   anything. The accent is a ring here, which is the one thing
                   it is allowed to be on both themes (DESIGN.md §2). */
                className="overflow-hidden rounded-card ring-1 ring-hairline transition-colors duration-150 hover:ring-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => {
                  onPick(gif);
                  onOpenChange(false);
                }}
              >
                <img
                  src={gif.previewUrl}
                  alt={gif.title ?? 'GIF'}
                  className="aspect-video w-full object-cover"
                  loading="lazy"
                />
              </button>
            ))}
          {!loading && searched && results.length === 0 && (
            <div className="col-span-3 flex flex-col items-center gap-2 py-12 text-center">
              <p className="text-title text-hi">No GIFs found</p>
              <p className="max-w-xs text-label text-low">
                Try another search. If that doesn’t work, GIF search may not be set up on this
                server.
              </p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
