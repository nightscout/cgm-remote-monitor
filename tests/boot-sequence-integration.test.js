'use strict';
const assert = require('node:assert/strict');
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
