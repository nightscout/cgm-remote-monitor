'use strict';

const assert = require('assert');
const d3 = require('./fixtures/d3');

describe('D3 color compatibility and security', function () {
  it('preserves chart colors and interpolation', function () {
    assert.strictEqual(d3.color('green').formatHex(), '#008000');
    assert.strictEqual(d3.color('#0099ff').formatRgb(), 'rgb(0, 153, 255)');
    assert.strictEqual(d3.color('rgba(255, 0, 0, 0.5)').opacity, 0.5);
    assert.strictEqual(d3.interpolateRgb('white', '#0099ff')(0.5), 'rgb(128, 204, 255)');
    assert.strictEqual(d3.color('invalid'), null);
  });

  it('rejects pathological color input without catastrophic backtracking', function () {
    // Separate process gives a hard upper bound even if vulnerable parsing returns.
    this.timeout(6000);
    const result = require('child_process').spawnSync(process.execPath, [
      '-e', "const d3 = require('./tests/fixtures/d3'); const assert = require('assert'); " +
        "assert.strictEqual(d3.color('hsl(' + '1'.repeat(1000000) + '!'), null);"
    ], {cwd: require('path').resolve(__dirname, '..'), timeout: 4000, encoding: 'utf8'});
    assert.ifError(result.error);
    assert.strictEqual(result.status, 0, result.stderr);
  });
});
