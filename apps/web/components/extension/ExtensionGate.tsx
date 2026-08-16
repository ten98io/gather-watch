'use client';

/**
 * <ExtensionGate> — what the Stage shows when this browser cannot play the
 * room's video yet (docs/WEB_SLIMMING.md, "the install funnel").
 *
 * It owns exactly one thing: the copy and the single action for each reason
 * playback is unavailable — still checking, extension missing, extension too
 * old, or a phone (where extensions do not exist and the answer is the app).
 *
 * What it deliberately does NOT do:
 *   - It does not detect anything. `status` and `platform` arrive as props so
 *     the integrator owns the one detection call and this stays a pure
 *     function of its inputs — renderable, and callable, in a test with no
 *     DOM. Sniffing the user agent in here would also be wrong under SSR,
 *     where the first render has no browser to sniff.
 *   - It does not speak for the rest of the room. Chat, the call, the queue
 *     and presence all work with no extension; this component occupies the
 *     Stage only and says so out loud. Never let it grow copy implying the
 *     room is broken — the whole point is that you can be in here talking to
 *     your friends before you can watch.
 *   - It never renders a spinner. `detecting` is bounded by the caller's
 *     detection timeout, but a caller that stalls must still leave the user
 *     reading a calm sentence rather than watching something spin forever.
 *
 * Copy rule (house): plain language only. Nothing in here may name the
 * protocol, the manifest, a capability string or an error code.
 */
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import {
  ExternalLinkIcon,
  FilmIcon,
  HistoryIcon,
  SearchIcon,
  VideoIcon,
} from '@/components/ui/icons';

/** Why the Stage cannot play yet. The remedy differs for each, so they are
 *  separate states and not one "unavailable". `unsupported-browser` is the one
 *  with no remedy on this device: a desktop browser outside the Chrome family
 *  cannot run the extension at all, so offering an install link there would be
 *  a promise the browser cannot keep. */
export type ExtensionGateStatus =
  | 'detecting'
  | 'not-installed'
  | 'incompatible'
  | 'unsupported-browser';

/** 'mobile' means "a browser that cannot run extensions at all", not "a small
 *  window" — a narrow desktop window is still 'desktop'. */
export type ExtensionGatePlatform = 'desktop' | 'mobile';

export interface ExtensionGateProps {
  status: ExtensionGateStatus;
  platform: ExtensionGatePlatform;
  /**
   * Where the browser extension and the phone app are installed from. Both are
   * required and neither is defaulted: a dead install link is worse than no
   * funnel at all, and `platform` can flip between the server render and
   * hydration, so both destinations have to be in hand either way.
   */
  installUrl: string;
  appUrl: string;
  /** Re-run detection without a reload. Omit when the caller re-checks by
   *  itself; the "check again" control only exists when this is given. */
  onRecheck?: () => void;
  recheckPending?: boolean;
  className?: string;
}

interface GateCopy {
  icon: ReactNode;
  title: string;
  description: string;
  /** null in `detecting`: there is nothing to do yet. */
  actionLabel: string | null;
  actionHref: string;
  /** null wherever re-checking makes no sense (already checking; phones). */
  recheckLabel: string | null;
  reassurance: string;
}

const ROOM_WORKS =
  'Chat, voice and the queue are working already — you can talk to everyone in here while you set this up.';

function copyFor(props: {
  status: ExtensionGateStatus;
  platform: ExtensionGatePlatform;
  installUrl: string;
  appUrl: string;
}): GateCopy {
  // Phones first: no status a phone can report changes the answer, and
  // offering a desktop install there is a promise the browser cannot keep.
  if (props.platform === 'mobile') {
    return {
      icon: <VideoIcon size={20} />,
      title: 'Watch together in the Playin app',
      description:
        'Phone browsers can’t run extensions, so the app is where the video plays. It’s the same room.',
      actionLabel: 'Get the Playin app',
      actionHref: props.appUrl,
      recheckLabel: null,
      reassurance: ROOM_WORKS,
    };
  }

  if (props.status === 'detecting') {
    return {
      icon: <SearchIcon size={20} />,
      title: 'Looking for the Playin extension',
      description: 'This takes a second.',
      actionLabel: null,
      actionHref: props.installUrl,
      recheckLabel: null,
      reassurance: 'Chat, voice and the queue are working already.',
    };
  }

  // No install link: there is nothing this browser could install. Naming the
  // browsers that do work is the only actionable thing left to say, and it is
  // better than a link that leads to a store page refusing to install.
  if (props.status === 'unsupported-browser') {
    return {
      icon: <VideoIcon size={20} />,
      title: 'This browser can’t play the video',
      description:
        'Playin plays video through a browser extension, and this browser doesn’t support them. Chrome, Edge, Brave and Arc all do.',
      actionLabel: null,
      actionHref: props.installUrl,
      recheckLabel: null,
      reassurance: ROOM_WORKS,
    };
  }

  if (props.status === 'incompatible') {
    return {
      icon: <HistoryIcon size={20} />,
      title: 'Update the Playin extension',
      description:
        'The one installed in this browser is older than this room needs. Updating takes a moment.',
      actionLabel: 'Update the extension',
      actionHref: props.installUrl,
      recheckLabel: 'I updated it — check again',
      reassurance: ROOM_WORKS,
    };
  }

  return {
    icon: <FilmIcon size={20} />,
    title: 'Add the Playin extension to watch together',
    description:
      'It plays the video in your own browser and keeps everyone on the same second.',
    actionLabel: 'Add the extension',
    actionHref: props.installUrl,
    recheckLabel: 'I added it — check again',
    reassurance: ROOM_WORKS,
  };
}

/**
 * A real <a> dressed as the primary Button.
 *
 * `Button` renders a <button> and has no `as`/`asChild` escape hatch, and an
 * <a> must never wrap a <button> — that is two focus stops and two
 * announcements for one control. So the primary variant's class list is
 * repeated here; keep it in step with components/ui/button.tsx.
 *
 * It opens in a new tab on purpose: the store is somewhere else, and losing
 * the room to go and install the thing that lets you watch it is the one
 * mistake this whole screen exists to avoid.
 */
function StoreLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'inline-flex select-none items-center justify-center whitespace-nowrap transition-all duration-200 ease-spring',
        'aurora-gradient font-semibold text-accent-ink hover:shadow-glow hover:brightness-110 active:brightness-95',
        'h-11 gap-2 rounded-ctl px-4 text-sm',
      )}
    >
      {children}
      <ExternalLinkIcon size={16} />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

export function ExtensionGate({
  status,
  platform,
  installUrl,
  appUrl,
  onRecheck,
  recheckPending = false,
  className,
}: ExtensionGateProps) {
  const copy = copyFor({ status, platform, installUrl, appUrl });
  const detecting = platform === 'desktop' && status === 'detecting';
  const action =
    copy.actionLabel === null ? null : (
      <StoreLink href={copy.actionHref}>{copy.actionLabel}</StoreLink>
    );
  const showRecheck = copy.recheckLabel !== null && onRecheck !== undefined;

  // "Working on it" is `aria-disabled`, never the native `disabled` attribute:
  // a browser blurs a focused element the instant it becomes disabled, so the
  // keyboard user who just pressed this would be dropped back onto <body> and
  // have to tab the whole room to reach the control again. It therefore stays
  // enabled and focusable, this guard makes the repeat presses no-ops, and the
  // label turning into "Checking…" is announced by the polite live region the
  // control sits inside.
  const handleRecheck = () => {
    if (recheckPending) return;
    onRecheck?.();
  };

  return (
    // Named region, and a polite live region: the state changes on its own
    // (detection finishing, the extension appearing after an install), so the
    // new answer has to be announced without stealing focus.
    <section
      aria-label={copy.title}
      aria-live="polite"
      aria-busy={detecting}
      className={cn(
        'flex h-full w-full flex-col items-center justify-center gap-2 px-6 py-8 text-center',
        className,
      )}
    >
      <EmptyState
        icon={copy.icon}
        title={copy.title}
        description={copy.description}
        {...(action !== null ? { action } : {})}
      />
      {showRecheck && (
        <Button
          variant="ghost"
          size="sm"
          onClick={handleRecheck}
          aria-disabled={recheckPending}
          // Mirrors what `disabled:` would have done to the look, without the
          // attribute that takes focus away. Pointer-events only: it removes
          // the mouse affordance and leaves keyboard focus and Enter intact.
          className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
        >
          {recheckPending ? 'Checking…' : copy.recheckLabel}
        </Button>
      )}
      <p className="max-w-sm text-label text-low">{copy.reassurance}</p>
    </section>
  );
}
