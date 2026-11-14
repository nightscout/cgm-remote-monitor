'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const fixture = require('./fixtures/pgstream-native');
describe('owned native maintained producer fixture', function () {
  let directory;
  beforeEach(function () { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pgstream-fixture-')); });
  afterEach(function () { fs.rmSync(directory, { recursive: true }); });
  it('pins bytes, executable mode and direct file identity with broken/restored controls', function () {
    const file = path.join(directory, 'synthetic-binary'), bytes = 'synthetic binary witness'; fs.writeFileSync(file, bytes, { mode: 0o700 });
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    const green = () => assert.equal(fixture.binary(file, hash, hash), file); green();
    fs.appendFileSync(file, 'changed'); assert.throws(() => fixture.binary(file, hash, hash), /BINARY_PIN/); fs.writeFileSync(file, bytes); green();
    fs.chmodSync(file, 0o600); assert.throws(() => fixture.binary(file, hash, hash), /BINARY_PIN/); fs.chmodSync(file, 0o700); green();
    assert.throws(() => fixture.binary(file, '0'.repeat(64), hash), /BINARY_PIN/); green();
    fs.symlinkSync(file, path.join(directory, 'link')); assert.throws(() => fixture.binary(path.join(directory, 'link'), hash, hash), /BINARY_PIN/); green();
    fs.unlinkSync(file); assert.throws(() => fixture.binary(file, hash, hash), /BINARY_MISSING/);
  });
  it('keeps source pin mandatory before any database or initializer work', async function () {
    let calls = 0;
    await assert.rejects(fixture.setup({ admin: { query() { calls++; throw Error('SQL MUST NOT RUN'); } }, source: {} }), /BINARY_PIN/);
    assert.equal(calls, 0);
    assert.deepEqual(Object.keys(fixture.ENV).sort(), ['binary','binding','config','receiverPort','sha256','subscriptionsPort']);
  });
  it('uses explicit caller ports and fixture names, with no port or producer fallback', function () {
    const selected = { receiverPort: 21461, subscriptionsPort: 21462 };
    const config = fixture.configuration({ prefix: 'synthetic_fixture', capability: selected });
    assert.equal(config.receiverPort, 21461); assert.equal(config.slot, 'synthetic_fixture_pgstream');
    assert.equal(config.streamRole, 'synthetic_fixture_pgstream'); assert.equal(config.binaryEnv, fixture.ENV.binary);
    assert.throws(() => fixture.configuration({ prefix: 'bad;sql', capability: selected }), /IDENTIFIER/);
    assert.throws(() => fixture.configuration({ prefix: 'synthetic_fixture' }), /CAPABILITY_REQUIRED/);
  });
  it('delegates exact source routes and the explicit port to the canonical binding', function () {
    const config = { consumer: 'evaluator-fixture', namespaces: { clock: 'synthetic_clock', checkpoint: 'synthetic_checkpoint' },
      trustedWorker: { settings: 'synthetic_settings', operatorPolicy: 'synthetic_policy', activity: 'synthetic_control' },
      pgstream: { slot: 'synthetic_slot', receiverPort: 21461 } };
    let recorded;
    const value=fixture.wire(config,'postgres://synthetic:synthetic@127.0.0.1:15432/synthetic_test',21462,{wire(...args){recorded=args;return 'canonical-wire';}});
    assert.equal(value,'canonical-wire');assert.equal(recorded[0],config);assert.equal(recorded[2].subscriptionsPort,21462);
    assert.deepEqual(recorded[2].routes,require('../lib/pgstream/evaluator').routes(config));
    assert.throws(()=>fixture.wire(config,'postgres://synthetic@localhost/synthetic_test',21462),/BINDING_REQUIRED/);

  });
});
