/**
 * Phone-side viewer + control input for the remote-view <video>.
 *
 * Turns touch/pointer + keyboard into normalized {@link InputEvent}s for the
 * controlled peer, AND provides local pinch-zoom / pan of the (small-on-a-phone)
 * remote screen. Coordinates are 0..1 within the video's letterboxed content
 * rect, inverted back through the local zoom transform so a tap still lands where
 * the finger is even when zoomed in.
 *
 * Gestures:
 *   - One finger: control (move/drag + tap) when control is active; otherwise, if
 *     zoomed in, one finger pans the local view.
 *   - Two fingers pinch: zoom the local view about the pinch centroid.
 *   - Two fingers drag while zoomed: pan the local view.
 *   - Two fingers drag at 1x zoom: scroll wheel on the controlled PC.
 * A hidden <input>, focused by a "Keyboard" button, raises the phone keyboard and
 * feeds committed text (unicode) plus control keys.
 */

import type { InputEvent } from '@tether/protocol/browser';
import { codeToScan } from './keymap.ts';

export interface ViewerInputHandle {
  detach(): void;
  resetZoom(): void;
}

interface Pt {
  x: number;
  y: number;
}

const MAX_ZOOM = 5;

function isControlKey(code: string): boolean {
  return codeToScan(code) !== null && !/^(Key[A-Z]|Digit\d)$/.test(code);
}

export function attachViewerInput(
  surface: HTMLElement,
  video: HTMLVideoElement,
  keyboardInput: HTMLInputElement,
  opts: { send: (ev: InputEvent) => void; canControl: () => boolean },
): ViewerInputHandle {
  const pointers = new Map<number, Pt>();

  // Local view transform.
  let zoom = 1;
  let panX = 0;
  let panY = 0;

  // One-finger control / pan state.
  let primary: number | null = null;
  let buttonDown = false;
  let panning = false;
  let panLastX = 0;
  let panLastY = 0;
  let multiTouched = false;

  // Two-finger gesture state.
  let twoActive = false;
  let prevDist = 0;
  let prevCx = 0;
  let prevCy = 0;

  // rAF-throttled move.
  let rafPending = false;
  let pendingMove: Pt | null = null;

  function applyTransform(): void {
    video.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  }

  function clampPan(): void {
    if (zoom <= 1) {
      zoom = 1;
      panX = 0;
      panY = 0;
      return;
    }
    const r = surface.getBoundingClientRect();
    panX = Math.min(0, Math.max(r.width * (1 - zoom), panX));
    panY = Math.min(0, Math.max(r.height * (1 - zoom), panY));
  }

  /** Client point -> 0..1 within the video content, inverting zoom/pan and letterbox. */
  function norm(clientX: number, clientY: number): Pt | null {
    const r = surface.getBoundingClientRect();
    const vw = video.videoWidth || r.width;
    const vh = video.videoHeight || r.height;
    const s = Math.min(r.width / vw, r.height / vh);
    const cw = vw * s;
    const ch = vh * s;
    const ox = (r.width - cw) / 2;
    const oy = (r.height - ch) / 2;
    const localX = (clientX - r.left - panX) / zoom;
    const localY = (clientY - r.top - panY) / zoom;
    const x = (localX - ox) / cw;
    const y = (localY - oy) / ch;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  }

  function twoPoints(): [Pt, Pt] {
    const a = [...pointers.values()];
    return [a[0]!, a[1]!];
  }
  function dist(a: Pt, b: Pt): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function onDown(e: PointerEvent): void {
    surface.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    void video.play?.().catch(() => {});

    if (pointers.size === 2) {
      multiTouched = true;
      if (buttonDown) {
        const p = norm(e.clientX, e.clientY);
        if (p) opts.send({ i: 'pup', x: p.x, y: p.y, b: 0 });
        buttonDown = false;
      }
      panning = false;
      const [a, b] = twoPoints();
      prevDist = dist(a, b);
      prevCx = (a.x + b.x) / 2;
      prevCy = (a.y + b.y) / 2;
      twoActive = true;
      return;
    }

    if (pointers.size === 1) {
      if (multiTouched) return; // wait for all fingers to lift before single-touch
      primary = e.pointerId;
      if (opts.canControl()) {
        const p = norm(e.clientX, e.clientY);
        if (p) {
          opts.send({ i: 'pmove', x: p.x, y: p.y });
          opts.send({ i: 'pdown', x: p.x, y: p.y, b: 0 });
          buttonDown = true;
        }
      } else if (zoom > 1) {
        panning = true;
        panLastX = e.clientX;
        panLastY = e.clientY;
      }
    }
  }

  function flushMove(): void {
    rafPending = false;
    if (pendingMove) {
      opts.send({ i: 'pmove', x: pendingMove.x, y: pendingMove.y });
      pendingMove = null;
    }
  }

  function onMove(e: PointerEvent): void {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (twoActive && pointers.size >= 2) {
      const [a, b] = twoPoints();
      const curDist = dist(a, b);
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      const dCx = cx - prevCx;
      const dCy = cy - prevCy;
      const pinching = Math.abs(curDist - prevDist) > 1;

      if (pinching || zoom > 1) {
        // Zoom about the pinch centroid, then apply the centroid pan.
        const ratio = prevDist > 0 ? curDist / prevDist : 1;
        const z2 = Math.min(MAX_ZOOM, Math.max(1, zoom * ratio));
        const r = surface.getBoundingClientRect();
        const lx = (cx - r.left - panX) / zoom;
        const ly = (cy - r.top - panY) / zoom;
        zoom = z2;
        panX = cx - r.left - lx * zoom + dCx;
        panY = cy - r.top - ly * zoom + dCy;
        clampPan();
        applyTransform();
      } else if (opts.canControl() && dCy !== 0) {
        // At 1x, a two-finger drag scrolls the controlled PC.
        opts.send({ i: 'wheel', x: 0.5, y: 0.5, dx: 0, dy: Math.round((-dCy / 40) * 120) });
      }
      prevDist = curDist;
      prevCx = cx;
      prevCy = cy;
      return;
    }

    if (panning && e.pointerId === primary) {
      panX += e.clientX - panLastX;
      panY += e.clientY - panLastY;
      panLastX = e.clientX;
      panLastY = e.clientY;
      clampPan();
      applyTransform();
      return;
    }

    if (e.pointerId === primary && buttonDown) {
      const p = norm(e.clientX, e.clientY);
      if (!p) return;
      pendingMove = p;
      if (!rafPending) {
        rafPending = true;
        requestAnimationFrame(flushMove);
      }
    }
  }

  function onUp(e: PointerEvent): void {
    if (!pointers.delete(e.pointerId)) return;
    surface.releasePointerCapture?.(e.pointerId);
    if (pointers.size < 2) twoActive = false;

    if (panning && e.pointerId === primary) {
      panning = false;
      primary = pointers.size ? [...pointers.keys()][0]! : null;
    } else if (e.pointerId === primary && buttonDown) {
      const p = norm(e.clientX, e.clientY);
      opts.send({ i: 'pup', x: p ? p.x : 0.5, y: p ? p.y : 0.5, b: 0 });
      buttonDown = false;
      primary = pointers.size ? [...pointers.keys()][0]! : null;
    }
    if (pointers.size === 0) multiTouched = false;
  }

  // Keyboard: control keys as key events, everything else as unicode text.
  function onKeyDown(e: KeyboardEvent): void {
    if (isControlKey(e.code)) {
      e.preventDefault();
      opts.send({ i: 'key', code: e.code, down: true });
    }
  }
  function onKeyUp(e: KeyboardEvent): void {
    if (isControlKey(e.code)) {
      e.preventDefault();
      opts.send({ i: 'key', code: e.code, down: false });
    }
  }
  function onInput(): void {
    const text = keyboardInput.value;
    if (text) opts.send({ i: 'text', text });
    keyboardInput.value = '';
  }

  surface.addEventListener('pointerdown', onDown);
  surface.addEventListener('pointermove', onMove);
  surface.addEventListener('pointerup', onUp);
  surface.addEventListener('pointercancel', onUp);
  keyboardInput.addEventListener('keydown', onKeyDown);
  keyboardInput.addEventListener('keyup', onKeyUp);
  keyboardInput.addEventListener('input', onInput);

  return {
    detach(): void {
      surface.removeEventListener('pointerdown', onDown);
      surface.removeEventListener('pointermove', onMove);
      surface.removeEventListener('pointerup', onUp);
      surface.removeEventListener('pointercancel', onUp);
      keyboardInput.removeEventListener('keydown', onKeyDown);
      keyboardInput.removeEventListener('keyup', onKeyUp);
      keyboardInput.removeEventListener('input', onInput);
    },
    resetZoom(): void {
      zoom = 1;
      panX = 0;
      panY = 0;
      applyTransform();
    },
  };
}
