'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {convert, SAFE_MODES} = require('../core.js');
const {compare} = require('../verify.js');

test('generic block escape wires keep ctl and out on separate nets', async () => {
  const deck = fs.readFileSync(path.join(__dirname, 'fixtures/net-contact.cir'), 'utf8');
  let best = null;
  for (const mode of SAFE_MODES) {
    const errors = compare(deck, await convert(deck, mode));
    if (!errors.length) return;
    if (best === null || errors.length < best.length) best = errors;
  }
  assert.deepEqual(best, []);
});
