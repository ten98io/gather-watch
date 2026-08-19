'use client';

import { useEffect } from 'react';

export interface ShortcutBinding {
  /** KeyboardEvent.key value (' ', '?', 'ArrowLeft', 'c', 'm', …). */
  key: string;
  /** Run even when focus is inside an input/textarea/contenteditable. */
  allowInFields?: boolean;
  /**
   * Run even while Ctrl/Cmd/Alt is held. Off by default, and the default is
   * the point: a chord belongs to the browser or the OS, not to the room.
   */
  allowModifiers?: boolean;
  handler(event: KeyboardEvent): void;
}

/**
 * Keys a focused control answers BY ITSELF. Space is a focused button's press
 * and Enter is a link's follow, so a room binding that took them would leave
 * every control the tab order reaches unpressable — which is exactly what the
 * ' ' → play/pause binding did to the send button, the tabs and the queue rows.
 */
const ACTIVATION_KEYS = new Set([' ', 'Enter']);

/** Does this element act on ACTIVATION_KEYS without any help from us? */
function selfActivating(el: HTMLElement): boolean {
  return (
    el.tagName === 'BUTTON' ||
    el.tagName === 'A' ||
    el.tagName === 'SUMMARY' ||
    el.getAttribute('role') === 'button'
  );
}

/**
 * Room keyboard map (DESIGN.md §9): space play/pause, ←/→ seek 10 s,
 * C captions, M mute, F fullscreen, "?" shortcut sheet.
 *
 * A BINDING MATCHES A BARE KEY, AND THAT IS A CONSTRAINT, NOT A DETAIL. This
 * matched `event.key` alone and then called `preventDefault()`, so inside a
 * room every chord ending in a bound letter was swallowed: Cmd/Ctrl+C toggled
 * captions and never copied, Cmd+R never reloaded, Ctrl+F never opened find.
 * Ctrl/Cmd/Alt must therefore be UP unless the binding opts in with
 * `allowModifiers`.
 *
 * Shift is deliberately NOT in that set: '?' is Shift+/ on most layouts, so a
 * guard that refused every shifted key would drop the map's own sheet.
 *
 * Bindings are also ignored while typing (unless `allowInFields`) and may
 * never take a key the focused control answers itself.
 */
export function useKeyboardShortcuts(bindings: ShortcutBinding[]): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const el = target instanceof HTMLElement ? target : null;
      // Whatever has focus owns its own activation keys, before any binding is
      // even considered.
      if (ACTIVATION_KEYS.has(event.key) && el !== null && selfActivating(el)) return;
      const inField =
        el !== null &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT' ||
          el.isContentEditable);
      const chord = event.ctrlKey || event.metaKey || event.altKey;
      for (const binding of bindings) {
        if (binding.key !== event.key) continue;
        if (chord && binding.allowModifiers !== true) continue;
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
