'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const pluginRoot = process.env.NIGHTSCOUT_PLUGIN_TASK_ORACLE_ROOT || path.resolve(__dirname, '..');
const loadPlugin = name => require(path.join(pluginRoot, 'lib/plugins', name));

describe('Maker task ordering', function () {
  it('finishes every key in a stage before advancing, on two successive events', function () {
    const maker = loadPlugin('maker')({extendedSettings: {maker: {key: 'a b'}}});
    for (let cycle = 0; cycle < 2; cycle++) {
      const sent = [], pending = [];
      let completions = 0;
      maker.makeKeyRequest = (key, event, name, callback) => {sent.push(name + ':' + key); pending.push(callback);};
      maker.sendEvent({name: 'test', level: 'warning'}, err => {assert.ifError(err); completions++;});
      const expected = ['ns-event:a', 'ns-event:b', 'ns-warning:a', 'ns-warning:b', 'ns-warning-test:a', 'ns-warning-test:b'];
      for (let i = 0; i < expected.length; i++) {
        assert.deepEqual(sent, expected.slice(0, i + 1));
        assert.equal(completions, 0);
        pending.shift()(null, {statusCode: 200});
      }
      assert.equal(completions, 1);
    }
  });
  it('stops later keys and stages on the first send failure', function () {
    const maker = loadPlugin('maker')({extendedSettings: {maker: {key: 'a b'}}});
    const sent = [], error = new Error('Owned send failure');
    let completions = 0;
    maker.makeKeyRequest = (key, event, name, next) => {sent.push(name + ':' + key); next(error);};
    maker.sendEvent({name: 'test', level: 'warning'}, err => {assert.equal(err, error); completions++;});
    assert.deepEqual(sent, ['ns-event:a']); assert.equal(completions, 1);
  });
});

for (const name of ['alexa', 'googlehome']) {
  describe(name + ' bounded rollup tasks', function () {
    it('keeps ten handlers in flight and returns priority-sorted text after two rollups', function () {
      const plugin = loadPlugin(name)();
      let pending, started;
      for (let i = 0; i < 12; i++) plugin.addToRollup('owned', (slots, sbx, next) => {started.push(i); pending[i] = next;}, String(i));
      for (let cycle = 0; cycle < 2; cycle++) {
        pending = []; started = []; let calls = 0, text;
        plugin.getRollup('owned', {}, {}, 'en', result => {calls++; text = result;});
        assert.equal(started.length, 10);
        pending[9](null, {priority: 9, results: '9'}); pending[8](null, {priority: 8, results: '8'});
        assert.equal(started.length, 12);
        for (const i of [11, 10, 7, 6, 5, 4, 3, 2, 1, 0]) pending[i](null, {priority: i, results: String(i)});
        assert.equal(calls, 1); assert.equal(text, '0 1 2 3 4 5 6 7 8 9 10 11');
      }
    });
    it('returns completed text once on error without crashing on an empty result', function () {
      const plugin = loadPlugin(name)();
      plugin.addToRollup('owned', (slots, sbx, next) => next(null, {results: 'available'}), 'success');
      plugin.addToRollup('owned', (slots, sbx, next) => next(new Error('Owned handler failure')), 'failure');
      let calls = 0;
      plugin.getRollup('owned', {}, {}, 'en', result => {assert.equal(result, 'available'); calls++;});
      assert.equal(calls, 1);
    });
  });
}
