'use strict';
const assert = require('node:assert/strict');
const native = require('../lib/utils/boot-sequence');
const implementations = [['native', native]];
if (process.env.NIGHTSCOUT_BOOT_ORACLE) {
  const legacy = require(process.env.NIGHTSCOUT_BOOT_ORACLE);
  implementations.unshift(['legacy', stages => stages.reduce((chain, stage) => chain.acquire(stage), legacy())]);
}
for (const [name, create] of implementations) {
  describe(name + ' boot sequence contracts', function () {
    it('defers startup, preserves shared context and waits for asynchronous stages', function (done) {
      const order = [];
      const chain = create([
        (ctx, next) => {order.push('start'); ctx.value = 42; next();},
        (ctx, next) => {order.push('waiting'); setImmediate(() => {order.push('resume'); next();});},
        (ctx, next) => {assert.equal(ctx.value, 42); order.push('finish'); next();}
      ]);
      assert.equal(chain.boot(ctx => {
        assert.equal(ctx.value, 42);
        assert.deepEqual(order, ['returned', 'start', 'waiting', 'resume', 'finish']);
        done();
      }), chain);
      order.push('returned');
    });
    it('creates independent contexts on two successive boots and retains recorded failures', async function () {
      const contexts = [];
      for (let cycle = 0; cycle < 2; cycle++) {
        const ctx = await new Promise(resolve => create([
          (ctx, next) => {ctx.bootErrors = []; ctx.resources = new Set(['owned']); next();},
          (ctx, next) => {ctx.bootErrors.push({desc: 'Owned recoverable failure'}); next();},
          (ctx, next) => {assert.equal(ctx.bootErrors.length, 1); next();}
        ]).boot(resolve));
        assert.equal(ctx.resources.size, 1);
        ctx.resources.clear();
        contexts.push(ctx);
      }
      assert.notEqual(contexts[0], contexts[1]);
      assert.notEqual(contexts[0].bootErrors, contexts[1].bootErrors);
      assert.ok(contexts.every(ctx => ctx.resources.size === 0));
    });
    it('completes an empty sequence on the next tick', function (done) {
      let returned = false;
      create([]).boot(ctx => {assert.equal(returned, true); assert.deepEqual(ctx, {}); done();});
      returned = true;
    });
  });
}
describe('Native boot sequence safeguards', function () {
  it('rejects duplicate stage completion before another stage runs twice', function (done) {
    let completions = 0;
    native([(ctx, next) => {
      next();
      assert.throws(next, /already called/);
      assert.equal(completions, 1);
      done();
    }]).boot(() => {completions++;});
  });
});
