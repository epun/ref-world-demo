/**
 * The save control on the companion: where it stands, and — the part that
 * was actually broken — whether a tap on it reaches the phone.
 *
 * User report, 2026-09-09: *"currently if I press those buttons on mobile
 * they don't do anything for saving."* The cause was not the share sheet,
 * the renderer or the file: it was ORDER. Every row rendered its file
 * first and called `navigator.share` / the download anchor / the clipboard
 * afterwards, by which time the tap's transient user activation had been
 * spent by the await, and all three are gated on it. So the tests that
 * matter here assert TIMING, not results: the browser call has to happen
 * in the same task as the click, before the first microtask after it.
 *
 * This project keeps no jsdom, so the DOM is a recording stub — small
 * enough to read, and it records the one thing under test (when a call
 * happened, relative to the click). The placement rules are pinned as
 * source facts and confirmed in a real browser.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  KEEP_DONE,
  KEEP_FAILED,
  KEEP_FEEDBACK_MS,
  KEEP_LABELS,
  KEEP_PREPARING,
  KEEP_TITLE,
  mountKeepUi,
  type KeepAction,
  type KeepUiHandle,
} from '../../src/phone/keepui';
import { MOTION } from '../../src/taste/tokens';

const src = (): string => readFileSync(join(process.cwd(), 'src/phone/keepui.ts'), 'utf8');

// ── the words ────────────────────────────────────────────────────────────────

describe('the menu says what the person asked for', () => {
  it('is photo, 3d model, link — in that order', () => {
    expect(Object.values(KEEP_LABELS)).toEqual(['photo', '3d model', 'link']);
  });

  it('renamed only the WORD, never the action key', () => {
    // `picture` is what the filename helper, the result callback and every
    // caller already call it. A rename of the key would have been a
    // rename of the protocol between this module and its callers, for a
    // change that is one string on one screen.
    expect(Object.keys(KEEP_LABELS)).toEqual(['picture', 'model', 'link']);
    expect(KEEP_LABELS.picture).toBe('photo');
  });

  it('is lowercase, title included — no uppercase type anywhere', () => {
    expect(KEEP_TITLE).toBe('save as');
    for (const text of [
      KEEP_TITLE,
      KEEP_PREPARING,
      KEEP_FAILED,
      ...Object.values(KEEP_LABELS),
      ...Object.values(KEEP_DONE),
    ]) {
      expect(text).toBe(text.toLowerCase());
    }
  });

  it('takes its feedback dwell from the motion tokens, never a literal', () => {
    expect(KEEP_FEEDBACK_MS).toBe(MOTION.primaryMs);
  });
});

// ── where it stands ──────────────────────────────────────────────────────────

describe('the mark stands in the screen’s corner, outside the device', () => {
  it('is fixed to the viewport at the tray’s own gutters', () => {
    // User ask, 2026-09-09: the top right corner OUTSIDE the device. Fixed
    // to the screen, not placed in the stage's corner slot — which is
    // inside the screen well, over the creature.
    expect(src()).toMatch(/\.keep-mark \{[\s\S]{0,900}?position: fixed/);
    expect(src()).toMatch(/GUTTER_TOP = 'calc\(env\(safe-area-inset-top, 0px\) \+ 3vw\)'/);
    expect(src()).toMatch(/GUTTER_RIGHT = '4vw'/);
    expect(src()).toMatch(/\.keep-mark \{[\s\S]{0,900}?top: \$\{GUTTER_TOP\}/);
    expect(src()).toMatch(/\.keep-mark \{[\s\S]{0,900}?right: \$\{GUTTER_RIGHT\}/);
  });

  it('is thumb-sized and clamped', () => {
    expect(src()).toMatch(/MARK_SIZE = 'clamp\(40px, 11vw, 56px\)'/);
  });

  it('is mounted on the PAGE, because the stage is a transformed box', () => {
    // A `position: fixed` child of a transformed ancestor is fixed to that
    // ancestor. The stage carries the ambient drift transform every frame
    // (src/phone/states.ts), so a mark mounted inside it would ride the
    // drift and sit in the stage's corner rather than the screen's.
    const alive = readFileSync(join(process.cwd(), 'src/phone/screens/alive.ts'), 'utf8');
    expect(alive).toMatch(/mount: document\.body/);
    expect(alive).not.toMatch(/slots\.corner\.appendChild\(keep/);
  });
});

describe('the popover is paper inside a hairline, and slides', () => {
  it('is anchored under the mark and right-aligned to it', () => {
    expect(src()).toMatch(/\.keep-menu \{[\s\S]{0,900}?position: fixed/);
    expect(src()).toMatch(/MENU_TOP = `calc\(\$\{GUTTER_TOP\} \+ \$\{MARK_SIZE\} \+ 2vw\)`/);
    expect(src()).toMatch(/\.keep-menu \{[\s\S]{0,900}?right: \$\{GUTTER_RIGHT\}/);
  });

  it('slides in from the mark on the settle curve — it never pops', () => {
    expect(src()).toMatch(/MENU_TRAVEL_PX = 8/);
    expect(src()).toMatch(/\.keep-menu \{[\s\S]{0,900}?transform: translateY\(-\$\{MENU_TRAVEL_PX\}px\)/);
    expect(src()).toMatch(
      /\.keep-menu \{[\s\S]{0,900}?transition:\s*opacity \$\{MOTION\.secondaryMs\}ms \$\{MOTION\.settleCurve\}/,
    );
    // …and the mark arrives the same way, rather than appearing.
    expect(src()).toMatch(/\.keep-mark \{[\s\S]{0,900}?transform: translateY\(-\$\{MENU_TRAVEL_PX\}px\)/);
  });

  it('is paper and a border and nothing else — no card, no shadow, no tint', () => {
    // TASTE §4: icon + ruleLine + border. The ground is the paper the whole
    // flow is painted on; the rules and the wavered outline are the marks.
    expect(src()).toMatch(/\.keep-menu \{[\s\S]{0,900}?background: transparent/);
    expect(src()).not.toMatch(/box-shadow|filter: drop-shadow|backdrop-filter/);
    expect(src()).not.toMatch(/border-radius/);
    expect(src()).toMatch(/border-bottom: 1px solid \$\{WORLD\.ink\}/);
    expect(src()).toMatch(/border-top: 1px solid \$\{WORLD\.ink\}/);
    // The border is the project's own wavering loop, the same hand as the
    // minimap's frame and the stick's rings.
    expect(src()).toMatch(/wavyBorderPath\(wavyBorderPoints\(100, 100, 2, MENU_SEED, 10\)\)/);
  });

  it('fills the WAVERED SHAPE, never a rectangle behind it', () => {
    // User report, 2026-09-09: *"the fill for the sub menu … should not have
    // any parts that extend beyond the border"*. A `background` on the
    // element is a rectangle, and a rectangle behind a wobbly outline shows
    // its four straight edges outside the wobble. One path, filled and
    // stroked, cannot: the paper ends exactly where the line is.
    expect(src()).toMatch(
      /\.keep-menu-border path \{[\s\S]{0,260}?fill: \$\{SURFACE\.ground\}[\s\S]{0,80}?stroke: \$\{WORLD\.ink\}/,
    );
    // …and nothing rounds a rectangle off as a stand-in for the shape.
    expect(src()).not.toMatch(/border-radius/);
  });

  it('draws a DISKETTE — cut corner, shutter, window, label', () => {
    // User ask, 2026-09-09: *"the icon for the floppy save should look more
    // like a floppy disk"*. The first pass was a square with two rectangles
    // in it, which is a diskette only if you already know.
    expect(src()).toMatch(/function floppy\(\)/);
    expect(src()).toMatch(/const body = path\(/);
    expect(src()).toMatch(/const shutter = path\(wavyBorderPath\(wavyLoop\(boxCorners\(/);
    expect(src()).toMatch(/const slot = path\(wavyBorderPath\(wavyLoop\(boxCorners\(/);
    expect(src()).toMatch(/const label = path\(wavyBorderPath\(wavyLoop\(boxCorners\(/);
    // The body is a FIVE-cornered loop: the cut corner is part of the
    // outline, not a second stroke laid over a square.
    const corners = /wavyLoop\(\s*\[([\s\S]*?)\],\s*BODY_SEED/.exec(src());
    expect(corners, 'the body is no longer an explicit corner list').toBeTruthy();
    expect(corners![1]!.match(/\[\s*\d+,\s*\d+\s*\]/g)).toHaveLength(5);
    // Strokes only, with the one paper-light label strip.
    expect(src()).toMatch(/\.keep-mark path \{[\s\S]{0,900}?fill: none/);
    expect(src()).toMatch(/\.keep-mark path\[data-fill='paper'\] \{ fill: \$\{WORLD\.light\}/);
    // The window would close on itself at the full amplitude.
    expect(src()).toMatch(/SLOT_WAVER = 0\.5/);
  });
});

describe('the companion frame is allowed to save', () => {
  it('delegates web share and the clipboard to the panel’s iframe', () => {
    // Same-origin is not enough: `web-share` and `clipboard-write` default
    // to `self`, which is the TOP document. A frame that is not named in
    // an `allow` gets neither, and every save inside it silently failed.
    const panel = readFileSync(join(process.cwd(), 'src/world/companionpanel.ts'), 'utf8');
    expect(panel).toMatch(/setAttribute\('allow', 'web-share; clipboard-write'\)/);
  });
});

// ── a DOM small enough to read ───────────────────────────────────────────────

type Listener = (event: unknown) => void;

class El {
  className = '';
  textContent = '';
  type = '';
  disabled = false;
  readonly dataset: Record<string, string> = {};
  readonly attrs: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly children: El[] = [];
  parent: El | null = null;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly tag: string) {}

  append(...kids: El[]): void {
    for (const kid of kids) this.appendChild(kid);
  }
  appendChild(kid: El): El {
    kid.parent = this;
    this.children.push(kid);
    return kid;
  }
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    const at = list.indexOf(fn);
    if (at >= 0) list.splice(at, 1);
  }
  remove(): void {
    const at = this.parent?.children.indexOf(this) ?? -1;
    if (at >= 0) this.parent!.children.splice(at, 1);
    this.parent = null;
  }
  contains(node: unknown): boolean {
    if (node === this) return true;
    return this.children.some((kid) => kid.contains(node));
  }
  /** Fire a listener set, exactly as a real dispatch would. */
  fire(type: string, event: Record<string, unknown>): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
  }
  /** Depth-first find, by class. */
  find(className: string): El[] {
    const out: El[] = this.className === className ? [this] : [];
    for (const kid of this.children) out.push(...kid.find(className));
    return out;
  }
}

interface Stub {
  host: El;
  windowListeners: Map<string, Listener[]>;
  restore(): void;
}

function stubDom(navigatorStub: Record<string, unknown>): Stub {
  const globals = globalThis as Record<string, unknown>;
  const before = {
    document: Object.getOwnPropertyDescriptor(globals, 'document'),
    window: Object.getOwnPropertyDescriptor(globals, 'window'),
    navigator: Object.getOwnPropertyDescriptor(globals, 'navigator'),
    location: Object.getOwnPropertyDescriptor(globals, 'location'),
    node: Object.getOwnPropertyDescriptor(globals, 'Node'),
    raf: Object.getOwnPropertyDescriptor(globals, 'requestAnimationFrame'),
    caf: Object.getOwnPropertyDescriptor(globals, 'cancelAnimationFrame'),
  };
  const set = (name: string, value: unknown): void => {
    Object.defineProperty(globals, name, { value, configurable: true, writable: true });
  };

  const head = new El('head');
  const body = new El('body');
  const windowListeners = new Map<string, Listener[]>();
  const timers = new Map<number, NodeJS.Timeout>();
  let nextTimer = 1;

  set('document', {
    head,
    body,
    hidden: false,
    getElementById: () => null,
    createElement: (tag: string) => new El(tag),
    createElementNS: (_ns: string, tag: string) => new El(tag),
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
  });
  set('window', {
    addEventListener: (type: string, fn: Listener): void => {
      const list = windowListeners.get(type) ?? [];
      list.push(fn);
      windowListeners.set(type, list);
    },
    removeEventListener: (type: string, fn: Listener): void => {
      const list = windowListeners.get(type) ?? [];
      const at = list.indexOf(fn);
      if (at >= 0) list.splice(at, 1);
    },
    setTimeout: (fn: () => void, ms: number): number => {
      const id = nextTimer++;
      timers.set(id, setTimeout(fn, ms));
      return id;
    },
    clearTimeout: (id: number): void => {
      const t = timers.get(id);
      if (t) clearTimeout(t);
      timers.delete(id);
    },
    // No requestIdleCallback: the mount-time prepare falls back to a timer,
    // which destroy() clears. The popover's own prepare is the path under
    // test anyway.
  });
  set('navigator', navigatorStub);
  set('location', { origin: 'https://ref.test' });
  set('Node', El);
  // Two frames, immediately: the entrance flag is not what is under test
  // and a pending rAF would outlive the stub.
  set('requestAnimationFrame', (cb: () => void): number => {
    cb();
    return 1;
  });
  set('cancelAnimationFrame', (): void => {});

  return {
    host: body,
    windowListeners,
    restore(): void {
      for (const t of timers.values()) clearTimeout(t);
      for (const [name, desc] of Object.entries(before)) {
        const key = name === 'node' ? 'Node' : name === 'raf'
          ? 'requestAnimationFrame'
          : name === 'caf'
            ? 'cancelAnimationFrame'
            : name;
        if (desc) Object.defineProperty(globals, key, desc);
        else delete globals[key];
      }
    },
  };
}

/** Let every already-resolved promise settle. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

let live: { handle: KeepUiHandle; dom: Stub } | null = null;
afterEach(() => {
  live?.handle.destroy();
  live?.dom.restore();
  live = null;
});

interface MountedUi {
  handle: KeepUiHandle;
  dom: Stub;
  row(action: KeepAction): El;
  label(action: KeepAction): string;
  click(action: KeepAction): void;
}

function mount(
  navigatorStub: Record<string, unknown>,
  options: {
    world?: string | null;
    build?: (action: 'picture' | 'model') => Promise<Blob | null>;
    onResult?: (action: KeepAction, ok: boolean) => void;
  } = {},
): MountedUi {
  const dom = stubDom(navigatorStub);
  const handle = mountKeepUi({
    strokes: [],
    identity: 'd3f2a1',
    name: () => 'wonder',
    world: options.world === undefined ? 'public' : options.world,
    mount: dom.host as unknown as HTMLElement,
    build: options.build ?? ((): Promise<Blob | null> => Promise.resolve(null)),
    ...(options.onResult ? { onResult: options.onResult } : {}),
  });
  live = { handle, dom };
  const menu = handle.menu as unknown as El;
  const rows = menu.find('keep-row');
  const order: KeepAction[] = options.world === null ? ['picture', 'model'] : ['picture', 'model', 'link'];
  const row = (action: KeepAction): El => {
    const at = order.indexOf(action);
    const found = rows[at];
    if (!found) throw new Error(`no row for ${action}`);
    return found;
  };
  return {
    handle,
    dom,
    row,
    label: (action) => String(row(action).children[0]?.textContent ?? ''),
    click: (action) => row(action).fire('click', { stopPropagation: () => {} }),
  };
}

// ── the tap ──────────────────────────────────────────────────────────────────

describe('a tap hands the file to the phone inside the tap', () => {
  it('calls share in the SAME TASK as the click, before any microtask', async () => {
    // This is the whole bug. `share` is gated on the tap's transient user
    // activation, and the first await that takes real time spends it — so
    // the render cannot be in front of it. Nothing else in this file
    // matters if this does not hold.
    const shared: { files?: File[] }[] = [];
    const ui = mount({
      canShare: () => true,
      share: (data: { files?: File[] }) => {
        shared.push(data);
        return Promise.resolve();
      },
    }, {
      build: () => Promise.resolve(new Blob(['png'], { type: 'image/png' })),
    });

    ui.handle.setOpen(true);
    await flush();

    let microtaskRan = false;
    ui.click('picture');
    queueMicrotask(() => {
      microtaskRan = true;
    });
    // Both read synchronously, before control has left this task.
    expect(shared).toHaveLength(1);
    expect(microtaskRan).toBe(false);
    // …and it is the real file, named the way a person can find it again.
    expect(shared[0]!.files?.[0]?.name).toBe('refworld-wonder-d3f2a1.png');
  });

  it('says so when the file is not built yet, and delivers on the next tap', async () => {
    // Late is not an option: a delivery that lands after the activation
    // expires is a delivery that does not happen. So the row asks to be
    // asked again, and the render it kicks off makes the second ask work.
    let settle: (blob: Blob) => void = () => {};
    const shared: unknown[] = [];
    const ui = mount({
      canShare: () => true,
      share: (data: unknown) => {
        shared.push(data);
        return Promise.resolve();
      },
    }, {
      build: () => new Promise<Blob | null>((resolve) => {
        settle = resolve;
      }),
    });

    ui.handle.setOpen(true);
    ui.click('model');
    expect(shared).toHaveLength(0);
    expect(ui.label('model')).toBe(KEEP_PREPARING);

    settle(new Blob(['glb'], { type: 'model/gltf-binary' }));
    await flush();
    ui.click('model');
    expect(shared).toHaveLength(1);
  });

  it('reports the result in the row and then closes the popover', async () => {
    const results: [KeepAction, boolean][] = [];
    const ui = mount({
      canShare: () => true,
      share: () => Promise.resolve(),
    }, {
      build: () => Promise.resolve(new Blob(['png'], { type: 'image/png' })),
      onResult: (action, ok) => results.push([action, ok]),
    });
    ui.handle.setOpen(true);
    await flush();
    ui.click('picture');
    await flush();
    expect(results).toEqual([['picture', true]]);
    expect(ui.label('picture')).toBe(KEEP_DONE.picture);
    // Still open while the word is being read — it closes on the feedback
    // timer, not on the tap.
    expect(ui.handle.open()).toBe(true);
  });
});

describe('the link goes to the clipboard, in the tap', () => {
  const clipboardStub = (
    onWrite: (url: string) => Promise<void>,
  ): Record<string, unknown> => ({
    clipboard: { writeText: onWrite },
  });

  it('writes the keep url synchronously and says copied', async () => {
    const written: string[] = [];
    const ui = mount(
      clipboardStub((url) => {
        written.push(url);
        return Promise.resolve();
      }),
    );
    ui.handle.setOpen(true);
    ui.click('link');
    // Synchronously — same rule as the share sheet.
    expect(written).toEqual(['https://ref.test/?world=public&keep=d3f2a1']);
    await flush();
    expect(ui.label('link')).toBe(KEEP_DONE.link);
  });

  it('falls back to the share sheet when the clipboard refuses', async () => {
    const shared: { url?: string }[] = [];
    const ui = mount({
      clipboard: { writeText: () => Promise.reject(new Error('denied')) },
      share: (data: { url?: string }) => {
        shared.push(data);
        return Promise.resolve();
      },
    });
    ui.handle.setOpen(true);
    ui.click('link');
    await flush();
    expect(shared[0]?.url).toBe('https://ref.test/?world=public&keep=d3f2a1');
    expect(ui.label('link')).toBe(KEEP_DONE.link);
  });

  it('reveals the url to be copied by hand when neither route exists', async () => {
    const ui = mount({});
    ui.handle.setOpen(true);
    ui.click('link');
    await flush();
    // Not `try again`: there is nothing to try. The url itself is the
    // answer, on screen, selectable.
    expect(ui.label('link')).toBe('https://ref.test/?world=public&keep=d3f2a1');
    expect(src()).toMatch(/user-select: text/);
  });

  it('is not offered at all without a shared world', () => {
    // A link into a world that does not persist is a promise this cannot
    // keep. The file exports need no world and stay.
    const ui = mount({}, { world: null });
    const rows = (ui.handle.menu as unknown as El).find('keep-row');
    expect(rows).toHaveLength(2);
  });
});

describe('opening and closing', () => {
  it('opens on the mark and closes on escape', () => {
    const ui = mount({});
    const mark = ui.handle.mark as unknown as El;
    expect(mark.getAttribute('aria-label')).toBe('save');
    mark.fire('click', { stopPropagation: () => {} });
    expect(ui.handle.open()).toBe(true);
    for (const fn of ui.dom.windowListeners.get('keydown') ?? []) fn({ key: 'Escape' });
    expect(ui.handle.open()).toBe(false);
  });

  it('closes on a tap outside, and that tap goes no further', () => {
    // The world beneath is the drag that turns the creature. A tap that
    // dismisses a popover must not also spin the thing behind it.
    const ui = mount({});
    ui.handle.setOpen(true);
    let stopped = 0;
    let prevented = 0;
    const elsewhere = new El('div');
    for (const fn of ui.dom.windowListeners.get('pointerdown') ?? []) {
      fn({
        target: elsewhere,
        stopPropagation: () => stopped++,
        preventDefault: () => prevented++,
      });
    }
    expect(ui.handle.open()).toBe(false);
    expect(stopped).toBe(1);
    expect(prevented).toBe(1);
  });

  it('leaves nothing on the page when it is destroyed', () => {
    const ui = mount({});
    expect(ui.dom.host.children.length).toBe(2);
    ui.handle.destroy();
    expect(ui.dom.host.children.length).toBe(0);
    expect(ui.dom.windowListeners.get('pointerdown')).toHaveLength(0);
    expect(ui.dom.windowListeners.get('keydown')).toHaveLength(0);
  });
});
