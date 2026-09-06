'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');
const {once} = require('node:events');
const parseEnv = require('../bin/with-env');
const runner = path.resolve(__dirname, '../bin/with-env.js');
const implementations = [['native', parseEnv]];
if (process.env.NIGHTSCOUT_ENV_ORACLE) implementations.unshift(['legacy', require(process.env.NIGHTSCOUT_ENV_ORACLE).parseEnvString]);
for (const [name, parse] of implementations) describe(name + ' env file grammar', function () {
  for (const [input, expected] of [
    ['OWNED=one#two\n', {OWNED: 'one#two'}],
    ["OWNED='one\\ntwo'\n", {OWNED: 'one\ntwo'}],
    ['OWNED="one\\ntwo"\n', {OWNED: 'one\ntwo'}],
    ['OWNED="one\ntwo"\n', {OWNED: 'one'}],
    ['export OWNED=value\n', {'export OWNED': 'value'}],
    ['OWNED=value # comment\n', {OWNED: 'value # comment'}],
    ['# comment\n OWNED = "hello world"\r\nEMPTY=\nOWNED=last\n', {OWNED: 'last', EMPTY: ''}]
  ]) it('preserves ' + JSON.stringify(input), () => assert.deepEqual(parse(input), expected));
});

describe('Native env runner process contract', function () {
  this.timeout(10000);
  let directory, file, probe;
  before(function () {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nightscout-env-test-'));
    file = path.join(directory, 'owned env file.env');
    probe = path.join(directory, 'owned probe.js');
    fs.writeFileSync(file, 'OWNED_VALUE=file#value\nNODE_OPTIONS=--stack-trace-limit=17\n');
    fs.writeFileSync(probe, 'console.log(JSON.stringify({value:process.env.OWNED_VALUE,inherited:process.env.OWNED_INHERITED,args:process.argv.slice(2),stack:Error.stackTraceLimit}))');
  });
  after(function () {fs.rmSync(directory, {recursive: true, force: true});});
  function run(args) {
    return spawnSync(process.execPath, [runner, file, ...args], {encoding: 'utf8', env: {...process.env, OWNED_VALUE: 'inherited', OWNED_INHERITED: 'retained'}});
  }
  it('overrides inherited values, applies NODE_OPTIONS before startup and preserves arguments', function () {
    const result = run([probe, 'space value', 'literal$VALUE']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {value: 'file#value', inherited: 'retained', args: ['space value', 'literal$VALUE'], stack: 17});
  });
  it('passes explicit Node flags and nonzero exit status', function () {
    assert.equal(JSON.parse(run(['--stack-trace-limit=19', probe]).stdout).stack, 19);
    assert.equal(run(['-e', 'process.exit(23)']).status, 23);
  });
  it('fails without running the child when the env file is missing', function () {
    const result = spawnSync(process.execPath, [runner, path.join(directory, 'missing.env'), '-e', 'console.log("SHOULD_NOT_RUN")'], {encoding: 'utf8'});
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
  });
  it('passes file values through nyc into a Mocha child', function () {
    const test = path.join(directory, 'owned.test.js');
    fs.writeFileSync(test, 'it("inherits owned file value",()=>require("node:assert/strict").equal(process.env.OWNED_VALUE,"file#value"))');
    const result = run([require.resolve('nyc/bin/nyc.js'), '--silent', '--temp-dir', path.join(directory, 'coverage'), process.execPath, require.resolve('mocha/bin/mocha.js'), test]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /1 passing/);
  });
  async function deadline(promise) {
    let timer;
    try {
      return await Promise.race([promise, new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Owned env-runner child did not respond')), 3000);
      })]);
    } finally {clearTimeout(timer);}
  }
  it('forwards termination and reaps the child in two successive runs', async function () {
    if (process.platform === 'win32') this.skip();
    const script = path.join(directory, 'owned-signal.js');
    fs.writeFileSync(script, 'process.on("SIGTERM",()=>{console.log("STOPPED");process.exit(0)});console.log("READY");setInterval(()=>{},1000)');
    for (let cycle = 0; cycle < 2; cycle++) {
      const child = spawn(process.execPath, [runner, file, script], {stdio: ['ignore', 'pipe', 'pipe']});
      let output = '';
      const exit = once(child, 'close');
      try {
        await deadline(new Promise((resolve, reject) => {
          child.once('error', reject);
          child.stdout.on('data', chunk => {output += chunk; if (output.includes('READY')) resolve();});
        }));
        child.kill('SIGTERM');
        const [code, signal] = await deadline(exit);
        assert.equal(code, null);
        assert.equal(signal, 'SIGTERM');
        assert.match(output, /STOPPED/);
      } finally {if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');}
    }
  });
});
