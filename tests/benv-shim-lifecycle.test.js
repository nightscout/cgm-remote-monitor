'use strict';

const assert = require('assert');
const {spawnSync} = require('child_process');
const path = require('path');

// A fresh process preserves evidence of Node's original native constructors;
// unrelated DOM fixtures in the full suite must not define our baseline.
describe('legacy DOM shim cleanup', function () {
  it('restores native globals and event dispatch after repeated setup and teardown', function () {
    const script = `
      const assert = require('assert');
      const benv = require('./tests/fixtures/benv-shim');
      const names = ['window', 'document', 'navigator', 'Event', 'CustomEvent', 'btoa', 'atob', '$', 'jQuery'];
      const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(global, name)]));
      const nativeEvent = global.Event;
      for (let cycle = 0; cycle < 2; cycle++) {
        benv.setup();
        const firstWindow = global.window;
        benv.setup();
        assert.notStrictEqual(global.window, firstWindow);
        assert.notStrictEqual(global.Event, nativeEvent);
        benv.expose({fixtureTemporaryGlobal: 'fixture'});
        benv.teardown(false);
        assert.strictEqual(global.fixtureTemporaryGlobal, undefined);
        assert.ok(global.window.document);
        benv.teardown(true);
        benv.teardown(true);
        for (const name of names) assert.deepStrictEqual(Object.getOwnPropertyDescriptor(global, name), originals.get(name), name);
        assert.strictEqual(global.Event, nativeEvent);
        const target = new EventTarget();
        let calls = 0;
        target.addEventListener('fixture', () => calls++);
        assert.strictEqual(target.dispatchEvent(new Event('fixture')), true);
        assert.strictEqual(calls, 1);
      }
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 5000
    });
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  });
});
