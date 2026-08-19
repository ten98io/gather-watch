/**
 * The injected room overlay: Gather's room UI, put onto the site the user is
 * actually watching.
 *
 * The content cannot come to us — Netflix and most large sites refuse to be
 * framed, and DRM playback is bound to its own origin — so the room goes to the
 * content instead.
 *
 * ── What of Model C this is, and what it is not ────────────────────────────
 * docs/EXTENSION_FIRST.md Part 2 defines Model C as injecting Gather's
 * **chat/call/queue** UI into the content site's page. Three of those four
 * words are delivered here: the room's conversation, who is in it, what is
 * playing and what is next, and — for a member the room's playbackControl
 * policy admits — a skip. **The call is not.** No mic, no camera, no tile:
 * voice would need `getUserMedia` in the offscreen document and none of it is
 * built, which is what apps/extension/README.md says under "Honest limits"
 * and what this header used to paper over by citing the model whole.
 *
 * Owns: the host element, the closed shadow root, everything drawn inside it,
 * dragging, collapsing, per-site memory, and the keyboard boundary between us
 * and the page.
 *
 * Deliberately NOT: chrome.* (the caller passes `send` and `storage`), playback
 * (the driver does that), and anything at module scope — importing this file
 * creates no element, reads no storage and registers no listener, which is what
 * makes it testable without a browser.
 *
 * ── The two directions of isolation ───────────────────────────────────────
 * Outward: one fixed-position host with `pointer-events: none`, so the page's
 * layout never shifts and nothing on it becomes unclickable; no class, id or
 * style is added to the page; no global is written.
 * Inward: a CLOSED shadow root (the page cannot reach our nodes through
 * `host.shadowRoot`), a stylesheet that inherits nothing from the page, and
 * host-level layout locked with inline `!important` because `:host` rules lose
 * to the page's own rules matching the host (see styles.ts).
 *
 * ── Why events stop before the page hears them ────────────────────────────
 * A player's hotkeys live on the page's document: Space pauses, arrows seek.
 * Typing "space bar" into our chat box would pause everyone's film, and one
 * `paste` listener on the page would read what was pasted into it. So every
 * event that ORIGINATES inside the overlay is stopped at the top of the page's
 * event path and handed to our own controls from there; boundary.ts owns that
 * and explains it. Nothing the page fires is touched, so the site keeps every
 * shortcut it had.
 */

import { guardOverlayEvents } from './boundary';
import { clampPoint, defaultPoint, memoryKey, readMemory } from './position';
import type { OverlayPoint, Viewport } from './position';
import { EMPTY_VIEW, describePeople, normalizeRoomState, personNote, safeOutgoing } from './state';
import type { MessageView, OverlayRoomState, OverlaySend, PersonView, RoomView } from './state';
import { HOST_LOCKS, OVERLAY_CSS } from './styles';

/** chrome.storage, injected — see the module header. Failures are survivable. */
export interface OverlayStorage {
  read(key: string): Promise<unknown>;
  write(key: string, value: unknown): Promise<void>;
}

export interface OverlayOptions {
  /** The page the overlay is injected into. */
  document: Document;
  /** The overlay's only route to the background worker. */
  send: OverlaySend;
  /** Where the host element goes. Defaults to the page's body. */
  container?: Element;
  /** Per-site memory for position and collapsed state. Omit to remember nothing. */
  storage?: OverlayStorage;
  /** Which site this is. Defaults to the page's hostname. */
  siteKey?: string;
  /** First paint. Without it the overlay asks the background for a snapshot. */
  initialState?: OverlayRoomState;
  /** Follow the page into its own fullscreen. Default true. */
  followFullscreen?: boolean;
}

export interface OverlayHandle {
  /** Push the room's current state. Safe to call at any rate. */
  update(state: OverlayRoomState): void;
  /** Remove every node and every listener. Idempotent. */
  destroy(): void;
}

const HANDLE_NAME = 'Gather';
const SEND_FAILED = 'That message did not send. Try again.';
const SKIP_FAILED = 'The room did not move on. Try again.';
const CHAT_PLACEHOLDER = 'Message the room';
const OFFLINE_PLACEHOLDER = 'You can chat once you are back in the room';
/** Distance from the end of the chat that still counts as "reading the latest". */
const PIN_SLACK_PX = 24;
/** Used only when the page will not say how big it is. */
const FALLBACK_VIEWPORT: Viewport = { width: 1280, height: 720 };

/**
 * Elements that draw no children of their own. A fullscreen <video> renders
 * exactly its own picture and an <iframe> renders another document, so a panel
 * appended INSIDE one is never painted at all.
 */
const DRAWS_NO_CHILDREN: ReadonlySet<string> = new Set([
  'VIDEO',
  'AUDIO',
  'IMG',
  'IFRAME',
  'EMBED',
  'OBJECT',
  'CANVAS',
]);

function isRecordLike(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Put the room on the page.
 *
 * Everything it needs arrives as an argument; nothing is read from a global.
 */
export function mountOverlay(opts: OverlayOptions): OverlayHandle {
  const doc = opts.document;
  const container: Element | null = opts.container ?? doc.body ?? doc.documentElement;
  if (container === null) throw new Error('Gather needs a page to put the room on');
  const view = doc.defaultView;
  const storage = opts.storage ?? null;
  const key = memoryKey(opts.siteKey ?? doc.location?.hostname ?? '');

  let destroyed = false;
  let collapsed = false;
  let unread = 0;
  let sending = false;
  /** A skip is in flight. One press, one `sync.advance` — the room's own
   *  compare-and-set would drop the second, but the button should not send it. */
  let skipping = false;
  /** The overlay has been told the room's real state at least once. */
  let stateSeen = false;
  /** The host is in the page's top layer, above whatever went fullscreen. */
  let inTopLayer = false;
  /** The user has taken charge of these, so a late storage read must not undo it. */
  let userMoved = false;
  let userToggled = false;
  let current: RoomView = EMPTY_VIEW;
  let peopleSignature = '';
  let renderedIds: string[] = [];

  /* ── listener bookkeeping: everything added is removable ── */

  const disposers: Array<() => void> = [];
  const dragDisposers: Array<() => void> = [];

  const listen = (
    target: EventTarget,
    type: string,
    handler: (ev: Event) => void,
    into: Array<() => void> = disposers,
    capture = false,
  ): void => {
    target.addEventListener(type, handler, capture);
    into.push(() => target.removeEventListener(type, handler, capture));
  };

  /* ── the elements ── */

  const make = (tag: string, className = ''): HTMLElement => {
    const node = doc.createElement(tag);
    if (className.length > 0) node.className = className;
    return node;
  };

  /**
   * The host carries no id, class or data attribute on purpose: a name is a
   * selector, and the page is hostile by assumption. Nothing needs one — the
   * caller holds the handle this function returns.
   */
  const host = doc.createElement('div');
  for (const [property, value] of HOST_LOCKS) {
    host.style.setProperty(property, value, 'important');
  }

  // CLOSED, not open: `host.shadowRoot` stays null, so the page cannot read or
  // restyle a single node of ours through it.
  const shadow = host.attachShadow({ mode: 'closed' });
  // Everything that starts in the overlay stops before the page hears it, and
  // reaches our own controls through `boundary.on`. See boundary.ts.
  const boundary = guardOverlayEvents({ document: doc, host, root: shadow });
  const styleEl = doc.createElement('style');
  styleEl.textContent = OVERLAY_CSS;
  shadow.appendChild(styleEl);

  const handle = doc.createElement('button');
  handle.className = 'handle';
  handle.setAttribute('type', 'button');
  handle.textContent = HANDLE_NAME;
  handle.hidden = true;

  const panel = make('section', 'panel');
  panel.setAttribute('role', 'complementary');
  panel.setAttribute('aria-label', 'Gather room');

  const head = make('header', 'head');
  const headText = make('div', 'head-text');
  const roomEl = make('p', 'room');
  const statusEl = make('p', 'status');
  // Polite, and only ever written when the sentence actually changed, so a
  // screen reader is told about a real change and nothing else.
  statusEl.setAttribute('role', 'status');
  statusEl.setAttribute('aria-live', 'polite');
  const hideBtn = doc.createElement('button');
  hideBtn.className = 'hide';
  hideBtn.setAttribute('type', 'button');
  hideBtn.setAttribute('aria-label', 'Hide the Gather panel');
  hideBtn.textContent = 'Hide';
  headText.appendChild(roomEl);
  headText.appendChild(statusEl);
  head.appendChild(headText);
  head.appendChild(hideBtn);

  // What is playing, directly under the status line that says how this viewer
  // is doing against it. Hidden whole when the room is on nothing the queue
  // names — an empty "Playing" heading is worse than no heading.
  const nowBlock = make('div', 'now');
  nowBlock.hidden = true;
  const nowText = make('div', 'now-text');
  const nowTitle = make('h2', 'section-title');
  nowTitle.textContent = 'Playing';
  const nowEl = make('p', 'now-title');
  const nextEl = make('p', 'now-next');
  nextEl.hidden = true;
  nowText.appendChild(nowTitle);
  nowText.appendChild(nowEl);
  nowText.appendChild(nextEl);
  const skipBtn = doc.createElement('button');
  skipBtn.className = 'skip';
  skipBtn.setAttribute('type', 'button');
  skipBtn.setAttribute('aria-label', 'Skip to the next item in the queue');
  skipBtn.textContent = 'Skip';
  skipBtn.hidden = true;
  nowBlock.appendChild(nowText);
  nowBlock.appendChild(skipBtn);

  const people = make('div', 'people');
  const peopleTitle = make('h2', 'section-title');
  peopleTitle.textContent = 'Who is here';
  const peopleList = make('ul', 'people-list');
  people.appendChild(peopleTitle);
  people.appendChild(peopleList);

  const messagesEl = make('ul', 'messages');
  messagesEl.setAttribute('role', 'log');
  messagesEl.setAttribute('aria-live', 'polite');
  messagesEl.setAttribute('aria-label', 'Room chat');

  const aheadEl = make('p', 'ahead');
  aheadEl.hidden = true;
  const noticeEl = make('p', 'notice');
  noticeEl.setAttribute('role', 'status');
  noticeEl.hidden = true;

  // Deliberately a <div> and not a <form>: a stray submit inside a shadow root
  // navigates the PAGE, which would take the film away mid-sentence.
  const composer = make('div', 'composer');
  const input = doc.createElement('input');
  input.className = 'input';
  input.setAttribute('type', 'text');
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('aria-label', CHAT_PLACEHOLDER);
  input.setAttribute('placeholder', CHAT_PLACEHOLDER);
  input.setAttribute('maxlength', '1000');
  const sendBtn = doc.createElement('button');
  sendBtn.className = 'send';
  sendBtn.setAttribute('type', 'button');
  sendBtn.textContent = 'Send';
  composer.appendChild(input);
  composer.appendChild(sendBtn);

  const foot = make('div', 'foot');
  const openBtn = doc.createElement('button');
  openBtn.className = 'link';
  openBtn.setAttribute('type', 'button');
  openBtn.textContent = 'Open Gather';
  const leaveBtn = doc.createElement('button');
  leaveBtn.className = 'link';
  leaveBtn.setAttribute('type', 'button');
  leaveBtn.textContent = 'Leave room';
  foot.appendChild(openBtn);
  foot.appendChild(leaveBtn);

  panel.appendChild(head);
  panel.appendChild(nowBlock);
  panel.appendChild(people);
  panel.appendChild(messagesEl);
  panel.appendChild(aheadEl);
  panel.appendChild(noticeEl);
  panel.appendChild(composer);
  panel.appendChild(foot);

  shadow.appendChild(handle);
  shadow.appendChild(panel);

  /* ── placement ── */

  const viewportOf = (): Viewport => {
    const width = view?.innerWidth;
    const height = view?.innerHeight;
    return {
      width: typeof width === 'number' && width > 0 ? width : FALLBACK_VIEWPORT.width,
      height: typeof height === 'number' && height > 0 ? height : FALLBACK_VIEWPORT.height,
    };
  };

  let point: OverlayPoint = clampPoint(defaultPoint(viewportOf()), viewportOf());

  const applyPoint = (): void => {
    host.style.setProperty('left', `${point.x}px`, 'important');
    host.style.setProperty('top', `${point.y}px`, 'important');
  };
  applyPoint();
  container.appendChild(host);

  const remember = (): void => {
    if (storage === null || destroyed) return;
    void storage.write(key, { x: point.x, y: point.y, collapsed }).catch(() => undefined);
  };

  /* ── rendering ── */

  const setText = (el: HTMLElement, value: string): void => {
    if (el.textContent !== value) el.textContent = value;
  };

  const setLine = (el: HTMLElement, value: string): void => {
    setText(el, value);
    el.hidden = value.length === 0;
  };

  const personNode = (person: PersonView): HTMLElement => {
    const item = make('li', 'person');
    const name = make('span', 'person-name');
    // textContent, never innerHTML: this name came from someone else.
    name.textContent = person.you ? `${person.name} (you)` : person.name;
    item.appendChild(name);
    const note = personNote(person);
    if (note.length > 0) {
      const tag = make('span', 'person-note');
      tag.textContent = note;
      item.appendChild(tag);
    }
    return item;
  };

  const messageNode = (message: MessageView): HTMLElement => {
    const item = make('li', 'msg');
    if (message.mine) item.setAttribute('data-mine', 'true');
    const author = make('span', 'msg-author');
    author.textContent = message.author;
    const text = make('span', 'msg-text');
    // Same rule as everywhere else in this file: nodes and textContent only.
    text.textContent = message.text;
    item.appendChild(author);
    item.appendChild(text);
    return item;
  };

  const syncHandle = (): void => {
    const badge = unread > 99 ? '99+' : String(unread);
    setText(handle, unread > 0 ? `${HANDLE_NAME} — ${badge} new` : HANDLE_NAME);
    const waiting = unread > 0 ? `. ${badge} new messages` : '';
    handle.setAttribute(
      'aria-label',
      `Show the Gather panel. ${describePeople(current.people)}${waiting}`,
    );
  };

  const syncComposer = (): void => {
    const blocked = !current.canSend || sending;
    input.disabled = blocked;
    sendBtn.disabled = blocked;
    input.setAttribute('placeholder', current.canSend ? CHAT_PLACEHOLDER : OFFLINE_PLACEHOLDER);
  };

  const syncNow = (next: RoomView): void => {
    // No title means the room is not on a row of its queue — there is nothing
    // to name, nothing to say is next, and nothing to skip.
    nowBlock.hidden = next.nowPlaying.length === 0;
    setText(nowEl, next.nowPlaying);
    setLine(nextEl, next.upNextLine);
    skipBtn.hidden = !next.canSkip;
    skipBtn.disabled = skipping;
  };

  const renderPeople = (next: RoomView): void => {
    const signature = next.people
      .map((p) => `${p.id}|${p.name}|${p.you ? 1 : 0}${p.micOn ? 1 : 0}${p.away ? 1 : 0}`)
      .join('\n');
    if (signature === peopleSignature) return;
    peopleSignature = signature;
    peopleList.textContent = '';
    if (next.people.length === 0) {
      const empty = make('li', 'person-empty');
      empty.textContent = describePeople(next.people);
      peopleList.appendChild(empty);
      return;
    }
    for (const person of next.people) peopleList.appendChild(personNode(person));
  };

  const nearBottom = (): boolean => {
    const gap = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
    return !Number.isFinite(gap) || gap <= PIN_SLACK_PX;
  };

  /**
   * `backlog` marks the first state the overlay is ever given. What is in it
   * was already said, however long ago the panel was collapsed, so none of it
   * is waiting to be read.
   */
  const renderMessages = (next: RoomView, backlog: boolean): void => {
    const ids = next.messages.map((message) => message.id);
    const appended =
      renderedIds.length <= ids.length && renderedIds.every((id, index) => ids[index] === id);
    const pinned = nearBottom();
    const shown = new Set(renderedIds);
    if (!appended) {
      messagesEl.textContent = '';
      renderedIds = [];
    }
    const fresh = next.messages.slice(renderedIds.length);
    for (const message of fresh) messagesEl.appendChild(messageNode(message));
    renderedIds = ids;
    if (fresh.length === 0) return;
    // The badge counts arrivals, not rows drawn: a list rebuilt because the
    // room dropped its oldest message is redrawn in full and is almost all
    // messages this reader has already read.
    if (collapsed && !backlog) unread += ids.filter((id) => !shown.has(id)).length;
    // Follow the conversation, but never yank someone who scrolled back.
    if (pinned) messagesEl.scrollTop = messagesEl.scrollHeight;
  };

  const render = (next: RoomView, backlog: boolean): void => {
    current = next;
    setText(roomEl, next.roomTitle);
    setText(statusEl, next.statusLine);
    syncNow(next);
    renderPeople(next);
    renderMessages(next, backlog);
    setLine(aheadEl, next.aheadLine);
    syncComposer();
    syncHandle();
  };

  /** Draw a state that came from the room, backlog or not. */
  const apply = (raw: unknown): void => {
    const backlog = !stateSeen;
    stateSeen = true;
    render(normalizeRoomState(raw), backlog);
  };

  /* ── collapse / expand ── */

  const setCollapsed = (next: boolean, o: { moveFocus: boolean; save: boolean }): void => {
    collapsed = next;
    panel.hidden = next;
    handle.hidden = !next;
    if (!next) unread = 0;
    syncHandle();
    // Focus is moved only when the user did this themselves, and only onto the
    // control that replaced the one they were on — never taken from the page.
    if (o.moveFocus) (next ? handle : hideBtn).focus();
    if (o.save) remember();
  };

  /* ── chat ── */

  const setNotice = (value: string): void => {
    setLine(noticeEl, value);
  };

  const submit = (): void => {
    if (destroyed || sending) return;
    const text = safeOutgoing(input.value);
    if (text.length === 0) return;
    sending = true;
    input.value = '';
    setNotice('');
    syncComposer();
    void opts
      .send({ kind: 'overlay:chat', text })
      .catch(() => {
        if (destroyed) return;
        // Nothing typed is ever lost: it goes back where it was.
        if (input.value.length === 0) input.value = text;
        setNotice(SEND_FAILED);
      })
      .finally(() => {
        sending = false;
        if (!destroyed) syncComposer();
      });
  };

  /* ── skipping ── */

  /**
   * Move the room off what it is playing. The worker re-checks the room's
   * policy behind this — the control being drawn is a courtesy, not the gate
   * — so a refusal is a real outcome and is said in words rather than
   * swallowed.
   */
  const skip = (): void => {
    if (destroyed || skipping) return;
    skipping = true;
    setNotice('');
    syncNow(current);
    void opts
      .send({ kind: 'overlay:skip' })
      .catch(() => {
        if (!destroyed) setNotice(SKIP_FAILED);
      })
      .finally(() => {
        skipping = false;
        if (!destroyed) syncNow(current);
      });
  };

  /* ── dragging ── */

  let drag: { pointerX: number; pointerY: number; originX: number; originY: number } | null = null;

  const endDrag = (): void => {
    for (const off of dragDisposers.splice(0)) off();
    if (drag === null) return;
    drag = null;
    head.removeAttribute('data-dragging');
    remember();
  };

  const onDragMove = (ev: Event): void => {
    if (drag === null) return;
    const pointer = ev as PointerEvent;
    point = clampPoint(
      {
        x: drag.originX + (pointer.clientX - drag.pointerX),
        y: drag.originY + (pointer.clientY - drag.pointerY),
      },
      viewportOf(),
    );
    applyPoint();
  };

  /* ── wiring ── */

  boundary.on(head, 'pointerdown', (ev, target) => {
    const pointer = ev as PointerEvent;
    if (typeof pointer.button === 'number' && pointer.button !== 0) return;
    if (target === hideBtn || hideBtn.contains(target)) return;
    drag = {
      pointerX: pointer.clientX,
      pointerY: pointer.clientY,
      originX: point.x,
      originY: point.y,
    };
    userMoved = true;
    head.setAttribute('data-dragging', 'true');
    // Otherwise the page starts selecting its own text under our header.
    pointer.preventDefault();
    listen(doc, 'pointermove', onDragMove, dragDisposers, true);
    listen(doc, 'pointerup', () => endDrag(), dragDisposers, true);
    listen(doc, 'pointercancel', () => endDrag(), dragDisposers, true);
  });
  // A drag usually ends with the pointer still over the header it is holding,
  // and an ending like that never reaches the page listener above.
  boundary.on(shadow, 'pointerup', () => endDrag());

  boundary.on(panel, 'keydown', (ev) => {
    if ((ev as KeyboardEvent).key !== 'Escape') return;
    // Escape puts the room away. It never traps: focus lands on the handle,
    // one key away from bringing the panel back.
    userToggled = true;
    setCollapsed(true, { moveFocus: true, save: true });
  });

  boundary.on(input, 'keydown', (ev) => {
    const keyboard = ev as KeyboardEvent;
    // Enter during composition belongs to the input method, not to us: someone
    // writing Japanese, Chinese or Korean presses it to choose the characters
    // they are in the middle of, and sending here would post half a word and
    // empty the box mid-sentence. `keyCode` 229 is the same fact, from a
    // browser that does not set `isComposing`.
    if (keyboard.isComposing || keyboard.keyCode === 229) return;
    if (keyboard.key !== 'Enter' || keyboard.shiftKey) return;
    keyboard.preventDefault();
    submit();
  });

  boundary.on(sendBtn, 'click', () => submit());
  boundary.on(skipBtn, 'click', () => skip());
  boundary.on(hideBtn, 'click', () => {
    userToggled = true;
    setCollapsed(true, { moveFocus: true, save: true });
  });
  boundary.on(handle, 'click', () => {
    userToggled = true;
    setCollapsed(false, { moveFocus: true, save: true });
  });
  boundary.on(openBtn, 'click', () => {
    void opts.send({ kind: 'overlay:open-app' }).catch(() => undefined);
  });
  boundary.on(leaveBtn, 'click', () => {
    void opts.send({ kind: 'overlay:leave' }).catch(() => undefined);
  });

  if (view !== null) {
    listen(view, 'resize', () => {
      point = clampPoint(point, viewportOf());
      applyPoint();
    });
  }

  /**
   * Put the host in the page's top layer, which is painted above the fullscreen
   * element however it was made. Returns false where the browser has no top
   * layer to ask for (Chrome grew `showPopover` in 114).
   */
  const enterTopLayer = (): boolean => {
    if (inTopLayer) return true;
    if (typeof host.showPopover !== 'function') return false;
    try {
      // Manual: a popover that dismisses itself on the next click would take
      // the room away the first time somebody touched the film. The attribute
      // is the one name the host ever carries, and it only lasts as long as the
      // film is fullscreen; a page rule matching it still loses to the inline
      // locks that decide whether the overlay is visible at all (styles.ts).
      host.setAttribute('popover', 'manual');
      host.showPopover();
    } catch {
      host.removeAttribute('popover');
      return false;
    }
    inTopLayer = true;
    return true;
  };

  const leaveTopLayer = (): void => {
    if (!inTopLayer) return;
    inTopLayer = false;
    try {
      host.hidePopover();
    } catch {
      // Already out of the top layer, which is where this was taking it.
    }
    host.removeAttribute('popover');
  };

  const goHome = (): void => {
    if (host.parentNode !== container) container.appendChild(host);
  };

  /**
   * Follow the film into fullscreen.
   *
   * The fullscreen element is painted in the top layer, above everything else
   * on the page, so an overlay left in <body> simply disappears at exactly the
   * moment people are watching together. The top layer is where the overlay
   * goes too: a popover joins it AFTER the fullscreen element did, which puts
   * it above, and that holds whatever went fullscreen — a <div> player, a bare
   * <video>, an <iframe>.
   *
   * Without a top layer the only other way up is to move INSIDE the fullscreen
   * element, which works only when that element draws its children. On the
   * older browsers where it comes to that, a fullscreen <video> or <iframe>
   * leaves the overlay with nowhere to be: a replaced element paints none of
   * its children, and a fullscreen <iframe> is a different document that
   * nothing in this one can appear inside. The panel comes back when the film
   * leaves fullscreen; there is no third place to put it.
   */
  const followFullscreen = (): void => {
    if (destroyed) return;
    const stage = doc.fullscreenElement;
    if (stage === null) {
      leaveTopLayer();
      goHome();
      return;
    }
    goHome();
    if (enterTopLayer()) return;
    if (!DRAWS_NO_CHILDREN.has(stage.tagName) && host.parentNode !== stage) {
      stage.appendChild(host);
    }
  };

  if (opts.followFullscreen !== false) {
    listen(doc, 'fullscreenchange', followFullscreen);
    // Run it once for the state we are mounting INTO. The overlay mounts when
    // the tab joins a room, which is very often already mid-video and already
    // fullscreen; waiting for a change event means it is invisible until the
    // user happens to toggle fullscreen off and on again.
    followFullscreen();
  }

  /* ── first paint ── */

  if (opts.initialState === undefined) {
    // Nothing has been said about the room yet, so this paints the frame and
    // not a single message; the snapshot below is the first real state.
    render(EMPTY_VIEW, true);
    void opts
      .send({ kind: 'overlay:state' })
      .then((snapshot) => {
        if (destroyed || !isRecordLike(snapshot)) return;
        apply(snapshot);
      })
      .catch(() => undefined);
  } else {
    apply(opts.initialState);
  }

  if (storage !== null) {
    void storage
      .read(key)
      .then((raw) => {
        if (destroyed) return;
        const memory = readMemory(raw);
        if (memory === null) return;
        // The user may have dragged or collapsed while this was in flight; what
        // they did just now always beats what they did last time.
        if (!userMoved) {
          point = clampPoint({ x: memory.x, y: memory.y }, viewportOf());
          applyPoint();
        }
        if (!userToggled) setCollapsed(memory.collapsed, { moveFocus: false, save: false });
      })
      .catch(() => undefined);
  }

  return {
    update(state: OverlayRoomState): void {
      if (destroyed) return;
      apply(state);
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      endDrag();
      boundary.destroy();
      for (const off of disposers.splice(0)) off();
      host.remove();
    },
  };
}
