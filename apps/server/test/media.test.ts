import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  negotiateVideo,
  WINDOWS_MEDIA_CAPS,
  ANDROID_STOCK_MEDIA_CAPS,
  type MediaCapabilities,
} from '@tether/protocol';

test('PC -> phone screen video prefers HEVC (chroma ties, HEVC wins)', () => {
  const r = negotiateVideo('pc-to-phone', WINDOWS_MEDIA_CAPS, ANDROID_STOCK_MEDIA_CAPS);
  assert.deepEqual(r, { codec: 'hevc', chroma: '420' });
});

test('phone -> PC screen video is HEVC and never AV1 (no phone AV1 encode)', () => {
  const r = negotiateVideo('phone-to-pc', ANDROID_STOCK_MEDIA_CAPS, WINDOWS_MEDIA_CAPS);
  assert.deepEqual(r, { codec: 'hevc', chroma: '420' });
});

test('AV1 is excluded phone->PC even if the phone could encode it (SPEC §4 rule)', () => {
  // Hypothetical Tensor-class phone that CAN encode AV1.
  const av1Phone: MediaCapabilities = {
    ...ANDROID_STOCK_MEDIA_CAPS,
    video: ANDROID_STOCK_MEDIA_CAPS.video.map((v) =>
      v.codec === 'av1' ? { ...v, canEncode: true } : v,
    ),
  };
  const r = negotiateVideo('phone-to-pc', av1Phone, WINDOWS_MEDIA_CAPS);
  assert.notEqual(r?.codec, 'av1');
  assert.equal(r?.codec, 'hevc');
});

test('AV1 is available PC->phone when the PC GPU can encode it', () => {
  // Force a chroma tie broken toward AV1 by removing HEVC from the PC encoder set.
  const av1OnlyPc: MediaCapabilities = {
    ...WINDOWS_MEDIA_CAPS,
    video: WINDOWS_MEDIA_CAPS.video.filter((v) => v.codec !== 'hevc'),
  };
  const r = negotiateVideo('pc-to-phone', av1OnlyPc, ANDROID_STOCK_MEDIA_CAPS);
  assert.equal(r?.codec, 'av1'); // beats h264 at equal 420 chroma
});

test('4:4:4 chroma is prioritised over codec generation', () => {
  const src444: MediaCapabilities = {
    platform: 'windows',
    audioOpus: true,
    video: [
      { codec: 'h264', canEncode: true, canDecode: true, maxChroma: '444' },
      { codec: 'hevc', canEncode: true, canDecode: true, maxChroma: '420' },
    ],
  };
  const sink444: MediaCapabilities = {
    platform: 'windows',
    audioOpus: true,
    video: [
      { codec: 'h264', canEncode: true, canDecode: true, maxChroma: '444' },
      { codec: 'hevc', canEncode: true, canDecode: true, maxChroma: '420' },
    ],
  };
  const r = negotiateVideo('pc-to-phone', src444, sink444);
  assert.deepEqual(r, { codec: 'h264', chroma: '444' }); // 444 H.264 beats 420 HEVC
});

test('H.264 is the floor when it is the only shared codec', () => {
  const h264Only: MediaCapabilities = {
    platform: 'android',
    audioOpus: true,
    video: [{ codec: 'h264', canEncode: true, canDecode: true, maxChroma: '420' }],
  };
  const r = negotiateVideo('phone-to-pc', h264Only, WINDOWS_MEDIA_CAPS);
  assert.deepEqual(r, { codec: 'h264', chroma: '420' });
});

test('no shared codec yields null', () => {
  const encoderOnly: MediaCapabilities = {
    platform: 'android',
    audioOpus: true,
    video: [{ codec: 'hevc', canEncode: true, canDecode: false, maxChroma: '420' }],
  };
  const decoderMissing: MediaCapabilities = {
    platform: 'windows',
    audioOpus: true,
    video: [{ codec: 'h264', canEncode: true, canDecode: true, maxChroma: '444' }],
  };
  assert.equal(negotiateVideo('phone-to-pc', encoderOnly, decoderMissing), null);
});
