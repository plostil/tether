/**
 * Which tracks a screen session carries (docs/MEDIA.md, ROADMAP Phase 1 item 5).
 *
 * A captured screen always sends video. When the capture also has sound (the
 * user ticked "Also share system audio" or "Share tab audio" in the browser's
 * picker, or the demo's virtual PC plays its chime), the offer announces an
 * `app-audio` track as well, so the receiver can gate it and show a sound
 * control. Pure functions only: the unit tests import this file directly.
 */

import type { DeviceCapabilities, MediaTrackRequest } from '@tether/protocol/browser';
import { negotiateSession } from '@tether/protocol/browser';

/** The track list an offer announces for a stream with these track kinds. */
export function offeredTracks(kinds: readonly string[]): MediaTrackRequest[] {
  const tracks: MediaTrackRequest[] = [{ kind: 'screen-video', direction: 'pc-to-phone' }];
  if (kinds.includes('audio')) tracks.push({ kind: 'app-audio', direction: 'pc-to-phone' });
  return tracks;
}

/** Does an offer announce the sender's media/output audio? */
export function offersAudio(tracks: readonly MediaTrackRequest[] | undefined): boolean {
  return (tracks ?? []).some((t) => t.kind === 'app-audio');
}

/**
 * The receiver's gate for an offered audio track: the SPEC §2.2 audio-route
 * rules, applied to the sender's advertised capabilities. Before the sender's
 * `hello` arrives its capabilities are unknown; the offer itself then stands as
 * proof that it can export audio. Returns null when the sound may play, or the
 * reason it may not.
 */
export function audioRefusal(
  peerCaps: DeviceCapabilities | null,
  localCaps: DeviceCapabilities,
  ids: { source: string; sink: string },
): string | null {
  if (!peerCaps) return null;
  const result = negotiateSession({ kind: 'audio-route', source: ids.source, sink: ids.sink }, peerCaps, localCaps);
  return result.ok ? null : result.reason;
}
