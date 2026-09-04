/**
 * A synthetic "desktop" rendered to a canvas, used as the demo's screen source.
 * It is a real MediaStream (canvas.captureStream) fed through the real
 * ScreenShareSource → WebRTC path, so demo mode exercises the actual media
 * pipeline, not a mock. It also responds to pointer/keys so control mode has
 * something visible to drive.
 */

export class FakeDesktop {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private raf = 0;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private captured: MediaStream | null = null;
  private t0 = performance.now();
  private cursor = { x: 640, y: 360 };
  private ripple: { x: number; y: number; at: number } | null = null;
  private termLines: string[] = [
    'tether@demo:~$ ./tether --pair',
    '[noise] Noise_IK_25519_ChaChaPoly_BLAKE2s',
    '[link]  handshake verified — session secured',
    '[media] screen track up (H.264, 1280x720)',
  ];
  private caret = '';

  constructor(width = 1280, height = 720) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d')!;
  }

  start(): void {
    const loop = () => {
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
    // requestAnimationFrame is throttled to ~1fps in a backgrounded tab, which
    // would starve the captured stream. captureStream() auto-captures whenever
    // the canvas is drawn, so this timer keeps frames flowing even in the
    // background (setInterval floors at ~1s there, giving ~1fps — enough to
    // keep the stream alive; the rAF loop drives full rate when visible).
    this.ticker = setInterval(() => this.draw(), 66);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.captured?.getTracks().forEach((t) => t.stop());
    this.captured = null;
  }

  stream(fps = 30): MediaStream {
    this.draw(); // ensure the first captured frame is a full 1280x720 frame
    this.captured = this.canvas.captureStream(fps);
    return this.captured;
  }

  /** Move the synthetic cursor (normalized 0..1 coords from a controller). */
  pointer(nx: number, ny: number): void {
    this.cursor = { x: nx * this.canvas.width, y: ny * this.canvas.height };
  }

  click(nx: number, ny: number): void {
    this.pointer(nx, ny);
    this.ripple = { x: this.cursor.x, y: this.cursor.y, at: performance.now() };
  }

  type(text: string): void {
    this.caret = (this.caret + text).slice(-40);
  }

  private draw(): void {
    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;
    const t = (performance.now() - this.t0) / 1000;

    // wallpaper
    ctx.fillStyle = '#0b0c0e';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#14171b';
    ctx.lineWidth = 1;
    for (let x = 0; x < w; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = 0; y < h; y += 40) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // drifting windows (Lissajous)
    const win = (cx: number, cy: number, ww: number, wh: number, title: string, accent: string) => {
      ctx.fillStyle = '#181b1f';
      ctx.strokeStyle = '#2a2f36';
      ctx.fillRect(cx, cy, ww, wh);
      ctx.strokeRect(cx + 0.5, cy + 0.5, ww, wh);
      ctx.fillStyle = '#20242a';
      ctx.fillRect(cx, cy, ww, 28);
      ctx.fillStyle = accent;
      ctx.fillRect(cx, cy, 4, 28);
      ctx.fillStyle = '#a4abb3';
      ctx.font = '13px monospace';
      ctx.fillText(title, cx + 14, cy + 19);
    };
    win(200 + 60 * Math.sin(t * 0.3), 140 + 40 * Math.cos(t * 0.23), 420, 260, 'metrics.tether', '#f0b429');
    win(640 + 50 * Math.sin(t * 0.19 + 1), 320 + 45 * Math.cos(t * 0.27), 460, 300, 'session — verified', '#5fd38d');

    // terminal window (bottom-left)
    const tx = 120;
    const ty = 470;
    const tw = 520;
    const th = 200;
    ctx.fillStyle = '#0d0f12';
    ctx.fillRect(tx, ty, tw, th);
    ctx.strokeStyle = '#2a2f36';
    ctx.strokeRect(tx + 0.5, ty + 0.5, tw, th);
    ctx.font = '13px monospace';
    this.termLines.forEach((line, i) => {
      ctx.fillStyle = i === 2 ? '#5fd38d' : '#8b949e';
      ctx.fillText(line, tx + 14, ty + 28 + i * 22);
    });
    const blink = Math.floor(t * 2) % 2 === 0 ? '_' : ' ';
    ctx.fillStyle = '#e7e9ec';
    ctx.fillText(`tether@demo:~$ ${this.caret}${blink}`, tx + 14, ty + 28 + this.termLines.length * 22);

    // taskbar + live clock
    ctx.fillStyle = '#111316';
    ctx.fillRect(0, h - 36, w, 36);
    ctx.fillStyle = '#6c737b';
    ctx.font = '13px monospace';
    ctx.fillText('tether demo desktop', 16, h - 13);
    const clock = new Date().toLocaleTimeString();
    ctx.textAlign = 'right';
    ctx.fillText(clock, w - 16, h - 13);
    ctx.textAlign = 'left';

    // click ripple
    if (this.ripple) {
      const age = (performance.now() - this.ripple.at) / 1000;
      if (age < 0.6) {
        ctx.strokeStyle = `rgba(240,180,41,${1 - age / 0.6})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(this.ripple.x, this.ripple.y, age * 60, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        this.ripple = null;
      }
    }

    // cursor
    ctx.fillStyle = '#e7e9ec';
    ctx.beginPath();
    ctx.moveTo(this.cursor.x, this.cursor.y);
    ctx.lineTo(this.cursor.x, this.cursor.y + 18);
    ctx.lineTo(this.cursor.x + 5, this.cursor.y + 13);
    ctx.lineTo(this.cursor.x + 12, this.cursor.y + 13);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#0b0c0e';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}
