'use client';

import { useEffect } from 'react';

export interface ShortcutBinding {
  /** KeyboardEvent.key value (' ', '?', 'ArrowLeft', 'c', 'm', …). */
  key: string;
  /** Run even when focus is inside an input/textarea/contenteditable. */
  allowInFields?: boolean;
  handler(event: KeyboardEvent): void;
}

/**
 * Room keyboard map (DESIGN.md §9): space play/pause, ←/→ seek 10 s,
 * C captions, M mute, "?" shortcut sheet. Bindings are ignored while typing
 * unless `allowInFields` is set.
 */
export function useKeyboardShortcuts(bindings: ShortcutBinding[]): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const inField =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);
      for (const binding of bindings) {
        if (binding.key !== event.key) continue;
        if (inField && binding.allowInFields !== true) continue;
        event.preventDefault();
        binding.handler(event);
        return;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [bindings]);
}
