'use strict';

const assert = require('node:assert/strict');
const { awaitIndexes, INDEX_WAIT_MS } = require('../lib/server/bootevent');

describe('Boot waits for index setup, within a limit', function () {
  let warnings;
  let originalWarn;

  beforeEach(function () {
    warnings = [];
    originalWarn = console.warn;
    console.warn = message => warnings.push(String(message));
  });

  afterEach(function () {
    console.warn = originalWarn;
  });

  it('waits up to 20 seconds by default', function () {
    assert.equal(INDEX_WAIT_MS, 20000);
  });

  it('resolves true once every request has settled', async function () {
    let settled = false;
    const slow = new Promise(resolve => setTimeout(() => { settled = true; resolve(); }, 30));
    const done = await awaitIndexes([slow, Promise.resolve(), undefined], 'test', 1000);
    assert.equal(done, true);
    assert.equal(settled, true);
    assert.deepEqual(warnings, []);
  });

  it('stops waiting after the limit, with a warning, and does not reject', async function () {
    const never = new Promise(() => { });
    const started = Date.now();
    const done = await awaitIndexes([Promise.resolve(), never], 'data collections', 50);
    assert.equal(done, false);
    assert.ok(Date.now() - started < 1000);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /data collections is still running after 50 ms; continuing start-up/);
  });
});
