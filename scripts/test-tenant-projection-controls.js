#!/usr/bin/env node
'use strict';

// Source/interface control only. Native PG/clinical controls are separate.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
if (!process.argv[2]) throw new Error('Explicit fresh private output directory required');
const out = path.resolve(process.argv[2]);
fs.mkdirSync(out, { mode: 0o700 });
function run (control) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-projection-control-'));
  try {
    fs.cpSync(path.join(root, 'lib'), path.join(scratch, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(scratch, 'tests'));
    fs.copyFileSync(path.join(root, 'tests/tenant-projection-evaluator.test.js'), path.join(scratch, 'tests/tenant-projection-evaluator.test.js'));
    fs.copyFileSync(path.join(root, 'package.json'), path.join(scratch, 'package.json'));
    fs.symlinkSync(fs.realpathSync(path.join(root, 'node_modules')), path.join(scratch, 'node_modules'), 'dir');
    if (control) {
      const file = path.join(scratch, 'lib/storage/postgres-projection-read.js');
      const text = fs.readFileSync(file, 'utf8');
      const needle = "if (scope.requireTenant('projection read') !== tenant) throw new Error('Projection read tenant mismatch');";
      assert.equal(text.split(needle).length, 2, 'Expected exactly one projection tenant guard');
      fs.writeFileSync(file, text.replace(needle, ''));
    }
    const result = spawnSync(process.execPath, [path.join(scratch, 'node_modules/mocha/bin/mocha.js'),
      '--no-config', '--no-package', '--exit', 'tests/tenant-projection-evaluator.test.js',
      ...(control ? ['--grep', 'refuses foreign and unbound calls before submitting SQL'] : [])], {
      cwd: scratch, encoding: 'utf8', timeout: 30000, env: { ...process.env, NODE_ENV: 'test', TZ: 'UTC' }
    });
    if (result.error) throw result.error;
    const text = (result.stdout || '') + (result.stderr || '');
    fs.writeFileSync(path.join(out, control ? 'projection-tenant-red.log' : 'restored.log'), text, { mode: 0o600 });
    assert.doesNotMatch(text, /Cannot find module|MODULE_NOT_FOUND|SyntaxError|EPERM/);
    if (control) {
      assert.equal(result.status, 1);
      assert.match(text, /0 passing/); assert.match(text, /1 failing/);
      assert.match(text, /AssertionError.*Missing expected rejection/);
    } else {
      assert.equal(result.status, 0); assert.match(text, /8 passing/);
      assert.doesNotMatch(text, /\d+ pending|\d+ failing/);
    }
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}
run(true); run(false);
console.log('projection-tenant: semantic red / restored green (source contract only)');
