import { beforeEach, describe, expect, it } from 'vitest';

import { mountOverlay } from '../src/overlay/mount';
import type { OverlayHandle, OverlayStorage } from '../src/overlay/mount';
import { EDGE_MARGIN, PANEL_WIDTH } from '../src/overlay/position';
import type { OverlayMessage, OverlayOutbound, OverlayRoomState } from '../src/overlay/state';
import {
  FakeDocument,
  FakeElement,
  FakeEvent,
  FakeShadowRoot,
  FakeText,
  allElements,
  byClass,
  dispatchOn,
  oneByClass,
  pageElements,
} from './fakeDom';
import type { EventProps } from './fakeDom';

/**
 * The overlay is exercised the way a page would meet it: mounted into a
 * document nobody trusts, driven by clicks and keys, then destroyed — with the
 * page watching the whole time to see what leaked out of it.
 */

const VIEWPORT = { width: 1280, height: 720 };

interface Harness {
  doc: FakeDocument;
  host: FakeElement;
  overlay: OverlayHandle;
  sent: OverlayOutbound[];
  store: Map<string, unknown>;
  writes: number;
  /** Keys the page heard as they bubbled back up. */
  pageKeys: string[];
  /** Keys the page heard on the way DOWN — where a player listens to win. */
  pageCaptureKeys: string[];
  /** Listeners the PAGE had before the overlay arrived. */
  pageListeners: number;
}

let failNextSend = false;
let snapshot: unknown = undefined;

function room(over: Partial<OverlayRoomState> = {}): OverlayRoomState {
  return {
    connection: 'live',
    roomName: 'Movie night',
    people: [],
    messages: [],
    sync: null,
    ...over,
  };
}

function said(id: string, text = id): OverlayMessage {
  return { id, author: 'Ana', text };
}

interface MountInput {
  initialState?: OverlayRoomState;
  store?: Map<string, unknown>;
  hostname?: string;
  withStorage?: boolean;
  /** False for a browser too old to have a top layer to ask for. */
  popover?: boolean;
}

function mount(input: MountInput = {}): Harness {
  const doc = new FakeDocument(input.hostname ?? 'example.com', VIEWPORT.width, VIEWPORT.height);
  doc.popoverSupport = input.popover !== false;
  const sent: OverlayOutbound[] = [];
  const store = input.store ?? new Map<string, unknown>();
  const harness: Harness = {
    doc,
    host: doc.body,
    overlay: { update: () => undefined, destroy: () => undefined },
    sent,
    store,
    writes: 0,
    pageKeys: [],
    pageCaptureKeys: [],
    pageListeners: 0,
  };

  // The page's own hotkey handlers, registered before the overlay exists and in
  // both phases — a player that means to win listens on the way down.
  doc.addEventListener('keydown', (ev: FakeEvent) => harness.pageKeys.push(ev.key));
  doc.addEventListener('keydown', (ev: FakeEvent) => harness.pageCaptureKeys.push(ev.key), true);
  harness.pageListeners = doc.listenerCount();

  const storage: OverlayStorage = {
    read: (key) => Promise.resolve(store.get(key)),
    write: (key, value) => {
      store.set(key, value);
      harness.writes += 1;
      return Promise.resolve();
    },
  };

  harness.overlay = mountOverlay({
    document: doc as unknown as Document,
    send: (message) => {
      sent.push(message);
      if (failNextSend) return Promise.reject(new Error('room refused'));
      if (message.kind === 'overlay:state') return Promise.resolve(snapshot);
      return Promise.resolve(undefined);
    },
    ...(input.initialState === undefined ? {} : { initialState: input.initialState }),
    ...(input.withStorage === false ? {} : { storage }),
  });

  const host = doc.body.childNodes[0];
  if (!(host instanceof FakeElement)) throw new Error('the overlay mounted nothing');
  harness.host = host;
  return harness;
}

/** Let the promises the overlay started settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Only a test may look inside a closed root; the page cannot. */
function shadowOf(host: FakeElement): FakeShadowRoot {
  const shadow = host.peekShadow();
  if (shadow === null) throw new Error('no shadow root');
  return shadow;
}

/** A click the way a browser makes one: hit-test to a control, then dispatch. */
function click(host: FakeElement, control: FakeElement, props: EventProps = {}): FakeEvent {
  shadowOf(host).hitTarget = control;
  return dispatchOn(control, 'click', { clientX: 500, clientY: 200, ...props });
}

/** The same control, worked from the keyboard: focus, and no pointer at all. */
function keyActivate(host: FakeElement, control: FakeElement): FakeEvent {
  shadowOf(host).hitTarget = null;
  control.focus();
  return dispatchOn(control, 'click', { detail: 0 });
}

/** Press a key at a control, which first has to have focus to receive one. */
function typeKey(control: FakeElement, props: EventProps): FakeEvent {
  control.focus();
  return dispatchOn(control, 'keydown', props);
}

/** Put the pointer down on a control, hit test and all. */
function pressOn(host: FakeElement, control: FakeElement, props: EventProps): FakeEvent {
  shadowOf(host).hitTarget = control;
  return dispatchOn(control, 'pointerdown', props);
}

beforeEach(() => {
  failNextSend = false;
  snapshot = undefined;
});

describe('mountOverlay — isolation from the page', () => {
  it('adds one anonymous host and keeps its shadow root closed', () => {
    const { doc, host } = mount({ initialState: room() });

    expect(doc.body.childNodes).toHaveLength(1);
    expect(host.tagName).toBe('DIV');
    // A page that cannot reach the root cannot read or restyle a single node.
    expect(host.shadowRoot).toBeNull();
    expect(shadowOf(host).mode).toBe('closed');
    // No name is a selector the page can aim at.
    expect(host.className).toBe('');
    expect(host.getAttribute('id')).toBeNull();
    expect(byClass(host, 'panel')).toHaveLength(1);
  });

  it('cannot shift the page or swallow a click meant for it', () => {
    const { host } = mount({ initialState: room() });

    expect(host.style.getPropertyValue('position')).toBe('fixed');
    expect(host.style.getPropertyValue('pointer-events')).toBe('none');
    // `:host` rules lose to the page's own rules on the host element, so the
    // properties that decide "visible, where, and does it steal clicks" are the
    // one place inline !important is right.
    for (const property of ['position', 'pointer-events', 'z-index', 'display', 'visibility']) {
      expect(host.style.getPropertyPriority(property)).toBe('important');
    }
    // Only two edges are the position; the other two must stay unset or the
    // box is stretched between them.
    expect(host.style.getPropertyValue('right')).toBe('auto');
    expect(host.style.getPropertyValue('bottom')).toBe('auto');
  });

  it('puts its stylesheet inside the shadow root and nowhere else', () => {
    const { doc, host } = mount({ initialState: room() });

    // Nothing the page can reach is a stylesheet of ours.
    const styles = pageElements(doc.documentElement).filter((el) => el.tagName === 'STYLE');
    expect(styles).toHaveLength(0);
    const shadow = shadowOf(host);
    const inside = shadow.childNodes.filter(
      (node) => node instanceof FakeElement && node.tagName === 'STYLE',
    );
    expect(inside).toHaveLength(1);
  });

  it('starts in the top-right corner, clear of the player controls', () => {
    const { host } = mount({ initialState: room() });

    expect(host.style.getPropertyValue('top')).toBe(`${EDGE_MARGIN}px`);
    expect(host.style.getPropertyValue('left')).toBe(
      `${VIEWPORT.width - PANEL_WIDTH - EDGE_MARGIN}px`,
    );
  });

  it('never takes focus from the page just by arriving', async () => {
    const { doc, store } = mount({ store: new Map([['gather.overlay.v1:example.com', { x: 40, y: 60, collapsed: true }]]) });
    expect(doc.activeElement).toBeNull();
    await flush();
    expect(doc.activeElement).toBeNull();
    expect(store.size).toBe(1);
  });
});

describe('mountOverlay — chat', () => {
  it('renders a hostile message as text and builds no markup from it', () => {
    const nasty = '<img src=x onerror="alert(1)">';
    const { host } = mount({
      initialState: room({
        messages: [{ id: 'm1', author: '<b>Ana</b>', text: nasty }],
      }),
    });

    const text = oneByClass(host, 'msg-text');
    expect(text.textContent).toBe(nasty);
    // One text node, no elements: the string was never parsed as anything.
    expect(text.childNodes).toHaveLength(1);
    expect(text.childNodes[0]).toBeInstanceOf(FakeText);
    expect(allElements(host).some((el) => el.tagName === 'IMG' || el.tagName === 'B')).toBe(false);
    expect(oneByClass(host, 'msg-author').textContent).toBe('<b>Ana</b>');
  });

  it('sends what was typed on Enter and clears the box', () => {
    const { host, sent } = mount({ initialState: room() });
    const input = oneByClass(host, 'input');

    input.value = '  hello everyone  ';
    typeKey(input, { key: 'Enter' });

    expect(sent).toContainEqual({ kind: 'overlay:chat', text: 'hello everyone' });
    expect(input.value).toBe('');
  });

  it('leaves Enter to the input method while a word is still being chosen', () => {
    const { host, sent } = mount({ initialState: room() });
    const input = oneByClass(host, 'input');
    const chats = (): OverlayOutbound[] => sent.filter((m) => m.kind === 'overlay:chat');

    // Enter here picks the characters being composed. It is not "send".
    input.value = 'にほんご';
    typeKey(input, { key: 'Enter', isComposing: true });
    expect(chats()).toHaveLength(0);
    expect(input.value).toBe('にほんご');

    // The same fact from a browser that only sets the old keyCode.
    typeKey(input, { key: 'Enter', keyCode: 229 });
    expect(chats()).toHaveLength(0);
    expect(input.value).toBe('にほんご');

    // And the Enter that really does end the sentence still sends it.
    typeKey(input, { key: 'Enter' });
    expect(sent).toContainEqual({ kind: 'overlay:chat', text: 'にほんご' });
    expect(input.value).toBe('');
  });

  it('gives a failed message back with a plain line, losing nothing', async () => {
    failNextSend = true;
    const { host } = mount({ initialState: room() });
    const input = oneByClass(host, 'input');

    input.value = 'did this send?';
    typeKey(input, { key: 'Enter' });
    await flush();

    expect(input.value).toBe('did this send?');
    const notice = oneByClass(host, 'notice');
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toBe('That message did not send. Try again.');
    expect(input.disabled).toBe(false);
  });

  it('will not let you type into a room that cannot take it', () => {
    const { host, sent } = mount({ initialState: room({ connection: 'offline' }) });
    const input = oneByClass(host, 'input');

    expect(input.disabled).toBe(true);
    expect(oneByClass(host, 'send').disabled).toBe(true);
    expect(oneByClass(host, 'status').textContent).toBe('Not connected');
    expect(sent.filter((m) => m.kind === 'overlay:chat')).toHaveLength(0);
  });

  it('appends new messages instead of rebuilding the ones already read', () => {
    const { host, overlay } = mount({
      initialState: room({ messages: [{ id: 'm1', author: 'Ana', text: 'one' }] }),
    });
    const first = byClass(host, 'msg')[0];

    overlay.update(
      room({
        messages: [
          { id: 'm1', author: 'Ana', text: 'one' },
          { id: 'm2', author: 'Ben', text: 'two' },
        ],
      }),
    );

    const rows = byClass(host, 'msg');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toBe(first);
    expect(rows[1]?.textContent).toContain('two');
  });
});

describe('mountOverlay — what is playing', () => {
  it('draws the playing row, the one after it, and no skip by default', () => {
    const { host } = mount({
      initialState: room({ nowPlaying: 'The Feature', upNext: 'The Short' }),
    });

    expect(oneByClass(host, 'now').hidden).toBe(false);
    expect(oneByClass(host, 'now-title').textContent).toBe('The Feature');
    expect(oneByClass(host, 'now-next').textContent).toBe('Up next: The Short');
    // The room's playbackControl policy decides; absent is not permission.
    expect(oneByClass(host, 'skip').hidden).toBe(true);
  });

  it('renders a hostile title as text and builds no markup from it', () => {
    const nasty = '<img src=x onerror="alert(1)">';
    const { host } = mount({ initialState: room({ nowPlaying: nasty }) });

    const title = oneByClass(host, 'now-title');
    expect(title.textContent).toBe(nasty);
    expect(title.childNodes).toHaveLength(1);
    expect(title.childNodes[0]).toBeInstanceOf(FakeText);
    expect(allElements(host).some((el) => el.tagName === 'IMG')).toBe(false);
  });

  it('shows nothing at all when the room is on nothing its queue names', () => {
    const { host } = mount({ initialState: room() });

    // An empty "Playing" heading is worse than no heading.
    expect(oneByClass(host, 'now').hidden).toBe(true);
    expect(oneByClass(host, 'now-next').hidden).toBe(true);
  });

  it('drops the up-next line at the end of the queue', () => {
    const { host, overlay } = mount({
      initialState: room({ nowPlaying: 'The Feature', upNext: 'The Short' }),
    });

    overlay.update(room({ nowPlaying: 'The Short' }));

    expect(oneByClass(host, 'now-title').textContent).toBe('The Short');
    expect(oneByClass(host, 'now-next').hidden).toBe(true);
  });

  it('sends one skip per press, and says so when the room refuses it', async () => {
    const { host, sent } = mount({
      initialState: room({ nowPlaying: 'The Feature', canSkip: true }),
    });
    const skip = oneByClass(host, 'skip');
    expect(skip.hidden).toBe(false);

    click(host, skip);
    // A second press while the first is in flight is not a second intent.
    click(host, skip);

    expect(sent.filter((m) => m.kind === 'overlay:skip')).toHaveLength(1);
    await flush();
    expect(skip.disabled).toBe(false);

    failNextSend = true;
    click(host, skip);
    await flush();

    expect(oneByClass(host, 'notice').textContent).toBe('Couldn’t skip. Try again.');
  });

  it('works from the keyboard, and never reaches the page', () => {
    const { host, sent, pageKeys } = mount({
      initialState: room({ nowPlaying: 'The Feature', canSkip: true }),
    });

    keyActivate(host, oneByClass(host, 'skip'));

    expect(sent).toContainEqual({ kind: 'overlay:skip' });
    expect(pageKeys).toEqual([]);
  });
});

describe('mountOverlay — the boundary with the page', () => {
  it('keeps the overlay’s own keys from a player listening on the way down', () => {
    const { host, pageKeys, pageCaptureKeys } = mount({ initialState: room() });

    // A space typed in chat is the case that matters: on the page it is "pause".
    typeKey(oneByClass(host, 'input'), { key: ' ' });
    typeKey(oneByClass(host, 'send'), { key: 'ArrowRight' });

    expect(pageCaptureKeys).toEqual([]);
    expect(pageKeys).toEqual([]);
  });

  it('cannot be got round by listening on the window after we did', () => {
    const { doc, host } = mount({ initialState: room() });
    const heard: string[] = [];
    doc.defaultView.addEventListener('keydown', (ev: FakeEvent) => heard.push(ev.key), true);

    typeKey(oneByClass(host, 'input'), { key: ' ' });

    expect(heard).toEqual([]);
  });

  it('does not let the page read what was typed, pasted or composed in chat', () => {
    const { doc, host } = mount({ initialState: room() });
    const heard: string[] = [];
    const families = [
      'paste',
      'copy',
      'cut',
      'beforeinput',
      'input',
      'compositionstart',
      'compositionupdate',
      'compositionend',
      'drop',
    ];
    for (const type of families) {
      doc.addEventListener(type, (ev: FakeEvent) => heard.push(`down:${ev.type}`), true);
      doc.addEventListener(type, (ev: FakeEvent) => heard.push(`up:${ev.type}`));
    }

    const input = oneByClass(host, 'input');
    input.focus();
    for (const type of families) dispatchOn(input, type, { clientX: 500, clientY: 200 });

    expect(heard).toEqual([]);
  });

  it('leaves every event the page fires for itself alone', () => {
    const { doc, pageKeys, pageCaptureKeys } = mount({ initialState: room() });
    const player = doc.body.appendChild(doc.createElement('video'));
    const pastes: string[] = [];
    doc.addEventListener('paste', (ev: FakeEvent) => pastes.push(ev.type), true);

    dispatchOn(player, 'keydown', { key: ' ' });
    dispatchOn(doc.body, 'keydown', { key: 'ArrowLeft' });
    dispatchOn(player, 'paste', {});

    expect(pageCaptureKeys).toEqual([' ', 'ArrowLeft']);
    expect(pageKeys).toEqual([' ', 'ArrowLeft']);
    expect(pastes).toEqual(['paste']);
  });

  it('does not let a click on the panel reach the page underneath', () => {
    const { doc, host } = mount({ initialState: room() });
    const clicks: string[] = [];
    doc.addEventListener('click', () => clicks.push('page-down'), true);
    doc.addEventListener('click', () => clicks.push('page-up'));

    click(host, oneByClass(host, 'send'));
    dispatchOn(doc.body, 'click');

    expect(clicks).toEqual(['page-down', 'page-up']);
  });

  it('stops an event the page aims at the host as well', () => {
    const { doc, host } = mount({ initialState: room() });
    const heard: string[] = [];
    doc.addEventListener('click', (ev: FakeEvent) => {
      heard.push(ev.target === doc.body ? 'page' : 'host');
    }, true);

    // The host is the only node of ours the page can reach, and everything that
    // happens inside the overlay says it came from there.
    dispatchOn(host, 'click', { clientX: 500, clientY: 200 });
    dispatchOn(doc.body, 'click');

    expect(heard).toEqual(['page']);
  });
});

describe('mountOverlay — collapsing', () => {
  it('collapses on Escape without trapping the keyboard', () => {
    const { doc, host } = mount({ initialState: room() });
    const panel = oneByClass(host, 'panel');
    const handle = oneByClass(host, 'handle');

    typeKey(oneByClass(host, 'input'), { key: 'Escape' });

    expect(panel.hidden).toBe(true);
    expect(handle.hidden).toBe(false);
    // Focus went to the control that replaced the one it was on — not nowhere,
    // and not into a trap. The page is told only that the host has focus.
    expect(shadowOf(host).activeElement).toBe(handle);
    expect(doc.activeElement).toBe(host);
  });

  it('comes back from the handle, by click or by keyboard', () => {
    const { host } = mount({ initialState: room() });
    click(host, oneByClass(host, 'hide'));
    expect(oneByClass(host, 'panel').hidden).toBe(true);

    // No pointer behind this one: it is Enter on the focused handle.
    keyActivate(host, oneByClass(host, 'handle'));

    expect(oneByClass(host, 'panel').hidden).toBe(false);
    expect(oneByClass(host, 'handle').hidden).toBe(true);
    expect(shadowOf(host).activeElement).toBe(oneByClass(host, 'hide'));
  });

  it('counts what arrived while it was away, and says so in words', () => {
    const { host, overlay } = mount({ initialState: room() });
    click(host, oneByClass(host, 'hide'));

    overlay.update(
      room({
        messages: [
          { id: 'm1', author: 'Ana', text: 'one' },
          { id: 'm2', author: 'Ben', text: 'two' },
        ],
      }),
    );

    const handle = oneByClass(host, 'handle');
    expect(handle.textContent).toContain('2 new');
    expect(handle.getAttribute('aria-label')).toContain('Show the Gather panel');

    click(host, handle);
    expect(oneByClass(host, 'handle').textContent).toBe('Gather');
  });

  it('does not call the room’s backlog unread', async () => {
    snapshot = room({ messages: [said('m1'), said('m2'), said('m3')] });
    const { host, overlay } = mount();
    const handle = oneByClass(host, 'handle');

    // Away before the room had said anything at all, so all three arrive while
    // the panel is collapsed — but every one of them was already said.
    click(host, oneByClass(host, 'hide'));
    await flush();
    expect(handle.textContent).toBe('Gather');

    overlay.update(room({ messages: [said('m1'), said('m2'), said('m3'), said('m4')] }));
    expect(handle.textContent).toContain('1 new');
  });

  it('counts arrivals, not the rows a rebuilt list redraws', () => {
    const { host, overlay } = mount({
      initialState: room({ messages: [said('m1'), said('m2'), said('m3')] }),
    });
    click(host, oneByClass(host, 'hide'));

    // The room dropped its oldest message, so the whole list is drawn again —
    // and one line of it is new.
    overlay.update(room({ messages: [said('m2'), said('m3'), said('m4')] }));

    expect(oneByClass(host, 'handle').textContent).toContain('1 new');
  });
});

describe('mountOverlay — moving and remembering', () => {
  it('drags by the header and stays on screen', () => {
    const { doc, host } = mount({ initialState: room() });
    const head = oneByClass(host, 'head');
    const startLeft = VIEWPORT.width - PANEL_WIDTH - EDGE_MARGIN;
    const idleListeners = doc.listenerCount();

    pressOn(host, head, { clientX: 1000, clientY: 100 });
    dispatchOn(doc.body, 'pointermove', { clientX: 940, clientY: 200 });

    expect(host.style.getPropertyValue('left')).toBe(`${startLeft - 60}px`);
    expect(host.style.getPropertyValue('top')).toBe(`${EDGE_MARGIN + 100}px`);

    // Dragged off the left edge: the header has to stay grabbable.
    dispatchOn(doc.body, 'pointermove', { clientX: -9000, clientY: 9000 });
    expect(host.style.getPropertyValue('left')).toBe(`${EDGE_MARGIN}px`);
    expect(host.style.getPropertyValue('top')).toBe(`${VIEWPORT.height - 56}px`);

    dispatchOn(doc.body, 'pointerup', {});
    // The drag is over: the page's pointer stream is ours no longer.
    expect(doc.listenerCount()).toBe(idleListeners);
  });

  it('ends a drag that finishes over the header it was holding', () => {
    const { doc, host } = mount({ initialState: room() });
    const head = oneByClass(host, 'head');
    const idleListeners = doc.listenerCount();

    pressOn(host, head, { clientX: 1000, clientY: 100 });
    expect(doc.listenerCount()).toBeGreaterThan(idleListeners);

    // The pointer never left the header, so this ending never reaches the page.
    shadowOf(host).hitTarget = head;
    dispatchOn(head, 'pointerup', { clientX: 1000, clientY: 100 });

    expect(doc.listenerCount()).toBe(idleListeners);
    expect(head.getAttribute('data-dragging')).toBeNull();
  });

  it('does not start a drag from the Hide button', () => {
    const { doc, host } = mount({ initialState: room() });
    const before = host.style.getPropertyValue('left');

    pressOn(host, oneByClass(host, 'hide'), { clientX: 1000, clientY: 100 });
    dispatchOn(doc.body, 'pointermove', { clientX: 500, clientY: 400 });

    expect(host.style.getPropertyValue('left')).toBe(before);
  });

  it('remembers where it was put, per site, and comes back there', async () => {
    const store = new Map<string, unknown>();
    const first = mount({ initialState: room(), store });
    pressOn(first.host, oneByClass(first.host, 'head'), { clientX: 1000, clientY: 100 });
    dispatchOn(first.doc.body, 'pointermove', { clientX: 900, clientY: 300 });
    dispatchOn(first.doc.body, 'pointerup', {});
    click(first.host, oneByClass(first.host, 'hide'));
    first.overlay.destroy();

    expect(store.get('gather.overlay.v1:example.com')).toEqual({
      x: VIEWPORT.width - PANEL_WIDTH - EDGE_MARGIN - 100,
      y: EDGE_MARGIN + 200,
      collapsed: true,
    });

    const second = mount({ initialState: room(), store });
    await flush();

    expect(oneByClass(second.host, 'panel').hidden).toBe(true);
    expect(second.host.style.getPropertyValue('left')).toBe(
      `${VIEWPORT.width - PANEL_WIDTH - EDGE_MARGIN - 100}px`,
    );

    // A different site starts fresh: a corner that suits Netflix is in the way
    // on a music player.
    const elsewhere = mount({ initialState: room(), store, hostname: 'music.example' });
    await flush();
    expect(oneByClass(elsewhere.host, 'panel').hidden).toBe(false);
  });

  it('lets what the user just did beat what storage says a moment later', async () => {
    const store = new Map<string, unknown>([
      ['gather.overlay.v1:example.com', { x: 40, y: 40, collapsed: true }],
    ]);
    const { host } = mount({ initialState: room(), store });

    // Collapsed in storage, but the user opened the panel before the read came
    // back — the panel stays open.
    click(host, oneByClass(host, 'hide'));
    click(host, oneByClass(host, 'handle'));
    await flush();

    expect(oneByClass(host, 'panel').hidden).toBe(false);
  });
});

describe('mountOverlay — the page changing under it', () => {
  it('rises above a fullscreen <video>, which draws no children at all', () => {
    const { doc, host } = mount({ initialState: room() });
    const player = doc.body.appendChild(doc.createElement('video'));

    doc.fullscreenElement = player;
    doc.fire(new FakeEvent('fullscreenchange'), false, true);

    // Not inside the video — nothing put there is ever painted — but in the top
    // layer, which is painted above it.
    expect(host.parentNode).toBe(doc.body);
    expect(host.popoverOpen).toBe(true);
    expect(host.getAttribute('popover')).toBe('manual');

    doc.fullscreenElement = null;
    doc.fire(new FakeEvent('fullscreenchange'), false, true);

    expect(host.popoverOpen).toBe(false);
    expect(host.getAttribute('popover')).toBeNull();
    expect(host.parentNode).toBe(doc.body);
  });

  it('rises above a fullscreen player element without moving into it', () => {
    const { doc, host } = mount({ initialState: room() });
    const player = doc.body.appendChild(doc.createElement('div'));

    doc.fullscreenElement = player;
    doc.fire(new FakeEvent('fullscreenchange'), false, true);

    expect(host.popoverOpen).toBe(true);
    expect(host.parentNode).toBe(doc.body);
  });

  it('follows the film inside where the browser has no top layer to ask for', () => {
    const { doc, host } = mount({ initialState: room(), popover: false });
    const player = doc.body.appendChild(doc.createElement('div'));

    doc.fullscreenElement = player;
    doc.fire(new FakeEvent('fullscreenchange'), false, true);
    expect(host.parentNode).toBe(player);

    doc.fullscreenElement = null;
    doc.fire(new FakeEvent('fullscreenchange'), false, true);
    expect(host.parentNode).toBe(doc.body);
  });

  it('stays where it is when an old browser fullscreens a bare <video>', () => {
    const { doc, host } = mount({ initialState: room(), popover: false });
    const player = doc.body.appendChild(doc.createElement('video'));

    doc.fullscreenElement = player;
    doc.fire(new FakeEvent('fullscreenchange'), false, true);

    // Out of sight until the film leaves fullscreen: there is no third place to
    // put it, and inside the video is nowhere.
    expect(host.parentNode).toBe(doc.body);
    expect(host.popoverOpen).toBe(false);
    expect(byClass(host, 'panel')).toHaveLength(1);
  });

  it('stays reachable when the window is resized smaller', () => {
    const { doc, host } = mount({ initialState: room() });

    doc.defaultView.innerWidth = 400;
    doc.defaultView.innerHeight = 300;
    doc.defaultView.fire(new FakeEvent('resize'), false, true);

    // Pulled back inside the new window instead of sitting off its right edge.
    expect(host.style.getPropertyValue('left')).toBe(`${400 - PANEL_WIDTH - EDGE_MARGIN}px`);
    expect(host.style.getPropertyValue('top')).toBe(`${EDGE_MARGIN}px`);
  });

  it('asks for a snapshot when it is mounted without one', async () => {
    snapshot = room({ roomName: 'Sunday film', messages: [{ id: 'm1', author: 'Ana', text: 'hi' }] });
    const { host, sent } = mount();

    expect(sent).toContainEqual({ kind: 'overlay:state' });
    await flush();

    expect(oneByClass(host, 'room').textContent).toBe('Sunday film');
    expect(byClass(host, 'msg')).toHaveLength(1);
  });

  it('shrugs off a snapshot that is not a room', async () => {
    snapshot = 'nope';
    const { host } = mount();
    await flush();

    expect(oneByClass(host, 'room').textContent).toBe('Your room');
    expect(oneByClass(host, 'status').textContent).toBe('Connecting to the room…');
  });
});

describe('mountOverlay — leaving', () => {
  it('offers the room’s own exits through the caller’s channel', () => {
    const { host, sent } = mount({ initialState: room() });
    const links = byClass(host, 'link');

    click(host, links[0] as FakeElement);
    click(host, links[1] as FakeElement);

    expect(sent).toContainEqual({ kind: 'overlay:open-app' });
    expect(sent).toContainEqual({ kind: 'overlay:leave' });
  });

  it('takes every node and every listener with it when it goes', () => {
    const { doc, host, overlay, pageListeners } = mount({ initialState: room() });
    expect(doc.listenerCount()).toBeGreaterThan(pageListeners);
    expect(doc.defaultView.listenerCount()).toBeGreaterThan(0);

    overlay.destroy();

    expect(doc.body.childNodes).toHaveLength(0);
    expect(host.parentNode).toBeNull();
    expect(doc.listenerCount()).toBe(pageListeners);
    expect(doc.defaultView.listenerCount()).toBe(0);
    expect(host.listenerCount()).toBe(0);
    // And nothing it is asked to do afterwards touches the page again.
    overlay.update(room({ roomName: 'later' }));
    overlay.destroy();
    expect(doc.body.childNodes).toHaveLength(0);
  });

  it('lets go of the page’s pointer stream even mid-drag', () => {
    const { doc, host, overlay, pageListeners } = mount({ initialState: room() });
    const idleListeners = doc.listenerCount();

    pressOn(host, oneByClass(host, 'head'), { clientX: 900, clientY: 100 });
    expect(doc.listenerCount()).toBeGreaterThan(idleListeners);

    overlay.destroy();
    expect(doc.listenerCount()).toBe(pageListeners);
  });
});
