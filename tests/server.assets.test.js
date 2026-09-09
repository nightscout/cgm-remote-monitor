'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {fork} = require('node:child_process');
// Capture the CI database before other test suites temporarily change process.env.
const mongo = process.env.CUSTOMCONNSTR_mongo;

describe('HTTP asset and response contracts', function () {
  for (const [mode, minify] of [['production', 'true'], ['production', 'false'], ['development', 'false']]) {
    it('preserves routes, bytes and cache behavior in ' + mode + ' with DEBUG_MINIFY=' + minify, async function () {
      this.timeout(120000);
      const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
      for (const line of fs.readFileSync(path.join(__dirname, 'ci.test.env'), 'utf8').split('\n')) {
        if (!line || line.startsWith('#')) continue;
        const index = line.indexOf('=');
        env[line.slice(0, index)] = line.slice(index + 1);
      }
      if (mongo) env.CUSTOMCONNSTR_mongo = mongo;
      env.NODE_ENV = mode;
      env.DEBUG_MINIFY = minify;
      const worker = fork(path.join(__dirname, 'fixtures/http-assets/worker.js'), [], {env, stdio: ['ignore', 'pipe', 'pipe', 'ipc']});
      let output = '', result;
      for (const stream of [worker.stdout, worker.stderr]) stream.on('data', chunk => {output = (output + chunk).slice(-16000);});
      worker.on('message', message => {result = message;});
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => worker.kill('SIGKILL'), 110000);
        worker.once('error', error => {clearTimeout(timer); reject(error);});
        worker.once('exit', code => {clearTimeout(timer); resolve(code);});
      });
      assert.equal(code, 0, (result && result.error || 'HTTP fixture failed') + '\n' + output);
      assert.ok(result && result.results.length >= 18, 'Incomplete HTTP contract run');
    });
  }
});
