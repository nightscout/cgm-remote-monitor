'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const admission = require('../lib/server/realtime/admission');
const configFile = require('../lib/server/serve/config-file');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('socket admission configuration cache', function () {
  let dir, file, value, source;
  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socket-admission-cache-'));
    file = path.join(dir, 'admission.json');
    value = { version: 1, mode: 'preview-socket-allowlist', tenants: [{ id: A, enabled: true, aliases: ['a.test'] }] };
    source = {};
    fs.writeFileSync(file, JSON.stringify(value));
  });
  afterEach(function () { fs.rmSync(dir, { recursive: true, force: true }); });
  const load = () => admission.load({ file, maxTenants: 2, source });
  function replace (value) {
    fs.writeFileSync(file + '.next', JSON.stringify(value));
    fs.renameSync(file + '.next', file);
  }
  it('ADMISSION_UNCHANGED: repeated authority checks neither read the file nor enumerate the roster', async function () {
    const loaded = load(), originalRead = configFile.read, originalKeys = Map.prototype.keys;
    let reads = 0, enumerations = 0;
    configFile.read = function (...args) { if (args[0] === file) reads++; return originalRead.apply(this, args); };
    Map.prototype.keys = function () { enumerations++; return originalKeys.call(this); };
    try {
      // Prime the parser once; then measure the unchanged authorization path.
      await loaded.allows(A); reads = 0; enumerations = 0;
      for (let i = 0; i < 100; i++) {
        assert.equal(await loaded.allows(A), true);
        assert.equal(await loaded.resolveHost('a.test'), A);
      }
      assert.equal(reads, 0, 'ADMISSION_UNCHANGED full-file reads');
      assert.equal(enumerations, 0, 'ADMISSION_UNCHANGED roster enumerations');
    } finally { configFile.read = originalRead; Map.prototype.keys = originalKeys; }
  });
  it('ADMISSION_DISABLED: a replacement invalidates cached authority and host admission immediately', async function () {
    const loaded = load(); assert.equal(await loaded.allows(A), true);
    value.tenants[0].enabled = false; replace(value);
    assert.equal(await loaded.allows(A), false);
    await assert.rejects(loaded.resolveHost('a.test'), { code: 'SOCKET_ADMISSION_REFUSED' });
    value.tenants[0].enabled = true; replace(value);
    assert.equal(await loaded.resolveHost('a.test'), A);
  });
  it('ADMISSION_EXPANSION: a new tenant is refused repeatedly until the roster is repaired', async function () {
    const loaded = load(); await loaded.allows(A);
    value.tenants.push({ id: B, enabled: true, aliases: ['b.test'] }); replace(value);
    for (let i = 0; i < 2; i++) await assert.rejects(loaded.allows(B), { code: 'SOCKET_ADMISSION_EXPANSION_RESTART' });
    value.tenants.pop(); replace(value);
    assert.equal(await loaded.allows(A), true); assert.equal(await loaded.allows(B), false);
  });
  it('ADMISSION_ALIAS: an in-place same-size alias edit is revalidated on the next call', async function () {
    const loaded = load(); assert.equal(await loaded.resolveHost('a.test'), A);
    const size = fs.statSync(file).size;
    value.tenants[0].aliases = ['b.test']; fs.writeFileSync(file, JSON.stringify(value));
    const later = new Date(Date.now() + 5000); fs.utimesSync(file, later, later);
    assert.equal(fs.statSync(file).size, size);
    await assert.rejects(loaded.resolveHost('a.test'), { code: 'TENANT_HOST_UNKNOWN' });
    assert.equal(await loaded.resolveHost('b.test'), A);
  });
  it('ADMISSION_BAD_FILE: invalid JSON and a removed file never reuse previously accepted authority', async function () {
    const loaded = load(); await loaded.allows(A);
    fs.writeFileSync(file, '{');
    for (let i = 0; i < 2; i++) await assert.rejects(loaded.allows(A), { code: 'CONFIG_FILE_INVALID_JSON' });
    replace(value); assert.equal(await loaded.allows(A), true);
    fs.rmSync(file); await assert.rejects(loaded.allows(A), { code: 'CONFIG_FILE_UNREADABLE' });
    fs.mkdirSync(file); await assert.rejects(loaded.allows(A), { code: 'CONFIG_FILE_NOT_REGULAR' });
  });
  it('ADMISSION_BOUND: the current byte limit is enforced even when the file identity is unchanged', async function () {
    value.tenants[0].aliases = Array.from({ length: 4000 }, (_, i) => 'host' + i + '.example.test');
    replace(value); source.MULTITENANT_CONFIG_MAX_BYTES = '1048576';
    const loaded = load(); assert.equal(await loaded.allows(A), true);
    source.MULTITENANT_CONFIG_MAX_BYTES = '65536';
    await assert.rejects(loaded.allows(A), { code: 'CONFIG_FILE_TOO_LARGE' });
    source.MULTITENANT_CONFIG_MAX_BYTES = 'invalid';
    await assert.rejects(loaded.allows(A), { code: 'CONFIG_FILE_LIMIT_INVALID' });
  });
});
