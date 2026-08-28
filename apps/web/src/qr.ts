/** Render the pairing URL as a QR code (scanned by the phone's native camera). */

import { generate } from 'lean-qr';

export function renderQr(canvas: HTMLCanvasElement, text: string): void {
  generate(text).toCanvas(canvas);
  // toCanvas sizes the canvas 1px per module; scale it up crisply with CSS.
  canvas.style.imageRendering = 'pixelated';
  canvas.style.width = '240px';
  canvas.style.height = '240px';
}
