'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');

(process.platform === 'win32' ? describe.skip : describe)('Development watch policy', function () {
  this.timeout(120000);
  it('preserves configured ignores and application watching through two restart cycles', async function () {
    const root = path.resolve(__dirname, '..');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nightscout-watch-result-'));
    const output = path.join(tmp, 'result.json');
    try {
      await promisify(execFile)('python3', [path.join(root, 'tools/probe-development-watch.py'),
        '--node', process.execPath, '--dependency-root', root, '--output', output], {timeout:100000});
      const result = JSON.parse(await fs.readFile(output, 'utf8'));
      assert.equal(result.node, process.version);
      for (const [mode, expected] of Object.entries({
        nodemon:{'tests/ignored.js':0, 'bin/ignored.js':0, 'static/unimported.js':1, 'node_modules/owned-watch-dep/index.js':0, 'lib/loaded.js':1},
        native:{'tests/ignored.js':0, 'bin/ignored.js':0, 'static/unimported.js':0, 'node_modules/owned-watch-dep/index.js':1, 'lib/loaded.js':1}
      })) {
        const variant = result.variants[mode];
        assert.equal(variant.cycles.length, 2);
        let previous = variant.initial.pid;
        for (const cycle of variant.cycles) {
          for (const [file, count] of Object.entries(expected)) assert.equal(cycle[file], count, mode + ': ' + file);
          assert.equal(cycle.debuggerAfterRestart.inspectorReachable, true);
          assert.notEqual(cycle.debuggerAfterRestart.pid, previous);
          previous = cycle.debuggerAfterRestart.pid;
        }
      }
    } finally {await fs.rm(tmp, {recursive:true, force:true});}
  });
});
