/**
 * PC sound alongside the screen (ROADMAP Phase 1 item 5, web path): the offer
 * announces an app-audio track only when the capture has sound, and the
 * receiver gates it with the protocol's audio-route rules.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANDROID_STOCK_CAPS, IOS_CAPS, WINDOWS_CAPS } from '@tether/protocol/browser';
import { audioRefusal, offeredTracks, offersAudio } from '../src/media-tracks.ts';

const ids = { source: 'pc', sink: 'phone' };

test('a silent capture offers video only', () => {
  assert.deepEqual(offeredTracks(['video']), [{ kind: 'screen-video', direction: 'pc-to-phone' }]);
  assert.equal(offersAudio(offeredTracks(['video'])), false);
});

test('a capture with sound also offers the PC audio', () => {
  const tracks = offeredTracks(['video', 'audio']);
  assert.deepEqual(tracks, [
    { kind: 'screen-video', direction: 'pc-to-phone' },
    { kind: 'app-audio', direction: 'pc-to-phone' },
  ]);
  assert.equal(offersAudio(tracks), true);
});

test('offers from older clients, with no track list, carry no audio', () => {
  assert.equal(offersAudio(undefined), false);
  assert.equal(offersAudio([]), false);
});

test('a PC that can export audio may play on a phone', () => {
  assert.equal(audioRefusal(WINDOWS_CAPS, ANDROID_STOCK_CAPS, ids), null);
});

test('a sender that advertises no audio export is refused, with the reason', () => {
  assert.match(audioRefusal(IOS_CAPS, ANDROID_STOCK_CAPS, ids) ?? '', /cannot export media audio/);
});

test('before the sender says hello, the offer itself is proof enough', () => {
  assert.equal(audioRefusal(null, ANDROID_STOCK_CAPS, ids), null);
});
