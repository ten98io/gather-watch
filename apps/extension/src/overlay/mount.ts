/**
 * The injected room overlay: Playin's room UI, put onto the site the user is
 * actually watching (docs/EXTENSION_FIRST.md, Part 2, Model C).
 *
 * The content cannot come to us — Netflix and most large sites refuse to be
 * framed, and DRM playback is bound to its own origin — so the room goes to the
 * content instead.
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
 * ── Why events stop at the host ───────────────────────────────────────────
 * A player's hotkeys live on the page's document: Space pauses, arrows seek.
 * Typing "space bar" into our chat box would pause everyone's film. So every
 * event that ORIGINATES inside the overlay is stopped at the host, on its way
 * out. Nothing the page fires is touched — a page-originated key never travels
 * through our host at all — so the site keeps every shortcut it had.
 */

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

const HANDLE_NAME = 'Playin';
const SEND_FAILED = 'That message did not send. Try again.';
const CHAT_PLACEHOLDER = 'Message the room';
const OFFLINE_PLACEHOLDER = 'You can chat once you are back in the room';
/** Distance from the end of the chat that still counts as "reading the latest". */
const PIN_SLACK_PX = 24;
/** Used only when the page will not say how big it is. */
const FALLBACK_VIEWPORT: Viewport = { width: 1280, height: 720 };

/**
 * Events that mean something to a player and would be acted on twice if they
 * escaped the overlay. Both the pointer and the mouse families are listed
 * because a page may listen for either.
 */
const PAGE_GUARDS: readonly string[] = [
  'keydown',
  'keyup',
  'keypress',
  'pointerdown',
  'pointerup',
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'contextmenu',
  'wheel',
];

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
  if (container === null) throw new Error('Playin needs a page to put the room on');
  const view = doc.defaultView;
  const storage = opts.storage ?? null;
  const key = memoryKey(opts.siteKey ?? doc.location?.hostname ?? '');

  let destroyed = false;
  let collapsed = false;
  let unread = 0;
  let sending = false;
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
  panel.setAttribute('aria-label', 'Playin room');

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
  hideBtn.setAttribute('aria-label', 'Hide the Playin panel');
  hideBtn.textContent = 'Hide';
  headText.appendChild(roomEl);
  headText.appendChild(statusEl);
  head.appendChild(headText);
  head.appendChild(hideBtn);

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
  openBtn.textContent = 'Open Playin';
  const leaveBtn = doc.createElement('button');
  leaveBtn.className = 'link';
  leaveBtn.setAttribute('type', 'button');
  leaveBtn.textContent = 'Leave room';
  foot.appendChild(openBtn);
  foot.appendChild(leaveBtn);

  panel.appendChild(head);
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
      `Show the Playin panel. ${describePeople(current.people)}${waiting}`,
    );
  };

  const syncComposer = (): void => {
    const blocked = !current.canSend || sending;
    input.disabled = blocked;
    sendBtn.disabled = blocked;
    input.setAttribute('placeholder', current.canSend ? CHAT_PLACEHOLDER : OFFLINE_PLACEHOLDER);
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

  const renderMessages = (next: RoomView): void => {
    const ids = next.messages.map((message) => message.id);
    const appended =
      renderedIds.length <= ids.length && renderedIds.every((id, index) => ids[index] === id);
    const pinned = nearBottom();
    if (!appended) {
      messagesEl.textContent = '';
      renderedIds = [];
    }
    const fresh = next.messages.slice(renderedIds.length);
    for (const message of fresh) messagesEl.appendChild(messageNode(message));
    renderedIds = ids;
    if (fresh.length > 0) {
      if (collapsed) unread += fresh.length;
      // Follow the conversation, but never yank someone who scrolled back.
      if (pinned) messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  };

  const render = (next: RoomView): void => {
    current = next;
    setText(roomEl, next.roomTitle);
    setText(statusEl, next.statusLine);
    renderPeople(next);
    renderMessages(next);
    setLine(aheadEl, next.aheadLine);
    syncComposer();
    syncHandle();
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

  // Everything that starts in the overlay stops at the overlay. See the header.
  for (const type of PAGE_GUARDS) {
    listen(host, type, (ev) => ev.stopPropagation());
  }

  listen(head, 'pointerdown', (ev) => {
    const pointer = ev as PointerEvent;
    if (typeof pointer.button === 'number' && pointer.button !== 0) return;
    if (pointer.target === hideBtn) return;
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

  listen(panel, 'keydown', (ev) => {
    if ((ev as KeyboardEvent).key !== 'Escape') return;
    // Escape puts the room away. It never traps: focus lands on the handle,
    // one key away from bringing the panel back.
    userToggled = true;
    setCollapsed(true, { moveFocus: true, save: true });
  });

  listen(input, 'keydown', (ev) => {
    const keyboard = ev as KeyboardEvent;
    if (keyboard.key !== 'Enter' || keyboard.shiftKey) return;
    keyboard.preventDefault();
    submit();
  });

  listen(sendBtn, 'click', () => submit());
  listen(hideBtn, 'click', () => {
    userToggled = true;
    setCollapsed(true, { moveFocus: true, save: true });
  });
  listen(handle, 'click', () => {
    userToggled = true;
    setCollapsed(false, { moveFocus: true, save: true });
  });
  listen(openBtn, 'click', () => {
    void opts.send({ kind: 'overlay:open-app' }).catch(() => undefined);
  });
  listen(leaveBtn, 'click', () => {
    void opts.send({ kind: 'overlay:leave' }).catch(() => undefined);
  });

  if (view !== null) {
    listen(view, 'resize', () => {
      point = clampPoint(point, viewportOf());
      applyPoint();
    });
  }

  if (opts.followFullscreen !== false) {
    // A fullscreen element is painted above everything outside it, so an
    // overlay left in <body> simply disappears when the film goes fullscreen —
    // which is exactly when people are watching together. Moving the host is
    // safe: it is fixed-position and takes no clicks, so the player's own
    // layout cannot notice it.
    listen(doc, 'fullscreenchange', () => {
      if (destroyed) return;
      const target: Element = doc.fullscreenElement ?? container;
      if (host.parentNode !== target) target.appendChild(host);
    });
  }

  /* ── first paint ── */

  render(normalizeRoomState(opts.initialState));

  if (opts.initialState === undefined) {
    void opts
      .send({ kind: 'overlay:state' })
      .then((snapshot) => {
        if (destroyed || !isRecordLike(snapshot)) return;
        render(normalizeRoomState(snapshot));
      })
      .catch(() => undefined);
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
      render(normalizeRoomState(state));
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      endDrag();
      for (const off of disposers.splice(0)) off();
      host.remove();
    },
  };
}
