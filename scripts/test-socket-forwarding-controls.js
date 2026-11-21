#!/usr/bin/env node
'use strict';

// Source-only authored controls. No real socket, HTTP, database or provider.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
if (!process.argv[2]) throw new Error('Explicit output directory required');
const output = path.resolve(process.argv[2]);
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const moduleFile = 'lib/server/tenant-socket-forwarding.js';
const controls = [
  ['early-ack', 'const response = await transport(envelope);',
    "if (typeof acknowledge === 'function') acknowledge({ result: 'success' });\n      const response = await transport(envelope);",
    /no acknowledgement may precede API confirmation/],
  ['role-authority', 'const actor = await authorizeSocket({ tenant, credential: envelope.credential, namespace, event, args });',
    "const actor = { tenant, principal: 'synthetic-role' };", /AssertionError/],
  ['tenantless-ack', "const replyArgs = await execute({ tenant, actor, namespace, event, args, source: 'socket' });",
    "const replyArgs = await execute({ tenant: event === 'ack' ? undefined : tenant, actor, namespace, event, args, source: 'socket' });",
    /ack bookkeeping must retain the verified tenant/]
];
function run (name, mutation) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-socket-forward-source-'));
  try {
    for (const directory of ['lib/server', 'tests/fixtures']) fs.mkdirSync(path.join(scratch, directory), { recursive: true });
    let source = fs.readFileSync(path.join(root, moduleFile), 'utf8');
    if (mutation) {
      const [, from, to] = mutation;
      assert.equal(source.split(from).length - 1, 1, 'CONTROL-INVALID boundary ' + name);
      source = source.replace(from, to);
    }
    fs.writeFileSync(path.join(scratch, moduleFile), source);
    fs.copyFileSync(path.join(root, 'tests/tenant-socket-forwarding.test.js'), path.join(scratch, 'tests/tenant-socket-forwarding.test.js'));
    fs.cpSync(path.join(root, 'tests/fixtures/socket-forwarding'), path.join(scratch, 'tests/fixtures/socket-forwarding'), { recursive: true });
    fs.symlinkSync(fs.realpathSync(path.join(root, 'node_modules')), path.join(scratch, 'node_modules'), 'dir');
    const result = spawnSync(process.execPath, [path.join(scratch, 'node_modules/mocha/bin/mocha.js'),
      '--no-config', '--no-package', '--exit', '--timeout', '5000', 'tests/tenant-socket-forwarding.test.js'],
    { cwd: scratch, encoding: 'utf8', timeout: 15000, env: { ...process.env, NODE_ENV: 'test', TZ: 'UTC' } });
    if (result.error) throw result.error;
    const text = (result.stdout || '') + (result.stderr || '');
    fs.writeFileSync(path.join(output, name + '.log'), text);
    assert.doesNotMatch(text, /MODULE_NOT_FOUND|SyntaxError|EPERM/);
    return { status: result.status, text };
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}
for (const control of controls) {
  const [name, , , symptom] = control;
  const red = run(name, control);
  assert.notEqual(red.status, 0, name + ' must fail');
  assert.match(red.text, /AssertionError/);
  assert.match(red.text, symptom);
  assert.equal(run(name + '-restored').status, 0, name + ' restored');
  console.log(name + ': semantic red / restored green');
}
