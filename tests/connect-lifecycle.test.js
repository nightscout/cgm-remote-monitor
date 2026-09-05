'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {createRequire} = require('module');
const {EventEmitter} = require('events');

// Run the actual registered boot stage without starting unrelated database/services.
function connectStage(env, factory) {
  const filename = path.resolve(__dirname, '../lib/server/bootevent.js');
  const localRequire = createRequire(filename);
  const stages = [];
  const pipeline = {acquire(stage) { stages.push(stage); return pipeline; }};
  const sandbox = {module: {exports: {}}, console: {log() {}}, process, require(name) {
    if (name === 'bootevent') return () => pipeline;
    if (name === 'nightscout-connect') return factory();
    return localRequire(name);
  }};
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, {filename});
  sandbox.module.exports(env, {});
  return stages.find(stage => stage.name === 'setupConnect');
}

function context() { return {bootErrors: [], bus: new EventEmitter()}; }

describe('nightscout-connect loading and teardown', function () {
  [{}, {connect: {}}, {connect: {source: ''}}, {connect: {source: false}}].forEach(settings => {
    it('does not import the connector without an enabled source: ' + JSON.stringify(settings), function () {
      let continued = 0;
      const ctx = context();
      ctx.nightscoutConnect = {previous: true};
      connectStage({extendedSettings: settings}, () => { throw new Error('disabled connector imported'); })(ctx, () => continued++);
      assert.strictEqual(continued, 1);
      assert.strictEqual(ctx.nightscoutConnect, undefined);
      assert.strictEqual(ctx.bus.listenerCount('teardown'), 0);
    });
  });

  it('migrates bridge credentials before deciding whether to import', function () {
    const env = {extendedSettings: {bridge: {userName: 'fixture-user', password: 'fixture-password', server: 'EU'}}};
    let imports = 0, calls = 0, continued = 0;
    const ctx = context();
    connectStage(env, () => {
      imports++;
      return (configured, actualContext) => {
        calls++;
        assert.strictEqual(configured, env);
        assert.strictEqual(actualContext, ctx);
        assert.strictEqual(configured.extendedSettings.connect.source, 'dexcomshare');
        assert.strictEqual(configured.extendedSettings.connect.shareAccountName, 'fixture-user');
        assert.strictEqual(configured.extendedSettings.connect.sharePassword, 'fixture-password');
        assert.strictEqual(configured.extendedSettings.connect.shareRegion, 'ous');
        return {stop() {}};
      };
    })(ctx, () => continued++);
    assert.strictEqual(imports, 1);
    assert.strictEqual(calls, 1);
    assert.strictEqual(continued, 1);
  });

  it('leaves the explicitly selected legacy bridge without loading CONNECT', function () {
    const env = {extendedSettings: {bridge: {userName: 'fixture', password: 'fixture', useLegacy: true}}};
    let continued = 0;
    connectStage(env, () => { throw new Error('legacy bridge loaded CONNECT'); })(context(), () => continued++);
    assert.strictEqual(continued, 1);
    assert.strictEqual(env.extendedSettings.connect, undefined);
  });

  it('preserves explicit CONNECT configuration and stops once per boot lifecycle', function () {
    for (let cycle = 0; cycle < 2; cycle++) {
      const env = {extendedSettings: {connect: {source: 'nightscout', sourceEndpoint: 'http://127.0.0.1:1'}, bridge: {userName: 'fixture', password: 'fixture'}}};
      const ctx = context();
      let imports = 0, stopped = 0;
      const handle = {stop() { stopped++; }};
      connectStage(env, () => {
        imports++;
        return configured => {
          assert.strictEqual(configured.extendedSettings.connect.source, 'nightscout');
          return handle;
        };
      })(ctx, () => {});
      assert.strictEqual(imports, 1);
      assert.strictEqual(ctx.nightscoutConnect, handle);
      ctx.bus.emit('teardown');
      ctx.bus.emit('teardown');
      assert.strictEqual(stopped, 1);
      assert.strictEqual(ctx.bus.listenerCount('teardown'), 0);
    }
  });

  it('preserves real connector validation errors without installing a stop handler', function () {
    const ctx = context();
    let continued = 0;
    connectStage({extendedSettings: {connect: {source: 'dexcomshare'}}}, () => require('nightscout-connect'))(ctx, () => continued++);
    assert.strictEqual(continued, 1);
    assert.strictEqual(ctx.bootErrors.length, 2);
    assert.match(ctx.bootErrors[0].desc, /Account Name/);
    assert.match(ctx.bootErrors[1].desc, /Password/);
    assert.strictEqual(ctx.nightscoutConnect, undefined);
    assert.strictEqual(ctx.bus.listenerCount('teardown'), 0);
  });
  it('authenticates the real local source and shuts its actor down over two lifecycles', async function () {
    this.timeout(10000);
    const http = require('http');
    for (let cycle = 0; cycle < 2; cycle++) {
      const requests = [];
      const source = http.createServer((request, response) => {
        requests.push(request.url);
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(request.url === '/api/v1/verifyauth'
          ? {status: 200, message: {canRead: true}} : []));
      });
      await new Promise(resolve => source.listen(0, '127.0.0.1', resolve));
      const ctx = context();
      try {
        const env = {extendedSettings: {connect: {source: 'nightscout', sourceEndpoint: 'http://127.0.0.1:' + source.address().port}}};
        connectStage(env, () => require('nightscout-connect'))(ctx, () => {});
        const actor = ctx.nightscoutConnect();
        assert.strictEqual(actor.status, 1);
        ctx.bus.emit('data-processed', {data: {sgvs: []}});
        ctx.bus.emit('data-processed', {data: {sgvs: []}});
        const deadline = Date.now() + 4000;
        while (!requests.includes('/api/v1/verifyauth') && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.ok(requests.includes('/api/v1/verifyauth'), requests.join(', '));
        assert.strictEqual(requests.filter(url => url === '/api/v1/verifyauth').length, 1);
        ctx.bus.emit('teardown');
        ctx.bus.emit('teardown');
        assert.strictEqual(actor.status, 2);
      } finally {
        if (ctx.nightscoutConnect) await ctx.nightscoutConnect.stop();
        source.closeAllConnections();
        await new Promise(resolve => source.close(resolve));
      }
    }
  });

});
