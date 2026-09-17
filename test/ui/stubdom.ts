/**
 * A recording DOM, enough for the world view's chrome.
 *
 * This project keeps no jsdom (see test/phone/keepui.test.ts), and the things
 * worth pinning about a line of type and a wavering ring — what it says, when
 * it arrives, what a thumb does to it, and whether it leaves — are all
 * observable on elements that simply remember what was set on them.
 *
 * Grown out of the stub in test/ui/size.test.ts, which pins the ball readout
 * the same way; this one adds the two things the onboarding screens need that
 * a readout does not: event listeners it can dispatch into, and a `window`
 * with a real `setTimeout` on it.
 */

export interface StubEl {
  tag: string;
  id: string;
  className: string;
  textContent: string;
  href: string;
  style: Record<string, string>;
  attrs: Record<string, string>;
  dataset: Record<string, string>;
  classes: Set<string>;
  classList: {
    add(name: string): void;
    remove(name: string): void;
    contains(name: string): boolean;
    toggle(name: string, on?: boolean): void;
  };
  children: StubEl[];
  parent: StubEl | null;
  listeners: Map<string, ((event: unknown) => void)[]>;
  offsetWidth: number;
  offsetHeight: number;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  appendChild(child: StubEl): StubEl;
  append(...kids: StubEl[]): void;
  addEventListener(type: string, fn: (event: unknown) => void): void;
  removeEventListener(type: string, fn: (event: unknown) => void): void;
  /** Fire a listener as the platform would, with a stoppable event. */
  fire(type: string, init?: Record<string, unknown>): void;
  remove(): void;
}

export function makeEl(tag: string): StubEl {
  const el: StubEl = {
    tag,
    id: '',
    className: '',
    textContent: '',
    href: '',
    style: {},
    attrs: {},
    dataset: {},
    classes: new Set<string>(),
    classList: {
      add: (name: string): void => void el.classes.add(name),
      remove: (name: string): void => void el.classes.delete(name),
      contains: (name: string): boolean => el.classes.has(name),
      toggle: (name: string, on?: boolean): void => {
        const next = on ?? !el.classes.has(name);
        if (next) el.classes.add(name);
        else el.classes.delete(name);
      },
    },
    children: [],
    parent: null,
    listeners: new Map(),
    offsetWidth: 0,
    offsetHeight: 0,
    setAttribute(name: string, value: string): void {
      el.attrs[name] = value;
      if (name === 'class') el.className = value;
    },
    getAttribute(name: string): string | null {
      return el.attrs[name] ?? null;
    },
    appendChild(child: StubEl): StubEl {
      child.parent = el;
      el.children.push(child);
      return child;
    },
    append(...kids: StubEl[]): void {
      for (const kid of kids) el.appendChild(kid);
    },
    addEventListener(type: string, fn: (event: unknown) => void): void {
      const list = el.listeners.get(type) ?? [];
      list.push(fn);
      el.listeners.set(type, list);
    },
    removeEventListener(type: string, fn: (event: unknown) => void): void {
      const list = el.listeners.get(type) ?? [];
      const at = list.indexOf(fn);
      if (at >= 0) list.splice(at, 1);
    },
    fire(type: string, init: Record<string, unknown> = {}): void {
      let stopped = false;
      const event = {
        type,
        target: el,
        preventDefault: (): void => {},
        stopPropagation: (): void => {
          stopped = true;
        },
        ...init,
      };
      for (const fn of [...(el.listeners.get(type) ?? [])]) fn(event);
      // Bubble to the ancestors that are listening, unless it was stopped —
      // which is exactly the behaviour the skip link relies on.
      let up = el.parent;
      while (up && !stopped) {
        for (const fn of [...(up.listeners.get(type) ?? [])]) fn({ ...event, target: el });
        up = up.parent;
      }
    },
    remove(): void {
      const at = el.parent?.children.indexOf(el) ?? -1;
      if (el.parent && at >= 0) el.parent.children.splice(at, 1);
      el.parent = null;
    },
  };
  return el;
}

/** Find the first descendant carrying `className` (as class or attribute). */
export function find(root: StubEl, className: string): StubEl | null {
  if (root.className === className || root.attrs['class'] === className) return root;
  for (const kid of root.children) {
    const hit = find(kid, className);
    if (hit) return hit;
  }
  return null;
}

/** Every descendant whose class list contains `name`. */
export function findAll(root: StubEl, name: string): StubEl[] {
  const out: StubEl[] = [];
  const walk = (el: StubEl): void => {
    const cls = el.className || el.attrs['class'] || '';
    if (cls.split(/\s+/).includes(name)) out.push(el);
    for (const kid of el.children) walk(kid);
  };
  walk(root);
  return out;
}

export interface StubDom {
  mount: StubEl;
  head: StubEl;
  /** Drain the queued animation frames, at `now`. */
  step(now: number): void;
  restore(): void;
}

/** An in-memory store that answers like `localStorage`. */
export function stubStore(seed: Record<string, string> = {}): {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  data: Record<string, string>;
} {
  const data: Record<string, string> = { ...seed };
  return {
    data,
    getItem: (key: string): string | null => data[key] ?? null,
    setItem: (key: string, value: string): void => void (data[key] = value),
    removeItem: (key: string): void => void delete data[key],
  };
}

export function stubDom(): StubDom {
  const head = makeEl('head');
  const mount = makeEl('body');
  const styles = new Map<string, StubEl>();
  let pending: FrameRequestCallback[] = [];

  const globals = globalThis as Record<string, unknown>;
  const before = {
    document: globals.document,
    window: globals.window,
    raf: globals.requestAnimationFrame,
    caf: globals.cancelAnimationFrame,
  };
  globals.document = {
    hidden: false,
    head,
    body: mount,
    getElementById: (id: string): StubEl | null => styles.get(id) ?? null,
    createElement: (tag: string): StubEl => {
      const el = makeEl(tag);
      if (tag === 'style') {
        // The sheet registers itself the way a real one does, so a second
        // install finds it and does not append a second copy.
        Object.defineProperty(el, 'id', {
          get: () => el.attrs['id'] ?? '',
          set: (value: string) => {
            el.attrs['id'] = value;
            styles.set(value, el);
          },
        });
      }
      return el;
    },
    createElementNS: (_ns: string, tag: string): StubEl => makeEl(tag),
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
  };
  globals.window = {
    setTimeout: (fn: () => void, ms?: number): unknown => setTimeout(fn, ms),
    clearTimeout: (handle: unknown): void => clearTimeout(handle as never),
    location: { reload: (): void => {}, href: '', search: '' },
  };
  globals.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    pending.push(cb);
    return pending.length;
  };
  globals.cancelAnimationFrame = (): void => {
    pending = [];
  };
  return {
    mount,
    head,
    step: (now: number): void => {
      const queued = pending;
      pending = [];
      for (const cb of queued) cb(now);
    },
    restore: (): void => {
      globals.document = before.document;
      globals.window = before.window;
      globals.requestAnimationFrame = before.raf;
      globals.cancelAnimationFrame = before.caf;
    },
  };
}
