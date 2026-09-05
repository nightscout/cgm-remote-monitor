'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadLoop(loadProvider) {
  const filename = path.resolve(__dirname, '../lib/server/loop.js');
  const sandbox = {module: {exports: {}}, console: {log() {}, error() {}}, require(name) {
    assert.strictEqual(name, '@parse/node-apn');
    return loadProvider();
  }};
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, {filename});
  return sandbox.module.exports;
}

function configuration() {
  return {
    env: {extendedSettings: {loop: {apnsKey: 'fixture-key', apnsKeyId: 'fixture-id', developerTeamId: 'TEAMID1234'}}},
    ctx: {ddata: {profiles: [{loopSettings: {deviceToken: 'fixture-token', bundleIdentifier: 'example.fixture'}}]}}
  };
}

function unusedProvider() { throw new Error('Provider loaded before a valid notification'); }

describe('APN provider loading and lifecycle', function () {
  it('does not load APN when initializing the server loop', function () {
    const {env, ctx} = configuration();
    loadLoop(unusedProvider)(env, ctx);
  });

  const invalid = [
    ['missing key', fixture => { delete fixture.env.extendedSettings.loop.apnsKey; }, {}, /LOOP_APNS_KEY not set/],
    ['missing key ID', fixture => { delete fixture.env.extendedSettings.loop.apnsKeyId; }, {}, /LOOP_APNS_KEY_ID/],
    ['invalid team', fixture => { fixture.env.extendedSettings.loop.developerTeamId = 'short'; }, {}, /TEAM_ID/],
    ['missing profile', fixture => { fixture.ctx.ddata.profiles = []; }, {}, /loopSettings/],
    ['missing token', fixture => { delete fixture.ctx.ddata.profiles[0].loopSettings.deviceToken; }, {}, /deviceToken/],
    ['missing bundle ID', fixture => { delete fixture.ctx.ddata.profiles[0].loopSettings.bundleIdentifier; }, {}, /bundleIdentifier/],
    ['invalid carbs', () => {}, {eventType: 'Remote Carbs Entry', remoteCarbs: 0}, /Incorrect carbs/],
    ['invalid bolus', () => {}, {eventType: 'Remote Bolus Entry', remoteBolus: 0}, /Incorrect bolus/],
    ['unknown event', () => {}, {eventType: 'invalid'}, /Unhandled event/]
  ];
  invalid.forEach(([name, change, data, expected]) => {
    it('rejects ' + name + ' without opening a provider', function () {
      const fixture = configuration();
      change(fixture);
      let calls = 0;
      loadLoop(unusedProvider)(fixture.env, fixture.ctx).sendNotification(data, '127.0.0.1', error => {
        calls++;
        assert.match(error, expected);
      });
      assert.strictEqual(calls, 1);
    });
  });

  for (const scenario of ['sent', 'rejected', 'failed-response']) {
    it('shuts down after ' + scenario + ' over two notifications', async function () {
      const fixture = configuration();
      const sent = [];
      let shutdowns = 0, providers = 0;
      const loop = loadLoop(() => {
        return {
          Notification: function () {},
          Provider: function () {
            providers++;
            this.shutdown = () => { shutdowns++; };
            this.send = async (notification, tokens) => {
              sent.push({notification, tokens});
              if (scenario === 'rejected') throw new Error('fixture transport failure');
              return scenario === 'sent' ? {sent: [{}]} : {failed: [{response: {reason: 'BadDeviceToken'}}]};
            };
          }
        };
      })(fixture.env, fixture.ctx);
      for (let cycle = 1; cycle <= 2; cycle++) {
        let completed = 0, failure;
        loop.sendNotification({eventType: 'Temporary Override Cancel'}, '127.0.0.1', error => { completed++; failure = error; });
        await new Promise(resolve => setImmediate(resolve));
        assert.strictEqual(completed, 1);
        assert.strictEqual(providers, cycle);
        assert.strictEqual(shutdowns, cycle);
        if (scenario === 'sent') assert.strictEqual(failure, undefined);
        else assert.match(failure, scenario === 'rejected' ? /fixture transport failure/ : /BadDeviceToken/);
      }
      assert.strictEqual(sent[0].tokens[0], 'fixture-token');
      assert.strictEqual(sent[0].notification.topic, 'example.fixture');
      assert.strictEqual(sent[0].notification.payload['cancel-temporary-override'], 'true');
      assert.strictEqual(Date.parse(sent[0].notification.payload.expiration) - Date.parse(sent[0].notification.payload['sent-at']), 300000);
    });
  }
  it('shuts down and preserves synchronous transport errors on repeated calls', function () {
    const fixture = configuration();
    const failure = new Error('fixture synchronous failure');
    let shutdowns = 0;
    const loop = loadLoop(() => ({
      Notification: function () {},
      Provider: function () {
        this.send = () => { throw failure; };
        this.shutdown = () => { shutdowns++; };
      }
    }))(fixture.env, fixture.ctx);
    for (let cycle = 1; cycle <= 2; cycle++) {
      assert.throws(() => loop.sendNotification({eventType: 'Temporary Override Cancel'}, '127.0.0.1', () => {
        throw new Error('Synchronous failure unexpectedly invoked callback');
      }), error => error === failure);
      assert.strictEqual(shutdowns, cycle);
    }
  });

});
