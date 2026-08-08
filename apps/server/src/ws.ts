/**
 * Minimal RFC 6455 WebSocket server transport.
 *
 * Deliberately dependency-free so the broker runs on stock Node with no install
 * step. It implements exactly what the signaling protocol needs: the upgrade
 * handshake, masked client->server text frames (with 16/64-bit lengths),
 * server->client text frames, ping/pong, and close. Binary and fragmented
 * application frames are not used by our protocol; continuation is handled
 * defensively but the payloads are always single JSON text frames.
 *
 * For production you may swap this for the `ws` package without touching
 * broker.ts — the Connection interface is the seam.
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { ServerMessage } from '@tether/protocol';
import type { Broker, Connection } from './broker.ts';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(clientKey: string): string {
  return createHash('sha1')
    .update(clientKey + WS_GUID)
    .digest('base64');
}

let connSeq = 0;

class WsConnection implements Connection {
  readonly id = `c${++connSeq}`;
  private closed = false;
  private readonly socket: Duplex;

  constructor(socket: Duplex) {
    this.socket = socket;
  }

  send(msg: ServerMessage): void {
    if (this.closed) return;
    this.socket.write(encodeTextFrame(JSON.stringify(msg)));
  }

  sendPong(payload: Buffer): void {
    if (this.closed) return;
    this.socket.write(encodeFrame(0xa, payload));
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    this.closed = true;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    try {
      this.socket.write(encodeFrame(0x8, body));
      this.socket.end();
    } catch {
      /* socket already gone */
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

function encodeTextFrame(text: string): Buffer {
  return encodeFrame(0x1, Buffer.from(text, 'utf8'));
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, payload]);
}

/**
 * Incremental frame decoder for a single connection. Feeds complete text
 * message payloads to onText; answers control frames itself.
 */
class FrameDecoder {
  private buf = Buffer.alloc(0);
  private readonly conn: WsConnection;
  private readonly onText: (text: string) => void;
  private readonly onClose: () => void;

  constructor(conn: WsConnection, onText: (text: string) => void, onClose: () => void) {
    this.conn = conn;
    this.onText = onText;
    this.onClose = onClose;
  }

  push(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    // Loop while a full frame is available.
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0]!;
      const b1 = this.buf[1]!;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (this.buf.length < offset + 2) return;
        len = this.buf.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (this.buf.length < offset + 8) return;
        const big = this.buf.readBigUInt64BE(offset);
        len = Number(big);
        offset += 8;
      }

      // All client->server frames MUST be masked (RFC 6455 §5.1).
      if (!masked) {
        this.conn.close(1002, 'unmasked client frame');
        this.onClose();
        return;
      }
      if (this.buf.length < offset + 4 + len) return; // wait for full frame
      const mask = this.buf.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.alloc(len);
      for (let i = 0; i < len; i++) {
        payload[i] = this.buf[offset + i]! ^ mask[i % 4]!;
      }
      this.buf = this.buf.subarray(offset + len);

      switch (opcode) {
        case 0x1: // text
          this.onText(payload.toString('utf8'));
          break;
        case 0x8: // close
          this.conn.close(1000, '');
          this.onClose();
          return;
        case 0x9: // ping
          this.conn.sendPong(payload);
          break;
        case 0xa: // pong
          break;
        default:
          // 0x0 continuation / 0x2 binary — unused by our protocol.
          break;
      }
    }
  }
}

/** Attach WebSocket signaling to an existing HTTP server, wired to the broker. */
export function attachWebSocket(server: Server, broker: Broker, path = '/signal'): void {
  server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== path) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );

    const conn = new WsConnection(socket);
    broker.onConnect(conn);

    const decoder = new FrameDecoder(
      conn,
      (text) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          conn.send({ t: 'error', code: 'bad-message', message: 'invalid JSON' });
          return;
        }
        broker.onMessage(conn, parsed);
      },
      () => broker.onDisconnect(conn),
    );

    socket.on('data', (chunk: Buffer) => decoder.push(chunk));
    socket.on('close', () => broker.onDisconnect(conn));
    socket.on('error', () => broker.onDisconnect(conn));
  });
}
