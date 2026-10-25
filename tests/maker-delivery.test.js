'use strict';
// covers: lib/plugins/maker.js

const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.env.NIGHTSCOUT_PLUGIN_TASK_ORACLE_ROOT || path.resolve(__dirname, '..');

// Owned transport and clock: no IFTTT requests or real ten-second waits.
function fixture(options = {}) {
  const requests = [], timers = new Map();
  const https = {get(url, respond) {
    if (options.throwFirst && requests.length === 0) {
      requests.push({url});
      throw options.throwFirst;
    }
    const request = new EventEmitter();
    request.destroy = err => {request.destroyed = true; if (err) request.emit('error', err);};
    const owned = {url, request, respond() {
      const response = new EventEmitter();
      response.resume = () => {response.resumed = true;};
      response.statusCode = 200;
      respond(response);
      return response;
    }};
    requests.push(owned);
    return request;
  }};
  const module = {exports: {}};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'lib/plugins/maker.js'), 'utf8'), {
    module, console: {info() {}},
    require: name => name === 'https' ? https : require(path.resolve(root, 'lib/plugins', name)),
    setTimeout: (run, delay) => {assert.ok(delay > 0 && delay <= 30000); const key = {}; timers.set(key, run); return key;},
    clearTimeout: key => timers.delete(key)
  });
  const maker = module.exports({extendedSettings: {maker: {key: 'a b'}}});
  function expire() {
    assert.ok(timers.size > 0, 'Every pending request must have a deadline');
    for (const [key, run] of [...timers]) {timers.delete(key); run();}
  }
  return {maker, requests, timers, expire};
}

describe('Maker recipient delivery', function () {
  it('delivers to the second key while the first is stalled and bounds aggregate completion', function () {
    const {maker, requests, timers, expire} = fixture();
    let completions = 0;
    maker.makeKeyRequests({}, 'ns-event', err => {assert.equal(err.code, 'ETIMEDOUT'); completions++;});
    assert.equal(requests.length, 2, 'Both keys must start before either completes');
    const second = requests[1].respond();
    assert.equal(second.resumed, true);
    second.emit('end');
    assert.equal(completions, 0);
    assert.equal(timers.size, 1);
    expire();
    assert.equal(requests[0].request.destroyed, true);
    assert.equal(completions, 1);
    assert.equal(timers.size, 0);
    requests[0].request.emit('error', new Error('Late transport error'));
    assert.equal(completions, 1);
  });

  it('attempts other keys after a synchronous transport failure', function () {
    const error = new Error('Owned connection failure');
    const {maker, requests, timers} = fixture({throwFirst: error});
    let completions = 0;
    maker.makeKeyRequests({}, 'ns-event', err => {assert.equal(err, error); completions++;});
    assert.equal(requests.length, 2);
    requests[1].respond().emit('end');
    assert.equal(completions, 1);
    assert.equal(timers.size, 0);
  });

  it('delivers every stage to a healthy key when the other key always stalls', function () {
    const {maker, requests, timers, expire} = fixture();
    let completions = 0;
    maker.sendEvent({name: 'test', level: 'warning'}, err => {assert.equal(err.code, 'ETIMEDOUT'); completions++;});
    for (const [stage, name] of ['ns-event', 'ns-warning', 'ns-warning-test'].entries()) {
      assert.equal(requests.length, (stage + 1) * 2);
      const healthy = requests[stage * 2 + 1];
      assert.ok(healthy.url.includes('/trigger/' + name + '/with/key/b'));
      healthy.respond().emit('end');
      assert.equal(completions, 0);
      expire();
      assert.equal(requests[stage * 2].request.destroyed, true);
    }
    assert.equal(completions, 1);
    assert.equal(timers.size, 0);
  });

  it('also bounds a response body that stalls after headers arrive', function () {
    const {maker, requests, timers, expire} = fixture();
    let completions = 0;
    maker.makeKeyRequest('a', {}, 'ns-event', err => {assert.equal(err.code, 'ETIMEDOUT'); completions++;});
    const response = requests[0].respond();
    assert.equal(completions, 0);
    expire();
    response.emit('end');
    assert.equal(completions, 1);
    assert.equal(timers.size, 0);
  });

  for (const failure of ['error', 'aborted']) {
    it('completes once and clears the deadline when a response emits ' + failure, function () {
      const {maker, requests, timers} = fixture();
      let completions = 0;
      maker.makeKeyRequest('a', {}, 'ns-event', err => {assert.ok(err); completions++;});
      const response = requests[0].respond();
      response.emit(failure, new Error('Owned response failure'));
      response.emit('end');
      assert.equal(requests[0].request.destroyed, true);
      assert.equal(completions, 1);
      assert.equal(timers.size, 0);
    });
  }

  it('keeps successful results in key order despite out-of-order completion', function () {
    const {maker, requests, timers} = fixture();
    let completions = 0;
    const responses = [];
    maker.makeKeyRequests({}, 'ns-event', (err, result) => {
      assert.ifError(err);
      assert.equal(result[0], responses[0]);
      assert.equal(result[1], responses[1]);
      completions++;
    });
    responses[1] = requests[1].respond(); responses[1].emit('end');
    assert.equal(completions, 0);
    responses[0] = requests[0].respond(); responses[0].emit('end');
    assert.equal(completions, 1);
    assert.equal(timers.size, 0);
  });

  it('attempts both all-clear recipients and reports failure once after both finish', function () {
    const {maker, requests, timers} = fixture();
    const error = new Error('Owned connection reset');
    let completions = 0;
    maker.sendAllClear({}, err => {assert.equal(err, error); completions++;});
    assert.equal(requests.length, 2);
    requests[0].request.emit('error', error);
    assert.equal(completions, 0);
    requests[1].respond().emit('end');
    assert.equal(completions, 1);
    assert.equal(timers.size, 0);
  });
});
