import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateDeviceKeypair,
  deviceIdFromPublicKey,
  publicKeyMatchesId,
  displayFingerprint,
  base32Encode,
} from '@tether/protocol';

test('device id is the deterministic fingerprint of the public key', () => {
  const kp = generateDeviceKeypair();
  assert.equal(deviceIdFromPublicKey(kp.rawPublicKey), kp.deviceId);
  assert.equal(kp.deviceId.length, 52); // base32 of 32-byte SHA-256, no padding
});

test('a mismatched key does not validate against an id', () => {
  const a = generateDeviceKeypair();
  const b = generateDeviceKeypair();
  assert.equal(publicKeyMatchesId(a.rawPublicKey, a.deviceId), true);
  assert.equal(publicKeyMatchesId(b.rawPublicKey, a.deviceId), false);
});

test('a wrong-length key is rejected rather than throwing', () => {
  assert.equal(publicKeyMatchesId(new Uint8Array(10), 'whatever'), false);
});

test('display fingerprint is grouped for human comparison', () => {
  const kp = generateDeviceKeypair();
  const fp = displayFingerprint(kp.deviceId);
  assert.match(fp, /^[A-Z2-7]{7}(-[A-Z2-7]{1,7})+$/);
});

test('base32 encodes known vectors (RFC 4648)', () => {
  assert.equal(base32Encode(new Uint8Array(Buffer.from('foobar'))), 'MZXW6YTBOI');
  assert.equal(base32Encode(new Uint8Array(Buffer.from('f'))), 'MY');
});
