'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {createRequire} = require('module');
const {EventEmitter} = require('events');
const levels = require('../lib/levels');

function loadPushover(loadProvider, transport) {
  const filename = path.resolve(__dirname, '../lib/plugins/pushover.js');
  const localRequire = createRequire(filename);
  const sandbox = {module: {exports: {}}, console: {info() {}, error() {}}, require(name) {
    if (name === 'pushover-notifications') return loadProvider();
    if (name === 'https' && transport) return transport;
    return localRequire(name);
  }};
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, {filename});
  return sandbox.module.exports;
}

function configuration(settings) {
  return {settings: {baseURL: 'https://nightscout.test'}, extendedSettings: {pushover: settings}};
}

function notification(level = levels.WARN) {
  return {title: 'Fixture', message: 'Fixture details', level};
}

describe('Pushover lazy loading and transport lifecycle', function () {
  const disabled = [
    ['absent extended settings', {}],
    ['absent Pushover settings', {extendedSettings: {}}],
    ['missing token', configuration({userKey: 'fixture-user'})],
    ['missing recipients', configuration({apiToken: 'fixture-token'})],
    ['disabled recipients', configuration({apiToken: 'fixture-token', userKey: false, alarmKey: false, announcementKey: false})]
  ];
  disabled.forEach(([name, env]) => {
    it('does not import the provider with ' + name, function () {
      const init = loadPushover(() => { throw new Error('Unconfigured provider imported'); });
      assert.strictEqual(init(env, {levels}), null);
      assert.strictEqual(init(env, {levels}), null);
    });
  });

  it('initializes one provider per configured instance and preserves recipient selection and receipts', function () {
    let instances = 0;
    const deliveries = [];
    const init = loadPushover(() => function Provider(options) {
      instances++;
      assert.strictEqual(options.token, 'fixture-token');
      this.send = (message, callback) => {
        deliveries.push({...message});
        callback(null, {receipt: 'fixture-receipt'});
      };
    });
    for (let cycle = 1; cycle <= 2; cycle++) {
      const pushover = init(configuration({apiToken: 'fixture-token', userKey: 'user-a user-b', alarmKey: 'alarm', announcementKey: 'announcement'}), {levels});
      let callbacks = 0;
      const callback = (error, result) => {
        assert.ifError(error);
        assert.strictEqual(result.receipt, 'fixture-receipt');
        callbacks++;
      };
      pushover.send(notification(levels.INFO), callback);
      pushover.send(notification(levels.URGENT), callback);
      pushover.send({...notification(), isAnnouncement: true}, callback);
      assert.strictEqual(callbacks, 4);
      assert.strictEqual(instances, cycle);
      const sent = deliveries.slice(-4);
      assert.deepStrictEqual(sent.map(message => message.user), ['user-a', 'user-b', 'alarm', 'announcement']);
      assert.strictEqual(sent[2].priority, 2);
      assert.strictEqual(sent[2].retry, 120);
      assert.strictEqual(sent[2].expire, 900);
      assert.strictEqual(sent[2].callback, 'https://nightscout.test/api/v1/notifications/pushovercallback');
    }
  });

  it('preserves send errors and disabled-alarm behavior over repeated sends', function () {
    const failure = new Error('fixture send error');
    let sends = 0;
    const pushover = loadPushover(() => function Provider() {
      this.send = (message, callback) => { sends++; callback(failure); };
    })(configuration({apiToken: 'fixture-token', userKey: 'user', alarmKey: false}), {levels});
    for (let cycle = 1; cycle <= 2; cycle++) {
      let callbacks = 0;
      pushover.send(notification(levels.INFO), error => { assert.strictEqual(error, failure); callbacks++; });
      pushover.send(notification(), error => { assert.strictEqual(error, 'no-key-defined'); callbacks++; });
      assert.strictEqual(callbacks, 2);
      assert.strictEqual(sends, cycle);
    }
  });

  for (const failed of [false, true]) {
    it('preserves receipt cancellation ' + (failed ? 'errors' : 'success') + ' over repeated calls', function () {
      const failure = new Error('fixture cancellation error');
      let requests = 0, resumed = 0;
      const transport = {get(url, callback) {
        requests++;
        assert.strictEqual(url, 'https://api.pushover.net/1/receipts/fixture-receipt/cancel.json?token=fixture-token');
        const request = new EventEmitter();
        process.nextTick(() => {
          if (failed) request.emit('error', failure);
          else callback({statusCode: 200, resume() { resumed++; }});
        });
        return request;
      }};
      const pushover = loadPushover(() => function Provider() {}, transport)(configuration({apiToken: 'fixture-token', userKey: 'user'}), {levels});
      return (async () => {
        for (let cycle = 1; cycle <= 2; cycle++) {
          await new Promise(resolve => pushover.cancelWithReceipt('fixture-receipt', (error, response) => {
            if (failed) assert.strictEqual(error, failure);
            else { assert.ifError(error); assert.strictEqual(response.statusCode, 200); }
            resolve();
          }));
          assert.strictEqual(requests, cycle);
          assert.strictEqual(resumed, failed ? 0 : cycle);
        }
      })();
    });
  }
});
