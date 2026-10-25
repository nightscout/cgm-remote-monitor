'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const pluginRoot = process.env.NIGHTSCOUT_PLUGIN_TASK_ORACLE_ROOT || path.resolve(__dirname, '..');
const loadPlugin = name => require(path.join(pluginRoot, 'lib/plugins', name));

describe('Maker task ordering', function () {
  const eventNames = ['ns-event', 'ns-warning', 'ns-warning-test'];
  it('starts keys independently but waits for the whole stage, on two successive events', function () {
    const maker = loadPlugin('maker')({extendedSettings: {maker: {key: 'a b'}}});
    for (let cycle = 0; cycle < 2; cycle++) {
      const sent = [], pending = [];
      let completions = 0;
      maker.makeKeyRequest = (key, event, name, next) => {sent.push(name + ':' + key); pending.push(next);};
      maker.sendEvent({name: 'test', level: 'warning'}, err => {assert.ifError(err); completions++;});
      for (let stage = 0; stage < eventNames.length; stage++) {
        const expected = eventNames.slice(0, stage + 1).flatMap(name => [name + ':a', name + ':b']);
        assert.deepEqual(sent, expected);
        const [first, second] = pending.splice(0);
        second(null, {statusCode: 200});
        assert.equal(completions, 0);
        assert.deepEqual(sent, expected, 'The next stage must wait for both keys');
        first(null, {statusCode: 200});
      }
      assert.equal(completions, 1);
    }
  });
  it('attempts every key and stage after errors and reports the first error once', function () {
    const maker = loadPlugin('maker')({extendedSettings: {maker: {key: 'a b'}}});
    const sent = [], pending = [], error = new Error('Owned send failure');
    let completions = 0;
    maker.makeKeyRequest = (key, event, name, next) => {sent.push(name + ':' + key); pending.push(next);};
    maker.sendEvent({name: 'test', level: 'warning'}, err => {assert.equal(err, error); completions++;});
    for (let stage = 0; stage < eventNames.length; stage++) {
      assert.deepEqual(sent, eventNames.slice(0, stage + 1).flatMap(name => [name + ':a', name + ':b']));
      const [first, second] = pending.splice(0);
      first(stage === 0 ? error : new Error('Later failure'));
      assert.equal(completions, 0);
      second(null, {statusCode: 200});
    }
    assert.equal(completions, 1);
  });
  it('keeps the first error local to one event and uses every announcement key', function () {
    const maker = loadPlugin('maker')({extendedSettings: {maker: {key: 'ordinary', announcementKey: 'a b'}}});
    let fail = true;
    for (let cycle = 0; cycle < 2; cycle++) {
      const sent = [];
      let completions = 0;
      maker.makeKeyRequest = (key, event, name, next) => {sent.push(name + ':' + key); next(fail && key === 'a' ? new Error('Owned failure') : null);};
      maker.sendEvent({name: 'test', level: 'warning', isAnnouncement: true}, err => {
        if (fail) assert.equal(err.message, 'Owned failure'); else assert.ifError(err);
        completions++;
      });
      assert.deepEqual(sent, eventNames.flatMap(name => [name + ':a', name + ':b']));
      assert.equal(completions, 1);
      fail = false;
    }
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
