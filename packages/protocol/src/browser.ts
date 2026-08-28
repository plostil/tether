/**
 * Browser-safe entry point (`@tether/protocol/browser`).
 *
 * Everything here is platform-free: the Noise core (primitives injected by the
 * consumer — apps/web binds @noble/*), pure encodings, and the plain-data
 * message/session/media/capability types. identity.ts and noise.ts are
 * EXCLUDED — they import node:crypto and must never enter a browser bundle
 * (esbuild --platform=browser enforces this by failing on any node: import).
 */

export * from './noise-core.ts';
export * from './encoding.ts';
export * from './messages.ts';
export * from './capabilities.ts';
export * from './session.ts';
export * from './media.ts';
