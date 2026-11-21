#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
if (!process.argv[2]) throw new Error('Explicit private output directory required');
const output = path.resolve(process.argv[2]); fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const controls = [
  ['stale-management-state', 'lib/server/serve/owner-preview-authentication.js',
    'verifyToken: createVerifier(verification), snapshot',
    "verifyToken: createVerifier(verification), snapshot: async claims => ({ active: true, sessionActive: true, keyActive: true, credentialVersion: claims.cv, sessionExpiresAt: claims.exp + 1 })",
    /reads the current snapshot on every operation/],
  ['listener-mix', 'lib/server/serve/index.js', 'const { app } = preview ? ctx : role.createApp(env, ctx);',
    "const { app } = preview ? (spec.role === 'api' ? contexts['tenant-admin'] : ctx) : role.createApp(env, ctx);",
    /data listener must not expose management route/]
];
function run (name, control) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-owner-source-'));
  try {
    fs.cpSync(path.join(root, 'lib'), path.join(scratch, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(scratch, 'tests'));
    fs.copyFileSync(path.join(root, 'tests/owner-preview.test.js'), path.join(scratch, 'tests/owner-preview.test.js'));
    fs.symlinkSync(fs.realpathSync(path.join(root, 'node_modules')), path.join(scratch, 'node_modules'), 'dir');
    if (control) {
      const file = path.join(scratch, control[1]), source = fs.readFileSync(file, 'utf8');
      assert.equal(source.split(control[2]).length - 1, 1, 'CONTROL-INVALID boundary'); fs.writeFileSync(file, source.replace(control[2], control[3]));
    }
    const result = spawnSync(process.execPath, [path.join(scratch, 'node_modules/mocha/bin/mocha.js'),
      '--no-config', '--no-package', '--exit', '--timeout', '5000', 'tests/owner-preview.test.js'],
    { cwd: scratch, encoding: 'utf8', timeout: 15000, env: { ...process.env, NODE_ENV: 'test', TZ: 'UTC' } });
    if (result.error) throw result.error;
    const text = (result.stdout || '') + (result.stderr || ''); fs.writeFileSync(path.join(output, name + '.log'), text);
    assert.doesNotMatch(text, /MODULE_NOT_FOUND|SyntaxError|EPERM/); return { status: result.status, text };
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}
for (const control of controls) {
  const result = run(control[0], control);
  assert.notEqual(result.status, 0); assert.match(result.text, /AssertionError/); assert.match(result.text, control[4]);
  assert.equal(run(control[0] + '-restored').status, 0); console.log(control[0] + ': semantic red / restored green');
}
