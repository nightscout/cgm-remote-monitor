'use strict';
// covers: scripts/test-multitenant.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const inventory = require('../scripts/test-multitenant');
const root = path.resolve(__dirname, '..');
const readSource = file => fs.readFileSync(path.join(root, file), 'utf8');
const unlisted = (file, source) => inventory.checkInventory({inventory: [], testFiles: [file], tierOf: () => 'integration', readSource: () => source});

describe('multitenant inventory executable environment consumption', function () {
  it('accepts the actual source-only bootstrap test without hiding its synthetic admin URI document', function () {
    const file = 'tests/realtime-bootstrap.test.js', source = readSource(file);
    assert(source.includes('NS_TEST_POSTGRES_ADMIN_URI'), 'synthetic input remains explicit');
    assert.equal(inventory.classifyOptInSource(source).needed, false, 'INVENTORY_SYNTHETIC_DOCUMENT_IS_NOT_GLOBAL_ENV');
    assert.deepEqual(unlisted(file, source), []);
  });
  it('detects an unlisted actual admin-URI-only database suite', function () {
    const file = 'tests/postgres-entries-write.test.js', source = readSource(file);
    assert.equal(inventory.classifyOptInSource(source).needed, true, 'INVENTORY_UNLISTED_ADMIN_DETECTED');
    assert.match(unlisted(file, source)[0], /opt-in test file missing/);
  });
  it('detects unlisted actual flag-consuming database suites and a planted flag-only opt-in', function () {
    for (const file of ['tests/evaluator-consumers.integration.test.js', 'tests/tenant-current-state-recovery-proof.integration.test.js']) {
      assert.equal(inventory.classifyOptInSource(readSource(file)).needed, true);
      assert.match(unlisted(file, readSource(file))[0], /opt-in test file missing/);
    }
    const source = "const {optInSuite: selected} = require('./support/opt-in'); selected(process.env['NS_PLANTED_DATABASE_TEST'] === '1', 'explicit requirement');";
    assert.equal(inventory.classifyOptInSource(source).needed, true, 'INVENTORY_UNLISTED_FLAG_DETECTED');
    assert.match(unlisted('tests/planted-flag.test.js', source)[0], /opt-in test file missing/);
  });
  it('preserves direct bracket destructured aliased and imported process environment reads', function () {
    for (const source of [
      'const uri = process.env.NS_TEST_POSTGRES_ADMIN_URI;',
      "const uri = process['env']['NS_TEST_POSTGRES_ADMIN_URI'];",
      'const {NS_TEST_POSTGRES_ADMIN_URI: uri} = process.env;',
      "let uri; ({NS_TEST_POSTGRES_ADMIN_URI: uri} = process['env']);",
      'const env = process.env; const uri = env.NS_TEST_POSTGRES_ADMIN_URI;',
      "const {env: inherited} = process; const uri = inherited['NS_TEST_POSTGRES_ADMIN_URI'];",
      "const p = require('node:process'); const uri = p.env.NS_TEST_POSTGRES_ADMIN_URI;",
      "import process from 'node:process'; const uri = process.env.NS_TEST_POSTGRES_ADMIN_URI;"
    ]) assert.equal(inventory.classifyOptInSource(source).needed, true, source);
  });
  it('does not execute or count comments source examples synthetic environments shadowed process or write-only assignments', function () {
    for (const source of [
      '// process.env.NS_TEST_POSTGRES_ADMIN_URI\nconst value = 1;',
      'const example = "process.env.NS_TEST_POSTGRES_ADMIN_URI";',
      "const env = {NS_TEST_POSTGRES_ADMIN_URI: 'synthetic'}; const uri = env.NS_TEST_POSTGRES_ADMIN_URI;",
      'function example(process) { return process.env.NS_TEST_POSTGRES_ADMIN_URI; }',
      "process.env.NS_TEST_POSTGRES_ADMIN_URI = 'synthetic';",
      "throw new Error('Parsing must not execute source');"
    ]) assert.equal(inventory.classifyOptInSource(source).needed, false, source);
  });
  it('fails closed when candidate source cannot be parsed and preserves ordinary inventory membership checks', function () {
    assert.match(unlisted('tests/broken-source.test.js', 'const x = ; // process.env.NS_TEST_POSTGRES_ADMIN_URI')[0], /cannot classify opt-in source/);
    const listed = [{file: 'tests/listed.test.js'}];
    assert.match(inventory.checkInventory({inventory: listed, testFiles: [], tierOf: () => 'integration', readSource: () => ''})[0], /not a test file/);
    assert.match(inventory.checkInventory({inventory: listed, testFiles: ['tests/listed.test.js'], tierOf: () => 'unit', readSource: () => ''})[0], /not integration/);
  });
});
