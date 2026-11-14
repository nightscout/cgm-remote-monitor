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
  it('covers actual opt-in files and selects the new native groups with their required resources', function () {
    assert.deepEqual(inventory.checkInventory(),[],'ACTUAL_CORPUS_INVENTORY_COMPLETE');
    const rows=new Map(inventory.INVENTORY.map(row=>[row.file,row]));
    const pgstream=['tests/pgstream-bootstrap-batch.integration.test.js','tests/pgstream-checkpoint.integration.test.js','tests/pgstream-single-receipt.integration.test.js'];
    for(const file of pgstream){const row=rows.get(file);assert(row);assert.deepEqual(row.flags,{NS_PGSTREAM_ROLE_TEST:'1'});assert.deepEqual(row.shared,['postgres']);assert.deepEqual(row.own,[]);}
    const rest=rows.get('tests/preview-entries-acquisition.integration.test.js');assert.deepEqual(rest.flags,{NS_REST_ACQUISITION_NATIVE:'1'});assert.deepEqual(rest.shared,[]);assert.deepEqual(rest.own,['postgres']);
    const protocol='tests/evaluator-preview-registry-fixture.test.js';assert.equal(rows.has(protocol),false);
    assert.deepEqual(unlisted(protocol,readSource(protocol)),[]);
    const changed=readSource(protocol)+"\nconst {optInSuite: native} = require('./support/opt-in'); native(process.env.NS_PLANTED_PROTOCOL_TEST === '1','native requirement');";
    assert.match(unlisted(protocol,changed)[0],/opt-in test file missing/,'NATIVE_OPTIN_REVOKES_PROTOCOL_EXCEPTION');
    const omitted=inventory.INVENTORY.filter(row=>!pgstream.includes(row.file));
    const red=inventory.checkInventory({inventory:omitted});assert.equal(red.length,3);assert(red.every(value=>value.includes('opt-in test file missing')),'MISSING_NATIVE_GROUPS_MUST_REFUSE');
  });
  it('requires maintained producer capabilities before a product fixture can allocate resources', function () {
    const selected = [{ flags: { NS_EVALUATOR_CONSUMERS_TEST: '1' } }];
    const source = { NS_MULTITENANT_PGSTREAM_POSTGRES_IMAGE: 'sha256:' + 'a'.repeat(64), NS_RT_BOOTSTRAP_PGSTREAM_BINARY: '/synthetic/pgstream', NS_RT_BOOTSTRAP_PGSTREAM_SHA256: 'b'.repeat(64), NS_RT_BOOTSTRAP_PGSTREAM_RECEIVER_PORT: '19042', NS_RT_BOOTSTRAP_PGSTREAM_SUBSCRIPTIONS_PORT: '19043', NS_RT_BOOTSTRAP_PGSTREAM_BINDING_JSON: '{}' };
    const good = () => inventory.producerSelection(selected, source);
    assert.match(good().image, /^sha256:/); assert(good().command.includes('output_plugin_libraries=wal2json'));
    for (const field of Object.keys(source)) {
      const broken = { ...source }; delete broken[field];
      assert.throws(() => inventory.producerSelection(selected, broken), /MAINTAINED_PRODUCER_CAPABILITY_REQUIRED/);
      assert.deepEqual(good().command.slice(0, 2), ['-c', 'wal_level=logical']);
    }
    assert.equal(inventory.producerSelection([{ flags: { NS_PGSTREAM_ROLE_TEST: '1' } }], {}), null, 'low-level SQL receipt controls do not claim a running producer');
  });

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
      'const copied = {...process.env}; const uri = copied.NS_TEST_POSTGRES_ADMIN_URI;',
      "const key = 'NS_TEST_POSTGRES_ADMIN_URI'; const uri = process.env[key];",
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
