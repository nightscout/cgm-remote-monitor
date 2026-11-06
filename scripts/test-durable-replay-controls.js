#!/usr/bin/env node
'use strict';

// Authored source controls for the dormant component; no database is opened.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
if (!process.argv[2]) throw new Error('Explicit output directory required');
const output = path.resolve(process.argv[2]);
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const moduleFile = 'lib/storage/postgres-durable-replay.js';
const controls = [
  ['bootstrap', moduleFile, 'bootstrapped ? -1 : previous', 'previous', /bootstrap must not resume advanced cursor into empty projection/],
  ['typed-identity', moduleFile, '[row.domain, row.id_kind, row.doc._id]', '[row.domain, row.doc._id]', /2|typed/],
  ['soft-delete', moduleFile, 'if (row.doc.isValid === false) projection.delete(keyOf(row));',
    'if (row.doc.isValid === false) continue;', /isValid|sgv/],
  ['row-bound', moduleFile, "if (++seen > maxRows) throw new Error('REPLAY_ROW_BOUND');", '++seen;', /Missing expected rejection/],
  ['snapshot', 'lib/storage/postgres-connection.js', "run(tenant, fn, 'BEGIN ISOLATION LEVEL REPEATABLE READ')",
    "run(tenant, fn, 'BEGIN')", /Expected values to be strictly equal/]
];

function run (name, mutation) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-replay-source-control-'));
  try {
    fs.cpSync(path.join(root, 'lib'), path.join(scratch, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(scratch, 'tests'));
    for (const file of ['tenant-durable-replay.test.js', 'postgres-connection-failure.test.js']) {
      fs.copyFileSync(path.join(root, 'tests', file), path.join(scratch, 'tests', file));
    }
    fs.mkdirSync(path.join(scratch, 'migrations/candidates'), { recursive: true });
    fs.copyFileSync(path.join(root, 'migrations/candidates/postgres-consumer-checkpoint-v1.json'),
      path.join(scratch, 'migrations/candidates/postgres-consumer-checkpoint-v1.json'));
    fs.symlinkSync(fs.realpathSync(path.join(root, 'node_modules')), path.join(scratch, 'node_modules'), 'dir');
    if (mutation) {
      const [, file, from, to] = mutation;
      const full = path.join(scratch, file), source = fs.readFileSync(full, 'utf8');
      assert.equal(source.split(from).length - 1, 1, 'CONTROL-INVALID mutation boundary ' + name);
      fs.writeFileSync(full, source.replace(from, to));
    }
    const result = spawnSync(process.execPath, [path.join(scratch, 'node_modules/mocha/bin/mocha.js'), '--exit',
      '--timeout', '10000', 'tests/tenant-durable-replay.test.js', 'tests/postgres-connection-failure.test.js'], {
      cwd: scratch, encoding: 'utf8', timeout: 30000, env: { ...process.env, NODE_ENV: 'test', TZ: 'UTC' }
    });
    if (result.error) throw result.error;
    const text = (result.stdout || '') + (result.stderr || '');
    fs.writeFileSync(path.join(output, name + '.log'), text);
    assert.doesNotMatch(text, /MODULE_NOT_FOUND|SyntaxError|EPERM/);
    return { text, status: result.status };
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

for (const control of controls) {
  const [name, , , , symptom] = control;
  const red = run(name, control);
  assert.notEqual(red.status, 0, name + ' must fail');
  assert.match(red.text, /AssertionError/);
  assert.match(red.text, symptom);
  const restored = run(name + '-restored');
  assert.equal(restored.status, 0, name + ' restored positive');
  console.log(name + ': semantic red / restored green');
}
