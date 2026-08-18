/**
 * Haptics on the handset, for the one moment that earns them: the egg
 * hatching in your hand.
 *
 * TWO transports, because the web has no single one that works everywhere:
 *
 *   1. The Vibration API (`navigator.vibrate`). Android Chrome, Firefox.
 *      Takes a real pattern, so the hatch reads as crack-pause-out.
 *      Safari has never shipped it — on an iPhone this is simply absent.
 *
 *   2. The iOS switch trick. Safari 17.4+ renders
 *      `<input type="checkbox" switch>` as a native iOS switch, and
 *      toggling one through its <label> plays the system's own toggle
 *      haptic. It is the only route to the Taptic Engine from a web page.
 *      It is a SINGLE tick with no duration control — the pattern is
 *      unrepresentable, so the iPhone gets one tap where Android gets
 *      three. That is the honest ceiling, not a bug to tune.
 *
 * Both are best-effort and both can silently do nothing. The iOS one in
 * particular depends on Settings → Sounds & Haptics → System Haptics being
 * on, is suppressed in Low Power Mode, and — like every haptic on the web —
 * needs the page to have been engaged by the person first, which the draw
 * and send taps satisfy in the normal flow. `describeHaptics()` reports
 * which transport a given handset actually has, so a silent phone can be
 * diagnosed rather than guessed at (see public/haptics/).
 *
 * NOTE on durations: these are NOT motion tokens. The token scale starts
 * at t.tertiary (456ms), and a 456ms buzz is a phone ringing, not a tick.
 * Haptic lengths are physical — a few tens of milliseconds is the whole
 * vocabulary — so they are their own small constants, named and explained
 * here rather than borrowed from a scale that means something else.
 */

/** The hatch: a light crack, a pause, then a fuller one as it comes out.
 * 120ms end to end — felt as one gesture, never a buzz. */
export const HATCH_PATTERN: readonly number[] = [16, 70, 34];

/** The slice of navigator we use; injectable so tests need no browser. */
export interface VibrateLike {
  vibrate?(pattern: number | number[]): boolean;
}

/** Which transport a handset actually has. */
export type HapticTransport = 'vibration-api' | 'ios-switch' | 'none';

function target(nav?: VibrateLike): VibrateLike | null {
  const n = nav ?? (globalThis as { navigator?: VibrateLike }).navigator;
  if (!n || typeof n.vibrate !== 'function') return null;
  return n;
}

/** Can this handset buzz through the Vibration API? False on every iPhone. */
export function canVibrate(nav?: VibrateLike): boolean {
  return target(nav) !== null;
}

/**
 * Does this engine render `<input type="checkbox" switch>` as a switch?
 * Safari 17.4+ reflects the attribute as a live IDL property; engines that
 * do not know it leave the property undefined. Feature detection, never a
 * user-agent sniff — a UA string is a guess and this is checkable.
 */
export function canSwitchHaptic(doc?: Document): boolean {
  const d = doc ?? (globalThis as { document?: Document }).document;
  if (!d || typeof d.createElement !== 'function') return false;
  try {
    const probe = d.createElement('input');
    probe.setAttribute('type', 'checkbox');
    return 'switch' in probe;
  } catch {
    return false;
  }
}

/** The transport this handset will actually use. */
export function hapticTransport(nav?: VibrateLike, doc?: Document): HapticTransport {
  if (canVibrate(nav)) return 'vibration-api';
  if (canSwitchHaptic(doc)) return 'ios-switch';
  return 'none';
}

/** One line for the diagnostic page and the dev readout. */
export function describeHaptics(nav?: VibrateLike, doc?: Document): string {
  switch (hapticTransport(nav, doc)) {
    case 'vibration-api':
      return 'vibration api — full pattern';
    case 'ios-switch':
      return 'ios switch — one tick, no pattern';
    default:
      return 'none — this handset cannot buzz from a web page';
  }
}

const SWITCH_ID = 'refworld-haptic-switch';

/**
 * The hidden switch. It must be RENDERED to play its haptic — `display:
 * none` and `visibility: hidden` both silence it — so it is parked
 * off-screen at zero opacity instead, inert to touch and to the a11y tree.
 */
function switchElement(doc: Document): HTMLElement | null {
  const existing = doc.getElementById(SWITCH_ID);
  if (existing) return existing;
  const body = doc.body;
  if (!body) return null;
  try {
    const label = doc.createElement('label');
    label.id = SWITCH_ID;
    label.setAttribute('aria-hidden', 'true');
    label.style.cssText =
      'position:fixed;left:-9999px;top:0;width:1px;height:1px;' +
      'opacity:0;pointer-events:none;';
    const input = doc.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('switch', '');
    input.tabIndex = -1;
    label.appendChild(input);
    body.appendChild(label);
    return label;
  } catch {
    return null;
  }
}

/**
 * Fire the iOS toggle haptic. Returns whether the switch was toggled —
 * NOT whether the person felt anything, which no web api can report.
 */
export function switchPulse(doc?: Document): boolean {
  const d = doc ?? (globalThis as { document?: Document }).document;
  if (!d || !canSwitchHaptic(d)) return false;
  const label = switchElement(d);
  if (!label) return false;
  const input = label.firstElementChild as HTMLInputElement | null;
  if (!input) return false;
  try {
    // The haptic rides the label's activation behaviour, not a direct
    // property write — setting `.checked` changes state in silence.
    label.click();
    return true;
  } catch {
    return false;
  }
}

/**
 * Play a pattern on whichever transport this handset has. Returns whether
 * it was handed to the device — false when there is no support at all, the
 * pattern is empty, or the browser refused it (no user engagement yet).
 * Never throws: a handset that will not buzz must not break the screen it
 * was buzzing for.
 */
export function pulse(
  pattern: readonly number[],
  nav?: VibrateLike,
  doc?: Document,
): boolean {
  if (pattern.length === 0) return false;
  const n = target(nav);
  if (n) {
    try {
      return n.vibrate!([...pattern]) !== false;
    } catch {
      return false;
    }
  }
  // No Vibration API — the iPhone route. One tick, pattern discarded.
  return switchPulse(doc);
}

/** The hatch moment. */
export function hatchPulse(nav?: VibrateLike, doc?: Document): boolean {
  return pulse(HATCH_PATTERN, nav, doc);
}
