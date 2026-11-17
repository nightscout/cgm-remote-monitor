'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

describe('HTTP middleware security regressions', function () {
  for (const [mode, expected] of [['parser', 'compressed parser survived'], ['compression', 'compression cleanup passed']]) {
    it('handles ' + mode + ' without a crash or leaked stream', function () {
      const result = spawnSync(process.execPath, [path.join(__dirname, 'fixtures/http-middleware-probe.js'), mode], {
        encoding: 'utf8', timeout: 4500,
        env: {NODE_ENV: 'test', PATH: process.env.PATH}
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null, result.stderr);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.ok(result.stdout.includes(expected), result.stdout);
    });
  }
});
