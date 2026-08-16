/**
 * A hand-built DOM for the overlay tests.
 *
 * Owns: just enough of a page for `mountOverlay` to run in node — elements,
 * attributes, a closed shadow root, focus, the top layer, and event propagation
 * from the window down and back with capture, bubbling and both kinds of
 * `stopPropagation` — plus the bookkeeping a test needs to ask "did you leave
 * anything behind?".
 *
 * Two details are modelled because the overlay's isolation stands or falls on
 * them: the WINDOW is the first thing on an event's way down (which is where a
 * player registers when it means to win), and an event that started inside a
 * closed shadow root tells everything outside it that the HOST fired it.
 *
 * Deliberately NOT: a browser. There is no layout, no CSS, and no HTML parser
 * — which is the point of two of these tests. `innerHTML` THROWS here on
 * purpose: the overlay must build nodes and set `textContent`, so any drift
 * towards string HTML fails the suite instead of shipping an injection into
 * every site the extension runs on.
 *
 * (The workspace has no jsdom and this file adds no dependency. It is a test
 * helper, not a shim for the source to lean on.)
 */

export interface EventProps {
  bubbles?: boolean;
  key?: string;
  shiftKey?: boolean;
  button?: number;
  clientX?: number;
  clientY?: number;
  /** How many clicks. Zero is what a browser sends for a button worked by key. */
  detail?: number;
  /** The key is part of a word an input method is still assembling. */
  isComposing?: boolean;
  /** The old spelling of the same fact, which some browsers still send. */
  keyCode?: number;
}

export class FakeEvent {
  readonly type: string;
  readonly bubbles: boolean;
  target: FakeEventTarget | null = null;
  currentTarget: FakeEventTarget | null = null;
  defaultPrevented = false;
  propagationStopped = false;
  immediatePropagationStopped = false;
  readonly key: string;
  readonly shiftKey: boolean;
  readonly button: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly detail: number;
  readonly isComposing: boolean;
  readonly keyCode: number;

  constructor(type: string, props: EventProps = {}) {
    this.type = type;
    this.bubbles = props.bubbles !== false;
    this.key = props.key ?? '';
    this.shiftKey = props.shiftKey === true;
    this.button = props.button ?? 0;
    this.clientX = props.clientX ?? 0;
    this.clientY = props.clientY ?? 0;
    this.detail = props.detail ?? 1;
    this.isComposing = props.isComposing === true;
    this.keyCode = props.keyCode ?? 0;
  }

  stopPropagation(): void {
    this.propagationStopped = true;
  }

  /** Also silences the listeners registered after this one on the same target. */
  stopImmediatePropagation(): void {
    this.propagationStopped = true;
    this.immediatePropagationStopped = true;
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

type Listener = (ev: FakeEvent) => void;

interface Registration {
  type: string;
  listener: Listener;
  capture: boolean;
}

export class FakeEventTarget {
  readonly registrations: Registration[] = [];

  addEventListener(type: string, listener: Listener, capture: boolean | undefined = false): void {
    this.registrations.push({ type, listener, capture: capture === true });
  }

  removeEventListener(
    type: string,
    listener: Listener,
    capture: boolean | undefined = false,
  ): void {
    const index = this.registrations.findIndex(
      (r) => r.type === type && r.listener === listener && r.capture === (capture === true),
    );
    if (index >= 0) this.registrations.splice(index, 1);
  }

  /** How many listeners are still attached — the leak check after destroy(). */
  listenerCount(): number {
    return this.registrations.length;
  }

  fire(event: FakeEvent, capturing: boolean, atTarget: boolean): void {
    for (const registration of [...this.registrations]) {
      if (event.immediatePropagationStopped) return;
      if (registration.type !== event.type) continue;
      if (!atTarget && registration.capture !== capturing) continue;
      event.currentTarget = this;
      registration.listener(event);
    }
  }
}

export class FakeStyle {
  private readonly values = new Map<string, { value: string; priority: string }>();

  setProperty(name: string, value: string, priority = ''): void {
    this.values.set(name, { value, priority });
  }

  getPropertyValue(name: string): string {
    return this.values.get(name)?.value ?? '';
  }

  getPropertyPriority(name: string): string {
    return this.values.get(name)?.priority ?? '';
  }
}

export class FakeText {
  data: string;
  parentNode: FakeElement | null = null;

  constructor(data: string) {
    this.data = data;
  }
}

export type FakeChild = FakeElement | FakeText;

export class FakeElement extends FakeEventTarget {
  readonly tagName: string;
  className = '';
  hidden = false;
  disabled = false;
  value = '';
  readonly style = new FakeStyle();
  readonly childNodes: FakeChild[] = [];
  parentNode: FakeElement | FakeDocument | null = null;
  /** Null for a closed root — exactly what a page sees. */
  shadowRoot: FakeShadowRoot | null = null;
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  readonly ownerDocument: FakeDocument;
  /** In the page's top layer, painted above whatever went fullscreen. */
  popoverOpen = false;
  /** Absent on a browser too old for the top layer — which the overlay checks. */
  showPopover?: () => void;
  hidePopover?: () => void;
  private readonly attributes = new Map<string, string>();
  private closedShadow: FakeShadowRoot | null = null;

  constructor(tagName: string, ownerDocument: FakeDocument) {
    super();
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    if (ownerDocument.popoverSupport) {
      this.showPopover = (): void => {
        if (!this.hasAttribute('popover')) throw new Error('not a popover');
        this.popoverOpen = true;
      };
      this.hidePopover = (): void => {
        this.popoverOpen = false;
      };
    }
  }

  /** The overlay must never assign HTML. Failing loudly here is the test. */
  set innerHTML(_value: string) {
    throw new Error('the overlay must build nodes, never assign innerHTML');
  }

  attachShadow(init: { mode: 'open' | 'closed' }): FakeShadowRoot {
    const root = new FakeShadowRoot(this, init.mode);
    this.closedShadow = root;
    this.shadowRoot = init.mode === 'open' ? root : null;
    return root;
  }

  /** Only a test may look inside a closed root; a page cannot. */
  peekShadow(): FakeShadowRoot | null {
    return this.closedShadow;
  }

  appendChild<T extends FakeChild>(child: T): T {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild<T extends FakeChild>(child: T): T {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  remove(): void {
    const parent = this.parentNode;
    if (parent instanceof FakeElement) parent.removeChild(this);
    else if (parent instanceof FakeDocument) parent.removeChild(this);
    this.parentNode = null;
  }

  get textContent(): string {
    let out = '';
    for (const child of this.childNodes) {
      out += child instanceof FakeText ? child.data : child.textContent;
    }
    return out;
  }

  set textContent(value: string) {
    for (const child of [...this.childNodes]) this.removeChild(child);
    if (value.length > 0) this.appendChild(new FakeText(value));
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  contains(other: FakeElement | null): boolean {
    let node: FakeElement | FakeDocument | null = other;
    while (node instanceof FakeElement) {
      if (node === this) return true;
      node = node.parentNode;
    }
    return false;
  }

  /** The shadow tree this node lives in, if it lives in one. */
  shadowHome(): FakeShadowRoot | null {
    if (this instanceof FakeShadowRoot) return this;
    let node: FakeElement | FakeDocument | null = this.parentNode;
    while (node instanceof FakeElement) {
      if (node instanceof FakeShadowRoot) return node;
      node = node.parentNode;
    }
    return null;
  }

  focus(): void {
    const home = this.shadowHome();
    if (home === null) {
      this.ownerDocument.activeElement = this;
      return;
    }
    home.activeElement = this;
    // A closed root hides its nodes: the page is told the HOST has focus, which
    // is all it is ever told about anything of ours.
    this.ownerDocument.activeElement = home.host;
  }
}

export class FakeShadowRoot extends FakeElement {
  readonly host: FakeElement;
  readonly mode: 'open' | 'closed';
  /** Which node inside this tree has focus. Only the root's owner may ask. */
  activeElement: FakeElement | null = null;
  /**
   * What the browser's hit test would find. There is no layout here, so a
   * dispatch says where the pointer landed instead of a rectangle deciding.
   */
  hitTarget: FakeElement | null = null;

  constructor(host: FakeElement, mode: 'open' | 'closed') {
    super('#shadow-root', host.ownerDocument);
    this.host = host;
    this.mode = mode;
  }

  elementFromPoint(_x: number, _y: number): FakeElement | null {
    return this.hitTarget;
  }
}

export class FakeDocument extends FakeEventTarget {
  readonly body: FakeElement;
  readonly documentElement: FakeElement;
  readonly defaultView: FakeWindow;
  readonly location: { hostname: string };
  fullscreenElement: FakeElement | null = null;
  activeElement: FakeElement | null = null;
  /** Chrome grew the top layer in 114. Set false to be an older browser. */
  popoverSupport = true;

  constructor(hostname = 'example.com', width = 1280, height = 720) {
    super();
    this.defaultView = new FakeWindow(width, height);
    this.location = { hostname };
    this.documentElement = new FakeElement('html', this);
    this.documentElement.parentNode = this;
    this.body = new FakeElement('body', this);
    this.body.parentNode = this.documentElement;
    this.documentElement.childNodes.push(this.body);
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }

  removeChild<T extends FakeChild>(child: T): T {
    child.parentNode = null;
    return child;
  }
}

export class FakeWindow extends FakeEventTarget {
  innerWidth: number;
  innerHeight: number;

  constructor(innerWidth: number, innerHeight: number) {
    super();
    this.innerWidth = innerWidth;
    this.innerHeight = innerHeight;
  }
}

/* ─────────────────────────── event propagation ───────────────────────────── */

function eventParentOf(node: FakeEventTarget): FakeEventTarget | null {
  if (node instanceof FakeShadowRoot) return node.host;
  if (node instanceof FakeElement) return node.parentNode;
  if (node instanceof FakeDocument) return node.defaultView;
  return null;
}

/**
 * Capture down from the WINDOW, fire at the target, bubble back up — through
 * the shadow boundary, because that is exactly the path the overlay has to stop
 * events on, and the window is exactly where a player registers when it wants
 * to be first.
 *
 * Outside the shadow tree the event says it came from the HOST, the way a
 * browser retargets it. That is the only thing the page is ever told about
 * which of our controls was used.
 */
export function dispatchOn(target: FakeElement, type: string, props: EventProps = {}): FakeEvent {
  const event = new FakeEvent(type, props);
  const path: FakeEventTarget[] = [];
  let node: FakeEventTarget | null = target;
  while (node !== null) {
    path.push(node);
    node = eventParentOf(node);
  }
  const rootIndex = path.findIndex((entry) => entry instanceof FakeShadowRoot);
  const fromOutside = rootIndex >= 0 ? (path[rootIndex + 1] ?? target) : target;
  const seenBy = (index: number): FakeEventTarget =>
    rootIndex >= 0 && index > rootIndex ? fromOutside : target;

  const run = (): void => {
    for (let i = path.length - 1; i >= 1; i -= 1) {
      if (event.propagationStopped) return;
      event.target = seenBy(i);
      path[i]?.fire(event, true, false);
    }
    if (!event.propagationStopped) {
      event.target = target;
      target.fire(event, false, true);
    }
    if (!event.bubbles) return;
    for (let i = 1; i < path.length; i += 1) {
      if (event.propagationStopped) return;
      event.target = seenBy(i);
      path[i]?.fire(event, false, false);
    }
  };

  run();
  event.target = target;
  return event;
}

/* ─────────────────────────────── test queries ────────────────────────────── */

/** Every element under `root`, including everything inside its shadow roots. */
export function allElements(root: FakeElement): FakeElement[] {
  const out: FakeElement[] = [];
  const visit = (node: FakeElement): void => {
    out.push(node);
    const shadow = node.peekShadow();
    if (shadow !== null) visit(shadow);
    for (const child of node.childNodes) {
      if (child instanceof FakeElement) visit(child);
    }
  };
  visit(root);
  return out;
}

/** What the PAGE can see: the same walk, stopping at every shadow boundary. */
export function pageElements(root: FakeElement): FakeElement[] {
  const out: FakeElement[] = [];
  const visit = (node: FakeElement): void => {
    out.push(node);
    for (const child of node.childNodes) {
      if (child instanceof FakeElement) visit(child);
    }
  };
  visit(root);
  return out;
}

export function byClass(root: FakeElement, className: string): FakeElement[] {
  return allElements(root).filter((el) => el.className.split(' ').includes(className));
}

export function oneByClass(root: FakeElement, className: string): FakeElement {
  const found = byClass(root, className);
  if (found.length !== 1) {
    throw new Error(`expected exactly one .${className}, found ${found.length}`);
  }
  return found[0] as FakeElement;
}
