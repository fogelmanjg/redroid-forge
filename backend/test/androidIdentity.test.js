'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseCheckinXml, normalizeLegacyId } = require('../src/lib/androidIdentity');

// Real value read from an instance with the modern GMS trio (24.23.35 / GSF 15) on 09/10/2026.
const REAL = '<?xml version=\'1.0\' encoding=\'utf-8\' standalone=\'yes\' ?>\n<map>\n'
  + '    <string name="android_id">3607632867885909819</string>\n'
  + '    <string name="CheckinService_deviceDataVersionInfo">ABFEt1UZ</string>\n</map>\n';

test('returns the decimal check-in ID of Checkin.xml exactly as stored (no hex conversion)', () => {
  assert.strictEqual(parseCheckinXml(REAL), '3607632867885909819');
  // Real value of the CIFI instance, the one registered with Google by hand.
  assert.strictEqual(parseCheckinXml('<string name="android_id">3627736167647049813</string>'), '3627736167647049813');
});

test('before the first check-in (0), no ID, or garbage: null', () => {
  assert.strictEqual(parseCheckinXml('<string name="android_id">0</string>'), null);
  assert.strictEqual(parseCheckinXml('<map></map>'), null);
  assert.strictEqual(parseCheckinXml(''), null);
  assert.strictEqual(parseCheckinXml(undefined), null);
  assert.strictEqual(parseCheckinXml('<string name="android_id">abc</string>'), null);
  // does not fit in 64 bits
  assert.strictEqual(parseCheckinXml('<string name="android_id">99999999999999999999</string>'), null);
});

test('legacy gservices.db ID: accepts digits/hex IDs, rejects everything else', () => {
  assert.strictEqual(normalizeLegacyId(' 34FB90B4AA5F1001\n'), '34fb90b4aa5f1001');
  assert.strictEqual(normalizeLegacyId(''), null);
  assert.strictEqual(normalizeLegacyId('not-an-id'), null);
  assert.strictEqual(normalizeLegacyId('12'), null);
  assert.strictEqual(normalizeLegacyId('3627736167647049813'), '3627736167647049813');
  assert.strictEqual(normalizeLegacyId(null), null);
});
