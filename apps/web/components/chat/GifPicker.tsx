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
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search GIFs…"
          aria-label="Search GIFs"
          autoFocus
        />
        <div className="mt-3 grid max-h-80 grid-cols-3 gap-2 overflow-y-auto">
          {loading &&
            Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="aspect-video" />)}
          {!loading &&
            results.map((gif) => (
              <button
                key={gif.id}
                type="button"
                className="overflow-hidden rounded-ctl transition-transform hover:scale-[1.03] focus-visible:ring-2 focus-visible:ring-ring"
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
            <p className="col-span-3 py-8 text-center text-sm text-low">
              No GIFs — the GIF provider may not be configured on this server.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
