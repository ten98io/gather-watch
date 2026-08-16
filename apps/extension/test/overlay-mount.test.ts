import { beforeEach, describe, expect, it } from 'vitest';

import { mountOverlay } from '../src/overlay/mount';
import type { OverlayHandle, OverlayStorage } from '../src/overlay/mount';
import { EDGE_MARGIN, PANEL_WIDTH } from '../src/overlay/position';
import type { OverlayOutbound, OverlayRoomState } from '../src/overlay/state';
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
  /** Keys the page can see on the document's event surface. */
  pageKeys: string[];
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

interface MountInput {
  initialState?: OverlayRoomState;
  store?: Map<string, unknown>;
  hostname?: string;
  withStorage?: boolean;
}

function mount(input: MountInput = {}): Harness {
  const doc = new FakeDocument(input.hostname ?? 'example.com', VIEWPORT.width, VIEWPORT.height);
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
    pageListeners: 0,
  };

  // The page's own hotkey handler — a player listens exactly like this.
  doc.addEventListener('keydown', (ev: FakeEvent) => harness.pageKeys.push(ev.key));
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
    const { doc, store } = mount({ store: new Map([['playin.overlay.v1:example.com', { x: 40, y: 60, collapsed: true }]]) });
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
    dispatchOn(input, 'keydown', { key: 'Enter' });

    expect(sent).toContainEqual({ kind: 'overlay:chat', text: 'hello everyone' });
    expect(input.value).toBe('');
  });

  it('gives a failed message back with a plain line, losing nothing', async () => {
    failNextSend = true;
    const { host } = mount({ initialState: room() });
    const input = oneByClass(host, 'input');

    input.value = 'did this send?';
    dispatchOn(input, 'keydown', { key: 'Enter' });
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

describe('mountOverlay — the keyboard boundary', () => {
  it('keeps the overlay’s own keys away from the page', () => {
    const { host, pageKeys } = mount({ initialState: room() });
    const input = oneByClass(host, 'input');

    dispatchOn(input, 'keydown', { key: ' ' });
    dispatchOn(oneByClass(host, 'send'), 'keydown', { key: 'ArrowRight' });

    expect(pageKeys).toEqual([]);
  });

  it('leaves every key the page fires for itself alone', () => {
    const { doc, pageKeys } = mount({ initialState: room() });
    const player = doc.body.appendChild(doc.createElement('video'));

    dispatchOn(player, 'keydown', { key: ' ' });
    dispatchOn(doc.body, 'keydown', { key: 'ArrowLeft' });

    expect(pageKeys).toEqual([' ', 'ArrowLeft']);
  });

  it('does not let a click on the panel reach the page underneath', () => {
    const { doc, host } = mount({ initialState: room() });
    const clicks: string[] = [];
    doc.addEventListener('click', () => clicks.push('page'));

    dispatchOn(oneByClass(host, 'send'), 'click');
    dispatchOn(doc.body, 'click');

    expect(clicks).toEqual(['page']);
  });
});

describe('mountOverlay — collapsing', () => {
  it('collapses on Escape without trapping the keyboard', () => {
    const { doc, host } = mount({ initialState: room() });
    const panel = oneByClass(host, 'panel');
    const handle = oneByClass(host, 'handle');

    dispatchOn(oneByClass(host, 'input'), 'keydown', { key: 'Escape' });

    expect(panel.hidden).toBe(true);
    expect(handle.hidden).toBe(false);
    // Focus went to the control that replaced the one it was on — not nowhere,
    // and not into a trap.
    expect(doc.activeElement).toBe(handle);
  });

  it('comes back from the handle, by click or by keyboard', () => {
    const { doc, host } = mount({ initialState: room() });
    dispatchOn(oneByClass(host, 'hide'), 'click');
    expect(oneByClass(host, 'panel').hidden).toBe(true);

    dispatchOn(oneByClass(host, 'handle'), 'click');

    expect(oneByClass(host, 'panel').hidden).toBe(false);
    expect(oneByClass(host, 'handle').hidden).toBe(true);
    expect(doc.activeElement).toBe(oneByClass(host, 'hide'));
  });

  it('counts what arrived while it was away, and says so in words', () => {
    const { host, overlay } = mount({ initialState: room() });
    dispatchOn(oneByClass(host, 'hide'), 'click');

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
    expect(handle.getAttribute('aria-label')).toContain('Show the Playin panel');

    dispatchOn(handle, 'click');
    expect(oneByClass(host, 'handle').textContent).toBe('Playin');
  });
});

describe('mountOverlay — moving and remembering', () => {
  it('drags by the header and stays on screen', () => {
    const { doc, host } = mount({ initialState: room() });
    const head = oneByClass(host, 'head');
    const startLeft = VIEWPORT.width - PANEL_WIDTH - EDGE_MARGIN;
    const idleListeners = doc.listenerCount();

    dispatchOn(head, 'pointerdown', { clientX: 1000, clientY: 100 });
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

  it('does not start a drag from the Hide button', () => {
    const { doc, host } = mount({ initialState: room() });
    const before = host.style.getPropertyValue('left');

    dispatchOn(oneByClass(host, 'hide'), 'pointerdown', { clientX: 1000, clientY: 100 });
    dispatchOn(doc.body, 'pointermove', { clientX: 500, clientY: 400 });

    expect(host.style.getPropertyValue('left')).toBe(before);
  });

  it('remembers where it was put, per site, and comes back there', async () => {
    const store = new Map<string, unknown>();
    const first = mount({ initialState: room(), store });
    dispatchOn(oneByClass(first.host, 'head'), 'pointerdown', { clientX: 1000, clientY: 100 });
    dispatchOn(first.doc.body, 'pointermove', { clientX: 900, clientY: 300 });
    dispatchOn(first.doc.body, 'pointerup', {});
    dispatchOn(oneByClass(first.host, 'hide'), 'click');
    first.overlay.destroy();

    expect(store.get('playin.overlay.v1:example.com')).toEqual({
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
      ['playin.overlay.v1:example.com', { x: 40, y: 40, collapsed: true }],
    ]);
    const { host } = mount({ initialState: room(), store });

    // Collapsed in storage, but the user opened the panel before the read came
    // back — the panel stays open.
    dispatchOn(oneByClass(host, 'hide'), 'click');
    dispatchOn(oneByClass(host, 'handle'), 'click');
    await flush();

    expect(oneByClass(host, 'panel').hidden).toBe(false);
  });
});

describe('mountOverlay — the page changing under it', () => {
  it('follows the film into fullscreen and back out', () => {
    const { doc, host } = mount({ initialState: room() });
    const player = doc.body.appendChild(doc.createElement('div'));

    doc.fullscreenElement = player;
    doc.fire(new FakeEvent('fullscreenchange'), false, true);
    expect(host.parentNode).toBe(player);

    doc.fullscreenElement = null;
    doc.fire(new FakeEvent('fullscreenchange'), false, true);
    expect(host.parentNode).toBe(doc.body);
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

    dispatchOn(links[0] as FakeElement, 'click');
    dispatchOn(links[1] as FakeElement, 'click');

    expect(sent).toContainEqual({ kind: 'overlay:open-app' });
    expect(sent).toContainEqual({ kind: 'overlay:leave' });
  });

  it('takes every node and every listener with it when it goes', () => {
    const { doc, host, overlay, pageListeners } = mount({ initialState: room() });
    expect(doc.listenerCount()).toBeGreaterThan(pageListeners);

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

    dispatchOn(oneByClass(host, 'head'), 'pointerdown', { clientX: 900, clientY: 100 });
    expect(doc.listenerCount()).toBeGreaterThan(idleListeners);

    overlay.destroy();
    expect(doc.listenerCount()).toBe(pageListeners);
  });
});
