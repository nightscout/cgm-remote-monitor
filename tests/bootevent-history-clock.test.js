'use strict';

const assert = require('assert');

// Capture the real boot stages; do not duplicate their implementation.
function stages () {
  const name = require.resolve('bootevent');
  const original = require('bootevent');
  const acquired = [];
  require.cache[name].exports = function () {
    return { acquire: function (stage) { acquired.push(stage); return this; } };
  };
  try {
    require('../lib/server/bootevent')({}, {});
  } finally {
    require.cache[name].exports = original;
  }
  return acquired;
}

describe('History clock startup gate', function () {
  it('waits for storage recovery before boot can reach uploaders', async function () {
    const steps = stages();
    const restore = steps.find(step => step.name === 'restoreHistoryClock');
    assert(steps.indexOf(restore) < steps.findIndex(step => step.name === 'setupConnect'));
    assert(steps.indexOf(restore) < steps.findIndex(step => step.name === 'setupBridge'));
    let release, advanced = false;
    const read = new Promise(resolve => { release = resolve; });
    const ctx = { bootErrors: [], store: { collection: () => ({ findOne: () => read }) } };
    const complete = new Promise(resolve => restore(ctx, function () { advanced = true; resolve(); }));
    await Promise.resolve();
    assert.strictEqual(advanced, false);
    release(null);
    await complete;
    assert.deepStrictEqual(ctx.bootErrors, []);
  });

  it('reports a storage failure and does not start the connector', async function () {
    const steps = stages();
    const ctx = { bootErrors: [], store: { collection: () => ({
      findOne: () => Promise.reject(new Error('history read failed'))
    }) } };
    await new Promise(resolve => steps.find(step => step.name === 'restoreHistoryClock')(ctx, resolve));
    assert.strictEqual(ctx.bootErrors.length, 1);
    assert.strictEqual(ctx.bootErrors[0].desc, 'Unable to restore history clock');
    assert.strictEqual(ctx.bootErrors[0].err, 'history read failed');
    await new Promise(resolve => steps.find(step => step.name === 'setupConnect')(ctx, resolve));
    assert.strictEqual(ctx.nightscoutConnect, undefined);
  });
});
