/**
 * A hand-built DOM for the overlay tests.
 *
 * Owns: just enough of a page for `mountOverlay` to run in node — elements,
 * attributes, a closed shadow root, focus, and event propagation with capture,
 * bubbling and `stopPropagation` — plus the bookkeeping a test needs to ask
 * "did you leave anything behind?".
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
}

export class FakeEvent {
  readonly type: string;
  readonly bubbles: boolean;
  target: FakeEventTarget | null = null;
  currentTarget: FakeEventTarget | null = null;
  defaultPrevented = false;
  propagationStopped = false;
  readonly key: string;
  readonly shiftKey: boolean;
  readonly button: number;
  readonly clientX: number;
  readonly clientY: number;

  constructor(type: string, props: EventProps = {}) {
    this.type = type;
    this.bubbles = props.bubbles !== false;
    this.key = props.key ?? '';
    this.shiftKey = props.shiftKey === true;
    this.button = props.button ?? 0;
    this.clientX = props.clientX ?? 0;
    this.clientY = props.clientY ?? 0;
  }

  stopPropagation(): void {
    this.propagationStopped = true;
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
  private readonly attributes = new Map<string, string>();
  private closedShadow: FakeShadowRoot | null = null;

  constructor(tagName: string, ownerDocument: FakeDocument) {
    super();
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
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

  focus(): void {
    this.ownerDocument.activeElement = this;
  }
}

export class FakeShadowRoot extends FakeElement {
  readonly host: FakeElement;
  readonly mode: 'open' | 'closed';

  constructor(host: FakeElement, mode: 'open' | 'closed') {
    super('#shadow-root', host.ownerDocument);
    this.host = host;
    this.mode = mode;
  }
}

export class FakeDocument extends FakeEventTarget {
  readonly body: FakeElement;
  readonly documentElement: FakeElement;
  readonly defaultView: FakeWindow;
  readonly location: { hostname: string };
  fullscreenElement: FakeElement | null = null;
  activeElement: FakeElement | null = null;

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
  return null;
}

/**
 * Capture down, fire at the target, bubble back up — through the shadow
 * boundary, because that is exactly the path the overlay has to stop events on.
 */
export function dispatchOn(target: FakeElement, type: string, props: EventProps = {}): FakeEvent {
  const event = new FakeEvent(type, props);
  event.target = target;
  const path: FakeEventTarget[] = [];
  let node: FakeEventTarget | null = target;
  while (node !== null) {
    path.push(node);
    node = eventParentOf(node);
  }
  for (let i = path.length - 1; i >= 1; i -= 1) {
    if (event.propagationStopped) return event;
    path[i]?.fire(event, true, false);
  }
  if (!event.propagationStopped) target.fire(event, false, true);
  if (!event.bubbles) return event;
  for (let i = 1; i < path.length; i += 1) {
    if (event.propagationStopped) return event;
    path[i]?.fire(event, false, false);
  }
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
