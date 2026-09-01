/**
 * Remote-control input events (SPEC §2.1 remote-control, docs/MEDIA.md).
 *
 * These events ride ONLY over the session's unreliable, unordered WebRTC
 * DataChannel (`ordered: false, maxRetransmits: 0`) — never the Noise control
 * channel and never the broker — so a lost pointer sample can't head-of-line
 * block the cursor. One JSON-encoded event per DataChannel message.
 *
 * Coordinate contract: `x`/`y` are normalized 0..1 within the shared video
 * frame, top-left origin. The controlled side maps them to its own space:
 * Windows multiplies by 65535 for MOUSEEVENTF_ABSOLUTE (see
 * apps/windows/src/input/InputInjector.h), Android multiplies by its screen
 * size. One low-level schema serves both directions — Windows consumes pointer
 * events 1:1; Android synthesizes tap/swipe gestures from pdown→pup
 * displacement and duration.
 */

/** Mouse button index: 0 = left (and phone touch), 1 = middle, 2 = right. */
export type PointerButton = 0 | 1 | 2;

export type InputEvent =
  | { i: 'pmove'; x: number; y: number }
  | { i: 'pdown'; x: number; y: number; b: PointerButton }
  | { i: 'pup'; x: number; y: number; b: PointerButton }
  /** dx/dy in wheel-delta units (±120 per notch), same sign as WheelEvent. */
  | { i: 'wheel'; x: number; y: number; dx: number; dy: number }
  /** Physical key by KeyboardEvent.code (e.g. 'KeyA', 'ArrowLeft'). */
  | { i: 'key'; code: string; down: boolean }
  /** Committed text (mobile IME input) — injected as unicode, not keystrokes. */
  | { i: 'text'; text: string }
  /** Android-only global navigation actions. */
  | { i: 'nav'; action: NavAction };

export type NavAction = 'back' | 'home' | 'recents';

const NAV_ACTIONS: readonly string[] = ['back', 'home', 'recents'];

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isCoord(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
}

function isButton(v: unknown): v is PointerButton {
  return v === 0 || v === 1 || v === 2;
}

/** Runtime guard for events arriving off the DataChannel (same style as parseClientMessage). */
export function parseInputEvent(raw: unknown): InputEvent | null {
  if (!isObj(raw) || typeof raw.i !== 'string') return null;
  switch (raw.i) {
    case 'pmove':
      return isCoord(raw.x) && isCoord(raw.y) ? (raw as unknown as InputEvent) : null;
    case 'pdown':
    case 'pup':
      return isCoord(raw.x) && isCoord(raw.y) && isButton(raw.b)
        ? (raw as unknown as InputEvent)
        : null;
    case 'wheel':
      return isCoord(raw.x) &&
        isCoord(raw.y) &&
        typeof raw.dx === 'number' &&
        Number.isFinite(raw.dx) &&
        typeof raw.dy === 'number' &&
        Number.isFinite(raw.dy)
        ? (raw as unknown as InputEvent)
        : null;
    case 'key':
      return typeof raw.code === 'string' && raw.code.length > 0 && typeof raw.down === 'boolean'
        ? (raw as unknown as InputEvent)
        : null;
    case 'text':
      return typeof raw.text === 'string' && raw.text.length > 0
        ? (raw as unknown as InputEvent)
        : null;
    case 'nav':
      return typeof raw.action === 'string' && NAV_ACTIONS.includes(raw.action)
        ? (raw as unknown as InputEvent)
        : null;
    default:
      return null;
  }
}

export function encodeInputEvent(ev: InputEvent): string {
  return JSON.stringify(ev);
}

export function decodeInputEvent(data: string): InputEvent | null {
  try {
    return parseInputEvent(JSON.parse(data));
  } catch {
    return null;
  }
}
