'use strict';
const assert = require('node:assert/strict');
const {once} = require('node:events');
const boot = require('../lib/server/bootevent');

describe('Native boot failure lifecycle', function () {
  it('retains environment errors and tears down two independent failed boots', async function () {
    const contexts = [];
    for (let cycle = 0; cycle < 2; cycle++) {
      const env = require('../lib/server/env')();
      env.err = [new Error('Owned environment failure')];
      // A configuration failure must prevent any storage/connector startup.
      env.IMPORT_CONFIG = null;
      const ctx = await new Promise(resolve => boot(env, require('../lib/language')()).boot(resolve));
      let teardowns = 0;
      ctx.bus.once('teardown', () => teardowns++);
      try {
        assert.ok(ctx.bootErrors.some(error => error.desc === 'ENV Error'));
        assert.equal(ctx.store, undefined);
        assert.equal(ctx.nightscoutConnect, undefined);
        assert.equal(ctx.runtimeState, 'booting');
        contexts.push(ctx);
      } finally {
        ctx.bus.teardown();
      }
      assert.equal(teardowns, 1);
    }
    assert.notEqual(contexts[0], contexts[1]);
    assert.notEqual(contexts[0].bus, contexts[1].bus);
    assert.notEqual(contexts[0].bootErrors, contexts[1].bootErrors);
  });
});


describe('Native successful boot lifecycle', function () {
  this.timeout(10000);
  it('loads and tears down two independent contexts without accumulating data listeners', async function () {
    const originalSecret = process.env.API_SECRET;
    const contexts = [];
    try {
      for (let cycle = 0; cycle < 2; cycle++) {
        process.env.API_SECRET = 'owned boot lifecycle test secret';
        const env = require('../lib/server/env')();
        env.IMPORT_CONFIG = null;
        env.extendedSettings.connect = {};
        env.extendedSettings.bridge = {};
        env.extendedSettings.mmconnect = {};
        const ctx = await new Promise(resolve => boot(env, require('../lib/language')()).boot(resolve));
        try {
          assert.deepEqual(ctx.bootErrors, []);
          if (ctx.runtimeState !== 'loaded') await once(ctx.bus, 'data-processed');
          assert.equal(ctx.runtimeState, 'loaded');
          assert.equal(ctx.bus.listenerCount('data-received'), 1);
          assert.equal(ctx.bus.listenerCount('data-loaded'), 1);
          contexts.push(ctx);
        } finally {
          ctx.bus.teardown();
        }
      }
      assert.notEqual(contexts[0].bus, contexts[1].bus);
      assert.notEqual(contexts[0].ddata, contexts[1].ddata);
    } finally {
      if (originalSecret === undefined) delete process.env.API_SECRET;
      else process.env.API_SECRET = originalSecret;
    }
  });
});
