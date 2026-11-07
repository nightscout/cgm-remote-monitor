#!/usr/bin/env node
'use strict';
// Source-only semantic controls over actual canonical DATA handlers and a
// recording storage adapter. No socket listener, database or working-tree edit.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
if (!process.argv[2]) throw new Error('Explicit output directory required');
const output = path.resolve(process.argv[2]);
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const controls = [
  ['early-data-ack', 'const response = await transport(envelope);',
    "if (typeof acknowledge === 'function') acknowledge({ result: 'success' });\n      const response = await transport(envelope);",
    /client acknowledgement preceded stored write/],
  ['role-data-authority', 'const actor = await authorizeSocket({ tenant, credential: envelope.credential, namespace, event, args });',
    'const actor = { tenant, permissions: { read: true, write: true, write_treatment: true } };',
    /refuses substituted cross-tenant role authority/]
];
function run (name, mutation) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-socket-data-source-'));
  try {
    fs.cpSync(path.join(root, 'lib'), path.join(scratch, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(scratch, 'tests/fixtures'), { recursive: true });
    fs.cpSync(path.join(root, 'tests/fixtures/socket-forwarding'), path.join(scratch, 'tests/fixtures/socket-forwarding'), { recursive: true });
    fs.copyFileSync(path.join(root, 'tests/socket-write-handlers.test.js'), path.join(scratch, 'tests/socket-write-handlers.test.js'));
    fs.symlinkSync(fs.realpathSync(path.join(root, 'node_modules')), path.join(scratch, 'node_modules'), 'dir');
    if (mutation) {
      const file = path.join(scratch, 'lib/server/tenant-socket-forwarding.js');
      const source = fs.readFileSync(file, 'utf8');
      assert.equal(source.split(mutation[1]).length - 1, 1, 'CONTROL-INVALID boundary');
      fs.writeFileSync(file, source.replace(mutation[1], mutation[2]));
    }
    const result = spawnSync(process.execPath, [path.join(scratch, 'node_modules/mocha/bin/mocha.js'),
      '--no-config', '--no-package', '--timeout', '5000', '--exit', 'tests/socket-write-handlers.test.js'],
    { cwd: scratch, encoding: 'utf8', timeout: 15000, env: { ...process.env, NODE_ENV: 'test', TZ: 'UTC' } });
    if (result.error) throw result.error;
    const text = (result.stdout || '') + (result.stderr || '');
    fs.writeFileSync(path.join(output, name + '.log'), text);
    assert.doesNotMatch(text, /MODULE_NOT_FOUND|SyntaxError|EPERM/);
    return { status: result.status, text };
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}
for (const control of controls) {
  const red = run(control[0], control);
  assert.notEqual(red.status, 0, 'control must fail');
  assert.match(red.text, /AssertionError/);
  assert.match(red.text, control[3]);
  assert.equal(run(control[0] + '-restored').status, 0, 'restored must pass');
  console.log(control[0] + ': semantic red / restored green');
}
