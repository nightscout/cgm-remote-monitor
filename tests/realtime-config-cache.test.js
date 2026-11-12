'use strict';

// Realtime configuration and admission files: read on every call, parsed only
// when their text changes (measured: 85 ms per parse at 1,000 tenants).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const c = require('../lib/server/realtime/contract');
const admissionFactory = require('../lib/server/realtime/admission');
const A = '11111111-1111-4111-8111-111111111111';
// Static/lab hot files retain immediate in-place edit compatibility. Registry
// production uses boot-only file config and authoritative per-tenant SQL reads.
function realtimeConfig (dir) {
  const file = path.join(dir, 'rt.json'), admission = path.join(dir, 'admission.json');
  fs.writeFileSync(admission, JSON.stringify({ version: 1, mode: 'preview-socket-allowlist', tenants: [{ id: A, enabled: true, aliases: ['a.test'] }] }));
  const value = { version: 1, postgres: { connectionEnv: 'RT_DB', namespaces: Object.fromEntries(['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity', 'clock', 'checkpoint'].map(k => [k, 'rt_' + k])) },
    consumer: 'realtime-test', pageSize: 1, maxRows: 10, maxBytes: 10000, maxTenants: 2, recoveryIntervalMs: 100,
    tenants: [{ id: A, revision: 'v1', settings: { enable: ['bgnow'] } }], admissionFileEnv: 'RT_ADMISSION', maxMessageBytes: 10000, operationTimeoutMs: 1000 };
  fs.writeFileSync(file, JSON.stringify(value));
  const source = { RT_DB: 'postgres://synthetic:synthetic@127.0.0.1/disposable_test', RT_ADMISSION: admission, NS_API_INTERNAL_SOCKET: '/tmp/a.sock', MULTITENANT_REALTIME_CONFIG: file };
  return { file, value, source };
}
function countingReads (file) {
  const configFile = require('../lib/server/serve/config-file'), original = configFile.read, counter = { reads: 0 };
  configFile.read = function (name, ...rest) { if (name === file) counter.reads++; return original.call(this, name, ...rest); };
  counter.restore = () => { configFile.read = original; };
  return counter;
}
describe('legacy realtime hot configuration uses bounded read-through', function () {
  it('RT_CONFIG_READ_THROUGH: each legacy call reads bounded bytes without reparsing', async function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-stat-')), { file, source } = realtimeConfig(dir);
    const counter = countingReads(file);
    try {
      const loaded = require('../lib/server/realtime/config').load(source);
      const atLoad = counter.reads;
      for (let i = 0; i < 100; i++) assert.equal((await loaded.readCurrent(A)).revision, 'v1');
      await loaded.readAll([A]);
      assert.equal(counter.reads - atLoad, 101, 'RT_CONFIG_READ_THROUGH reads after load: ' + (counter.reads - atLoad));
    } finally { counter.restore(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('RT_CONFIG_ROSTER_UNCHANGED: unchanged reads do not enumerate the tenant roster again', async function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-stat-')), { source } = realtimeConfig(dir);
    try {
      const loaded = require('../lib/server/realtime/config').load(source);
      const keys = loaded.tenants.keys;
      let enumerations = 0;
      loaded.tenants.keys = function () { enumerations++; return keys.call(this); };
      for (let i = 0; i < 100; i++) {
        assert.equal((await loaded.readCurrent(A)).revision, 'v1');
        assert.equal((await loaded.readAll([A])).get(A).revision, 'v1');
      }
      assert.equal(enumerations, 0, 'RT_CONFIG_ROSTER_UNCHANGED enumerations after load: ' + enumerations);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  for (const change of ['roster', 'infrastructure']) {
    it('RT_CONFIG_CHANGED_' + change + ': changed infrastructure or an expanded roster refuses both reads until restart', async function () {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-stat-')), { file, value, source } = realtimeConfig(dir);
      try {
        const loaded = require('../lib/server/realtime/config').load(source);
        if (change === 'roster') value.tenants.push({ id: '22222222-2222-4222-8222-222222222222', revision: 'v1', settings: { enable: ['bgnow'] } });
        else value.consumer = 'realtime-replacement';
        fs.writeFileSync(file, JSON.stringify(value));
        for (let i = 0; i < 2; i++) {
          await assert.rejects(loaded.readCurrent(A), error => error.code === 'REALTIME_RESTART_REQUIRED');
          await assert.rejects(loaded.readAll([A]), error => error.code === 'REALTIME_RESTART_REQUIRED');
        }
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
  }
  it('RT_CONFIG_STAT_CHANGED: an edit in place (same size) and an atomic replacement are each seen on the next call', async function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-stat-')), { file, value, source } = realtimeConfig(dir);
    const counter = countingReads(file);
    try {
      const loaded = require('../lib/server/realtime/config').load(source);
      assert.equal((await loaded.readCurrent(A)).revision, 'v1');
      const before = fs.statSync(file).size;
      value.tenants[0].revision = 'v2'; fs.writeFileSync(file, JSON.stringify(value));
      assert.equal(fs.statSync(file).size, before, 'the in-place edit keeps the size');
      assert.equal((await loaded.readCurrent(A)).revision, 'v2', 'RT_CONFIG_STAT_CHANGED in-place edit');
      value.tenants[0].revision = 'v3'; fs.writeFileSync(file + '.next', JSON.stringify(value)); fs.renameSync(file + '.next', file);
      assert.equal((await loaded.readCurrent(A)).revision, 'v3', 'RT_CONFIG_STAT_CHANGED atomic replacement');
      assert.equal((await loaded.readAll([A])).get(A).revision, 'v3');
    } finally { counter.restore(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('RT_REGISTRY_CURRENT: production registry per-tenant reads do not reread the boot file or enumerate the roster', async function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-registry-cache-')), { file, value, source } = realtimeConfig(dir);
    delete value.tenants; delete value.admissionFileEnv;
    value.registry = { namespace: 'synthetic_registry', refreshMs: 500 };
    value.tenantSettings = { connectionEnv: 'RT_SETTINGS', namespaces: { settings: 'synthetic_settings', operatorPolicy: 'synthetic_policy' } };
    source.RT_SETTINGS = 'postgres://settings:synthetic@127.0.0.1/disposable_test';
    fs.writeFileSync(file, JSON.stringify(value));
    const counter = countingReads(file); let runtime;
    try {
      const loaded = require('../lib/server/realtime/config').load(source);
      assert.equal(loaded.readCurrent, null); assert.equal(loaded.readAll, null);
      const settingsOf = require('../lib/server/serve/evaluator-config');
      const tenants = new Map([[A, settingsOf.registryEntry(A)]]); let enumerations = 0, settingsReads = 0, closes = 0;
      tenants.keys = () => { enumerations++; throw new Error('registry roster enumerated on per-tenant read'); };
      // Actual registryMode composition and settings projection; SQL/resource
      // boundaries are explicit doubles, not a native PostgreSQL claim.
      const resolver = { resolve: async () => A, start: async () => {}, close: () => { closes++; } };
      const overrides = {
        './registry-tenant-set': { open: async () => ({ tenants, isActive: id => id === A, activeIds: () => [A], close: async () => { closes++; } }) },
        '../../tenant-settings/presentation-reader': () => ({ read: async () => { settingsReads++; return { version: 1, effective: {} }; }, close: async () => { closes++; } }),
        '../../storage/postgres-connection': async () => ({ end: async () => { closes++; } }),
        '../../tenant-registry/resolver': { createRegistryResolver: () => resolver },
        '../../tenant-registry/postgres': { create: () => ({}) }
      };
      const filename = require.resolve('../lib/server/serve/preview-realtime'), original = require('node:module').createRequire(filename), output = { exports: {} };
      require('node:vm').runInThisContext('(function(require,module,exports){' + fs.readFileSync(filename, 'utf8') + '\n})', { filename })(
        id => Object.hasOwn(overrides, id) ? overrides[id] : original(id), output, output.exports);
      runtime = await output.exports.registryMode(loaded);
      const reads = counter.reads; fs.unlinkSync(file);
      for (let i = 0; i < 100; i++) {
        assert.equal((await runtime.config.readCurrent(A)).revision, 'registry');
        assert.equal((await runtime.config.readAll([A])).get(A).revision, 'registry');
      }
      assert.equal(counter.reads - reads, 0, 'production registry boot-file reads');
      assert.equal(enumerations, 0, 'production registry per-tenant roster enumerations');
      assert.equal(settingsReads, 200, 'authoritative settings are still read');
      await runtime.close(); runtime = null; assert.equal(closes, 4);
    } finally { if (runtime) await runtime.close(); counter.restore(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('RT_CONFIG_CURRENT_BOUND: a lower current bound cannot be bypassed by an unchanged outer cache', async function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-bound-')), { file, value, source } = realtimeConfig(dir);
    try {
      value.tenants[0].settings.customTitle = 'x'.repeat(70000); fs.writeFileSync(file, JSON.stringify(value));
      const loaded = require('../lib/server/realtime/config').load(source);
      assert.equal((await loaded.readCurrent(A)).revision, 'v1');
      source.MULTITENANT_CONFIG_MAX_BYTES = '65536';
      await assert.rejects(loaded.readCurrent(A), { code: 'CONFIG_FILE_TOO_LARGE' });
      source.MULTITENANT_CONFIG_MAX_BYTES = 'invalid';
      await assert.rejects(loaded.readAll([A]), { code: 'CONFIG_FILE_LIMIT_INVALID' });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('RT_CONFIG_STAT_REFUSAL: a file removed after load is refused with the bounded reader\'s code', async function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-stat-')), { file, source } = realtimeConfig(dir);
    try {
      const loaded = require('../lib/server/realtime/config').load(source);
      fs.rmSync(file);
      await assert.rejects(loaded.readCurrent(A), error => error.code === 'CONFIG_FILE_UNREADABLE');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
describe('realtime configuration files parse only on change', function () {
  it('RT_PARSE_ONCE: unchanged text is not parsed again; a change is seen on the next call', function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-cache-')), file = path.join(dir, 'f.json');
    try {
      fs.writeFileSync(file, JSON.stringify({ n: 1 }));
      let parses = 0; const read = c.parsedFile(file, value => { parses++; return value; });
      for (let i = 0; i < 50; i++) assert.equal(read().n, 1);
      assert.equal(parses, 1, 'RT_PARSE_ONCE one parse for fifty unchanged reads');
      fs.writeFileSync(file, JSON.stringify({ n: 2 }));
      assert.equal(read().n, 2, 'RT_PARSE_CHANGE a changed file is seen on the next call'); assert.equal(parses, 2);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('RT_ADMISSION_CURRENT: disabling a tenant in the admission file takes effect on the next check', async function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-cache-')), file = path.join(dir, 'allow.json');
    const doc = { version: 1, mode: 'preview-socket-allowlist', tenants: [{ id: A, aliases: ['a.test'], enabled: true }] };
    try {
      fs.writeFileSync(file, JSON.stringify(doc)); const admission = admissionFactory.load({ file, maxTenants: 2 });
      assert.equal(await admission.allows(A), true);
      doc.tenants[0].enabled = false; fs.writeFileSync(file, JSON.stringify(doc));
      assert.equal(await admission.allows(A), false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
