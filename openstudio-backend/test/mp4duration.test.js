'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mp4DurationSec } = require('../src/media/mp4duration');

function box(type, body) {
  const b = Buffer.alloc(8 + body.length);
  b.writeUInt32BE(b.length, 0); b.write(type, 4, 'latin1'); body.copy(b, 8); return b;
}
function mvhd(timescale, duration) {
  const body = Buffer.alloc(100); // version 0
  body.writeUInt32BE(timescale, 12); body.writeUInt32BE(duration, 16); return box('mvhd', body);
}
const reader = (buf) => async (a, b) => buf.subarray(a, b + 1);

test('durée MP4 : moov en fin de fichier (après mdat)', async () => {
  const file = Buffer.concat([box('ftyp', Buffer.alloc(16)), box('mdat', Buffer.alloc(5000)), box('moov', mvhd(1000, 125400))]);
  assert.equal(await mp4DurationSec(reader(file), file.length), 125.4);
});

test('durée MP4 : moov en début de fichier', async () => {
  const file = Buffer.concat([box('ftyp', Buffer.alloc(16)), box('moov', Buffer.concat([box('udta', Buffer.alloc(10)), mvhd(600, 36000)])), box('mdat', Buffer.alloc(100))]);
  assert.equal(await mp4DurationSec(reader(file), file.length), 60);
});

test('durée MP4 : fichier non MP4 → null', async () => {
  const file = Buffer.from('1A45DFA3 pas un mp4 du tout, webm par exemple');
  assert.equal(await mp4DurationSec(reader(file), file.length), null);
});
