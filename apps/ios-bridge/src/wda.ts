/**
 * WebDriverAgent HTTP client. WDA is Appium's XCTest runner; on the device it
 * serves a WebDriver-ish REST API on port 8100 and an MJPEG screen stream on
 * 9100 (both forwarded to localhost by go-ios). We use only the endpoints that
 * remote control needs. Coordinates here are DEVICE POINTS (from /window/size);
 * the API layer maps the web client's normalized 0..1 fractions onto them.
 *
 * Route shapes verified against appium/WebDriverAgent (FBElementCommands):
 *   POST /session                              -> { sessionId }
 *   GET  /window/size                          -> { value: { width, height } }
 *   POST /session/:id/wda/tap                  { x, y }
 *   POST /session/:id/wda/doubleTap            { x, y }
 *   POST /session/:id/wda/touchAndHold         { x, y, duration }
 *   POST /session/:id/wda/dragfromtoforduration{ fromX, fromY, toX, toY, duration }
 *   POST /session/:id/wda/keys                 { value: string[] }
 *   POST /session/:id/wda/pressButton          { name }
 */

export interface WindowSize {
  width: number;
  height: number;
}

export class WdaClient {
  private sessionId: string | null = null;
  private readonly base: string;

  constructor(base = 'http://127.0.0.1:8100') {
    this.base = base;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) throw new Error(`WDA ${path} -> ${res.status}`);
    return res.json();
  }

  private async get(path: string): Promise<any> {
    const res = await fetch(`${this.base}${path}`);
    if (!res.ok) throw new Error(`WDA ${path} -> ${res.status}`);
    return res.json();
  }

  /** True once WDA answers /status (the runner is up). */
  async status(): Promise<boolean> {
    try {
      await this.get('/status');
      return true;
    } catch {
      return false;
    }
  }

  async createSession(): Promise<string> {
    const r = (await this.post('/session', { capabilities: {} })) as { sessionId?: string; value?: { sessionId?: string } };
    this.sessionId = r.sessionId ?? r.value?.sessionId ?? null;
    if (!this.sessionId) throw new Error('WDA did not return a sessionId');
    return this.sessionId;
  }

  private sid(): string {
    if (!this.sessionId) throw new Error('no WDA session — call createSession() first');
    return this.sessionId;
  }

  async windowSize(): Promise<WindowSize> {
    const r = await this.get(`/session/${this.sid()}/window/size`);
    const v = r.value ?? r;
    return { width: v.width, height: v.height };
  }

  tap(x: number, y: number): Promise<unknown> {
    return this.post(`/session/${this.sid()}/wda/tap`, { x, y });
  }
  doubleTap(x: number, y: number): Promise<unknown> {
    return this.post(`/session/${this.sid()}/wda/doubleTap`, { x, y });
  }
  longPress(x: number, y: number, duration = 0.7): Promise<unknown> {
    return this.post(`/session/${this.sid()}/wda/touchAndHold`, { x, y, duration });
  }
  drag(fromX: number, fromY: number, toX: number, toY: number, duration = 0.3): Promise<unknown> {
    return this.post(`/session/${this.sid()}/wda/dragfromtoforduration`, { fromX, fromY, toX, toY, duration });
  }
  keys(text: string): Promise<unknown> {
    return this.post(`/session/${this.sid()}/wda/keys`, { value: [...text] });
  }
  pressButton(name: 'home' | 'volumeUp' | 'volumeDown' | 'lock'): Promise<unknown> {
    return this.post(`/session/${this.sid()}/wda/pressButton`, { name });
  }
}
