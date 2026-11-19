'use strict';

// Actual local files and actual bounded reader/cache. SQL adapters are explicitly
// doubled only in the registry composition discriminator below.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const contract = require('../lib/server/realtime/contract');
const configFile = require('../lib/server/serve/config-file');
const A='11111111-1111-4111-8111-111111111111';
const nativeBoot = require('./fixtures/evaluator-native-recovery-protocol');
const registryRefusal = require('../lib/server/serve/registry-config').REFUSAL;

function observe (file, frozen = false) {
  const originals = { open: fs.openSync, close: fs.closeSync, stat: fs.statSync, fstat: fs.fstatSync, read: configFile.read, handle: configFile.readHandle };
  const fds = new Set(), result = { reads: 0, handles: 0, peak: 0, fds };
  const freeze = stat => frozen ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat,
    typeof stat.ino === 'bigint' ? { mtimeNs: 1n, ctimeNs: 1n } : { mtimeMs: 1, ctimeMs: 1 }) : stat;
  fs.openSync = function (name, ...args) { const fd = originals.open.call(this, name, ...args); if (name === file) { fds.add(fd); result.peak = Math.max(result.peak, fds.size); } return fd; };
  fs.closeSync = function (fd) { fds.delete(fd); return originals.close.call(this, fd); };
  fs.statSync = function (name, ...args) { const stat = originals.stat.call(this, name, ...args); return name === file ? freeze(stat) : stat; };
  fs.fstatSync = function (fd, ...args) { const stat = originals.fstat.call(this, fd, ...args); return fds.has(fd) ? freeze(stat) : stat; };
  configFile.read = function (name, ...args) { if (name === file) result.reads++; return originals.read.call(this, name, ...args); };
  configFile.readHandle = function (name, ...args) { if (name === file) result.handles++; return originals.handle.call(this, name, ...args); };
  result.restore = () => { fs.openSync = originals.open; fs.closeSync = originals.close; fs.statSync = originals.stat; fs.fstatSync = originals.fstat; configFile.read = originals.read; configFile.readHandle = originals.handle; };
  return result;
}
// The maintained worker has no file-backed tenant settings or static roster.
function evaluatorConfig () {
  return { version: 1, postgres: { connectionEnv: 'EVAL_PG', namespaces: Object.fromEntries(
    ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity', 'clock', 'checkpoint'].map(name => [name, 'hot_' + name])) },
    consumer: 'evaluator-hot', pageSize: 1, maxRows: 10, maxBytes: 10000, maxTenants: 2, timeIntervalMs: 200,
    registry: { namespace: 'hot_registry', refreshMs: 500 },
    tenantSettings: { connectionEnv: 'SETTINGS_PG', namespaces: { settings: 'hot_settings', operatorPolicy: 'hot_policy' } },
    activity: { connectionEnv: 'ACTIVITY_PG', namespace: 'hot_control' },
    trustedWorker: { activity: 'hot_control', clock: 'hot_clock', settings: 'hot_settings', operatorPolicy: 'hot_policy' },
    pgstream: { receiver:{url:'http://127.0.0.1:'+19913+'/',trust:'network',bindHost:'127.0.0.1',maxBytes:16777216,timeoutMs:5000}, slot: 'hot_stream', streamRole: 'hot_stream',
      bounds: { stepMs: 5000, recoveryMs: 30000, pendingMs: 30000 } } };
}
function evaluatorSource () {
  return { EVAL_PG: 'postgres://eval:synthetic@127.0.0.1/synthetic_test',
    SETTINGS_PG: 'postgres://settings:synthetic@127.0.0.1/synthetic_test', ACTIVITY_PG: 'postgres://activity:synthetic@127.0.0.1/synthetic_test',
    PGSTREAM_BINARY: '/usr/local/bin/pgstream', PGSTREAM_CONFIG: '/tmp/synthetic-pgstream.json', NS_REALTIME_INTERNAL_SOCKET: '/tmp/synthetic-realtime.sock' };
}
function replace (file, value) { fs.writeFileSync(file + '.next', JSON.stringify(value)); fs.renameSync(file + '.next', file); }

function isolatedModule (relative, overrides = {}, mutate = source => source) {
  const filename = require.resolve(relative), original = require('node:module').createRequire(filename), output = { exports: {} };
  require('node:vm').runInThisContext('(function(require,module,exports){' + mutate(fs.readFileSync(filename, 'utf8')) + '\n})', { filename })(
    id => Object.hasOwn(overrides, id) ? overrides[id] : original(id), output, output.exports);
  return output.exports;
}

describe('bounded read-through and pinned atomic publication cache', function () {
  let dir, file;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-publication-cache-')); file = path.join(dir, 'config.json'); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('HOT_SAME_STAT: identical metadata cannot hide an in-place edit; unchanged bytes parse only once', function () {
    fs.writeFileSync(file, '{"n":1}');
    const observed = observe(file, true); let parses = 0;
    const read = contract.parsedFile(file, value => { parses++; return value; });
    try {
      const before = fs.statSync(file, { bigint: true });
      for (let i = 0; i < 50; i++) assert.equal(read().n, 1);
      assert.equal(parses, 1);
      fs.writeFileSync(file, '{"n":2}');
      const after = fs.statSync(file, { bigint: true });
      for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode']) assert.equal(after[key], before[key]);
      assert.equal(read().n, 2, 'HOT_SAME_STAT immediate changed authority'); assert.equal(parses, 2);
      assert.equal(observed.reads, 51, 'one bounded read per legacy call');
      assert.equal(observed.fds.size, 0, 'read-through retains no descriptor');
    } finally { read.close(); observed.restore(); }
  });

  it('HOT_SYMLINK: legacy valid symlinks keep immediate in-place freshness and refuse missing/nonregular targets', function () {
    const target = path.join(dir, 'target.json'); fs.writeFileSync(target, '{"n":1}'); fs.symlinkSync(target, file);
    const read = contract.parsedFile(file, value => value);
    try {
      assert.equal(read().n, 1); fs.writeFileSync(target, '{"n":2}'); assert.equal(read().n, 2);
      fs.unlinkSync(file); fs.symlinkSync(dir, file); assert.throws(read, { code: 'CONFIG_FILE_NOT_REGULAR' });
      fs.unlinkSync(file); fs.symlinkSync(target, file); fs.unlinkSync(target); assert.throws(read, { code: 'CONFIG_FILE_UNREADABLE' });
    } finally { read.close(); }
  });

  it('ATOMIC_SAME_FD: bytes and cached identity come from the same descriptor during a concurrent rename', function () {
    fs.writeFileSync(file, '{"n":1}'); const observed = observe(file), open = fs.openSync;
    const read = contract.parsedFile(file, value => value, { publication: 'atomic' }); let replaced = false;
    fs.openSync = function (name, ...args) {
      const fd = open.call(this, name, ...args);
      if (name === file && !replaced) { replaced = true; replace(file, { n: 2 }); }
      return fd;
    };
    try {
      assert.equal(read().n, 1, 'the already opened publication remains coherent');
      assert.equal(read().n, 2, 'the following call sees the renamed publication');
      assert.equal(observed.fds.size, 1); assert.equal(observed.peak, 1);
    } finally { read.close(); fs.openSync = open; observed.restore(); }
  });

  it('ATOMIC_PIN: one accepted inode is held across missed publications; same-time/same-size replacement is current', function () {
    fs.writeFileSync(file, '{"n":1}'); const observed = observe(file, true);
    let parses = 0;
    const read = contract.parsedFile(file, value => { parses++; return value; }, { publication: 'atomic' });
    try {
      assert.equal(read().n, 1); const old = [...observed.fds][0], inode = fs.fstatSync(old, { bigint: true }).ino;
      for (let i = 0; i < 100; i++) assert.equal(read().n, 1);
      assert.equal(observed.handles, 1); assert.equal(parses, 1); assert.equal(observed.fds.size, 1);
      // Multiple publications need not be observed by a reader. An unlinked but
      // held inode remains allocated, so the accepted identity cannot ABA.
      for (let i = 0; i < 100; i++) {
        replace(file, { n: 2 });
        assert.notEqual(fs.statSync(file, { bigint: true }).ino, inode);
        assert.equal(fs.fstatSync(old).nlink, 0);
      }
      assert.equal(read().n, 2, 'ATOMIC_PIN replacement must invalidate cache');
      assert.equal(observed.fds.size, 1); assert.equal(observed.handles, 2); assert.equal(parses, 2);
      // Release the former inode before opening its replacement: peak stays one.
      assert.equal(observed.peak, 1);
      read.close(); read.close(); assert.equal(observed.fds.size, 0);
      assert.throws(read, { code: 'REALTIME_CONFIG_REFUSED' });
    } finally { read.close(); observed.restore(); }
  });

  it('ATOMIC_SYMLINK: valid symlinks follow target replacement/repoint and every refusal releases the pinned inode', function () {
    const target = path.join(dir, 'target.json'), other = path.join(dir, 'other.json');
    fs.writeFileSync(target, '{"n":1}'); fs.symlinkSync(target, file);
    const observed = observe(file, true), read = contract.parsedFile(file, value => value, { publication: 'atomic' });
    try {
      assert.equal(read().n, 1); replace(target, { n: 2 }); assert.equal(read().n, 2);
      fs.writeFileSync(other, '{"n":3}'); fs.unlinkSync(file); fs.symlinkSync(other, file); assert.equal(read().n, 3);
      fs.unlinkSync(file); fs.symlinkSync(dir, file);
      assert.throws(read, { code: 'CONFIG_FILE_NOT_REGULAR' }); assert.equal(observed.fds.size, 0);
      fs.unlinkSync(file); fs.symlinkSync(target, file); assert.equal(read().n, 2);
      fs.unlinkSync(target); assert.throws(read, { code: 'CONFIG_FILE_UNREADABLE' }); assert.equal(observed.fds.size, 0);
      fs.writeFileSync(target, '{'); assert.throws(read, { code: 'CONFIG_FILE_INVALID_JSON' }); assert.equal(observed.fds.size, 0);
    } finally { read.close(); observed.restore(); }
  });

  it('ATOMIC_BOUND: current bound/permissions refuse and release; growth is bounded by actual bytes independently of stat size', function () {
    fs.writeFileSync(file, JSON.stringify({ n: 'x'.repeat(70000) }));
    const source = {}, observed = observe(file), read = contract.parsedFile(file, value => value, { publication: 'atomic', source });
    try {
      assert.equal(read().n.length, 70000); assert.equal(observed.fds.size, 1);
      source.MULTITENANT_CONFIG_MAX_BYTES = '65536';
      assert.throws(read, { code: 'CONFIG_FILE_TOO_LARGE' }); assert.equal(observed.fds.size, 0);
      source.MULTITENANT_CONFIG_MAX_BYTES = 'bad'; assert.throws(read, { code: 'CONFIG_FILE_LIMIT_INVALID' });
      source.MULTITENANT_CONFIG_MAX_BYTES = '1048576'; assert.equal(read().n.length, 70000);
      const open = fs.openSync, stat = fs.statSync;
      fs.chmodSync(file, 0o000);
      // EACCES is instrumented because CI may run as root. Real mode change
      // invalidates the cache; the reader's real failure cleanup is exercised.
      fs.openSync = function (name, ...args) { if (name === file) throw Object.assign(new Error('synthetic'), { code: 'EACCES' }); return open.call(this, name, ...args); };
      try { assert.throws(read, { code: 'CONFIG_FILE_UNREADABLE' }); assert.equal(observed.fds.size, 0); } finally { fs.openSync = open; fs.chmodSync(file, 0o600); }
      fs.writeFileSync(file, 'x'.repeat(1048577));
      fs.statSync = function (name, ...args) { const value = stat.call(this, name, ...args); return name === file ? Object.assign(Object.create(Object.getPrototypeOf(value)), value, { size: typeof value.size === 'bigint' ? 1n : 1 }) : value; };
      try { assert.throws(read, error => error.code === 'CONFIG_FILE_TOO_LARGE' && error.size === null); assert.equal(observed.fds.size, 0); } finally { fs.statSync = stat; }
    } finally { read.close(); observed.restore(); }
  });

  it('CONFIG_FAILED_URL: malformed pool credential encodings refuse before retaining a resource',function(){
    const config=path.join(dir,'operation.json'),roles=['api','evaluator','realtime','tenant-admin'];
    const value={version:1,namespace:'synthetic_window',connectionEnv:'SYNTHETIC_PG',locks:[{tenant:A,key:'17'}]};
    fs.writeFileSync(config,JSON.stringify(value));
    const source={MULTITENANT_OPERATION_CONFIG:config,NS_SERVE_INTERNAL_SOCKET:'/synthetic/api.sock',...Object.fromEntries(roles.slice(1).map(role=>['NS_'+role.toUpperCase().replace('-','_')+'_INTERNAL_SOCKET','/synthetic/'+role+'.sock']))};
    source.SYNTHETIC_PG='postgresql://synthetic:synthetic@127.0.0.1/disposable_test';assert.equal(require('../lib/server/serve/operation-cohort-config').load(source).namespace,'synthetic_window');
    for(const url of ['postgresql://%ZZ:synthetic@127.0.0.1/disposable_test','postgresql://synthetic:%ZZ@127.0.0.1/disposable_test','postgresql://synthetic:synthetic@127.0.0.1/%ZZ']){source.SYNTHETIC_PG=url;assert.throws(()=>require('../lib/server/serve/operation-cohort-config').load(source),/invalid explicit tenant operation configuration/);}
  });

  for (const mode of ['same-stat', 'current-bound']) it('EVALUATOR_HOT_' + mode + ': admitted metadata preserves next-call freshness and current bound', async function () {
    const value = evaluatorConfig();
    const encode = () => JSON.stringify(value) + (mode === 'current-bound' ? ' '.repeat(70000) : '');
    fs.writeFileSync(file, encode()); const observed = observe(file, true);
    const source = { ...evaluatorSource(), MULTITENANT_EVALUATOR_CONFIG: file };
    const parse = configFile.parse; let parses = 0, version = 0;
    configFile.parse = function (text, options) { if (options?.label === 'MULTITENANT_EVALUATOR_CONFIG') parses++; return parse.call(this, text, options); };
    const settings = { matches: () => true, read: async () => ({ version: ++version, effective: {} }) };
    const admission = { namespace: value.registry.namespace, allows: async tenant => tenant === A };
    try {
      const loaded = require('../lib/server/serve/evaluator-config').loadMetadata(source);
      const current = () => loaded.readCurrent(A, settings, admission);
      let prior = (await current()).identity;
      const reads = observed.reads;
      for (let i = 0; i < 50; i++) { const next = await current(); assert.notEqual(next.identity, prior); prior = next.identity; }
      const unchangedReads = observed.reads - reads, unchangedParses = parses;
      if (mode === 'same-stat') {
        const before = fs.statSync(file, { bigint: true }); value.timeIntervalMs = 201; fs.writeFileSync(file, encode());
        const after = fs.statSync(file, { bigint: true }); for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode']) assert.equal(after[key], before[key]);
        await assert.rejects(current(), /requires restart/, 'same-stat infrastructure edit must be current');
      } else {
        source.MULTITENANT_CONFIG_MAX_BYTES = '65536'; await assert.rejects(current(), { code: 'CONFIG_FILE_TOO_LARGE' });
      }
      assert.equal(unchangedReads, 50, 'each admitted metadata call revalidates bounded configuration');
      assert.equal(unchangedParses, 1, 'unchanged bytes reuse parsed infrastructure');
      assert.equal(loaded.tenants.size, 0); assert.equal(observed.fds.size, 0);
      for (const retired of [{ tenants: [] }, { recoveryIntervalMs: 100 }, { settingsRefreshMs: 100 }]) {
        assert.throws(() => require('../lib/server/serve/evaluator-config').parseMetadata({ ...evaluatorConfig(), ...retired }),
          Object.hasOwn(retired, 'tenants') ? { message: registryRefusal } : /invalid/);
      }
    } finally { configFile.parse = parse; observed.restore(); }
  });

  async function registryCurrent (mutate = source => source, inspect = () => {}) {
    const scope = require('../lib/storage/tenant-scope'), previous = scope.getTenancyMode();
    fs.writeFileSync(file, '{}'); const observed = observe(file);
    const nativeEvents=[],counts = { reads: 0, factories: 0, refreshes: 0, closes: 0, legacy: 0, finite: 0 }; let reached = false, assertionsReached = false;
    const settingsOf = isolatedModule('../lib/server/serve/evaluator-config', { '../../tenant-settings/effective-postgres': async () => {
      counts.finite++; throw new Error('finite settings fallback must not execute');
    } });
    const tenants = new Map([[A, settingsOf.registryEntry(A)]]); let enumerations = 0;
    const keys = tenants.keys.bind(tenants); let testingCurrent = false;
    tenants.keys = () => { if (testingCurrent) { enumerations++; throw new Error('registry roster read on current path'); } return keys(); };
    const boot = isolatedModule('../lib/server/serve/evaluator-preview', {
      ...nativeBoot.mocks({events:nativeEvents}),
      './evaluator-config': settingsOf,
      '../../storage/postgres-connection': async () => ({ end: async () => {} }),
      '../../storage/postgres-durable-replay':()=>nativeBoot.replay({events:nativeEvents}),
      '../../pool-membership': { member: async () => ({ register: async () => {}, close: async () => {}, configured: { leaseMs: 1000 } }) },
      './evaluator-pool': { create: () => ({ start () {}, refresh: async () => {}, close () {}, admits: () => true }) },
      '../../trusted-worker/postgres': { create: () => { counts.factories++; return { scan: async () => [],
        read: async tenant => { assert.equal(tenant, A); return { version: ++counts.reads, effective: {} }; }, close: async () => { counts.closes++; } }; } },
      '../../trusted-worker/lifecycle': async () => ({ close: async () => {} }),
      './platform-verification': require('./fixtures/platform-proof')(), './evaluator-readiness': async () => {},
      './registry-tenant-set': { openDemand: async () => ({ tenants, isActive: tenant => tenant === A, close: async () => {} }) },
      '../../pgstream/evaluator': { open: async ({ config: current }) => {
        testingCurrent = true; reached = true; fs.unlinkSync(file); let prior;
        for (let i = 0; i < 200; i++) {
          const value = await current.readCurrent(A); assert.equal(value.revision, 'registry');
          if (prior) assert.notEqual(value.identity, prior, 'each call applies freshly read version'); prior = value.identity;
        }
        assert.equal(observed.reads, 0); assert.equal(enumerations, 0); assert.equal(counts.reads, 200); assertionsReached = true;
        throw new Error('end focused composition discriminator before clinical startup');
      } }
    }, mutate);
    // Actual boot must replace this poison callback; neither it nor finite
    // settings fallback can satisfy this owned-reader composition discriminator.
    const config = { ...evaluatorConfig(), pgstream:nativeBoot.config(evaluatorConfig().pgstream), namespaces: evaluatorConfig().postgres.namespaces, registry: { namespace: 'synthetic_registry' }, maxTenants: 10, tenants: new Map(), tenantSettings: {},
      readCurrent: async () => { counts.legacy++; throw new Error('legacy callback must not execute in registry mode'); } };
    try {
      await assert.rejects(boot.boot(config, { operationWindow: {} }), /readiness or initialization refused/);
      assert.equal(reached, true); assert.equal(counts.reads, 200); assert.equal(assertionsReached, true);
      assert.equal(observed.reads, 0); assert.equal(enumerations, 0);
      assert.deepEqual(counts, { reads: 200, factories: 1, refreshes: 0, closes: 1, legacy: 0, finite: 0 });
      for(const event of ['identify-created','identify-closed','native-recovery-created','native-recovery-closed','native-configured'])assert.equal(nativeEvents.filter(value=>value===event).length,1,'REGISTRY_FOCUSED_EXIT_CLOSES_NATIVE_PORT:'+event);
    } finally {
      try { inspect({ ...counts, reached, assertionsReached }); }
      finally { observed.restore(); scope.setTenancyMode(previous); }
    }
  }

  it('EVALUATOR_REGISTRY_CURRENT: actual registry boot seam uses per-tenant settings with zero legacy file/roster reads', async function () {
    const scope = require('../lib/storage/tenant-scope'), previous = scope.getTenancyMode();
    await registryCurrent();
    assert.equal(scope.getTenancyMode(), previous, 'REGISTRY_BOOT_FIXTURE_RESTORES_TENANCY_MODE');
  });

  it('EVALUATOR_REGISTRY_CURRENT_CONTROLS: removing the owned reader or registry override is red, and restoration reaches every assertion', async function () {
    const owned = 'settingsOf.withSettings(base, entry, tenant, settingsReader)';
    const override = 'async readCurrent (tenant) {';
    const source = fs.readFileSync(require.resolve('../lib/server/serve/evaluator-preview'), 'utf8');
    for (const [needle, replacement, expected] of [
      [owned, 'settingsOf.withSettings(base, entry, tenant)', { finite: 1, legacy: 0 }],
      [override, 'async unusedRegistryReader (tenant) {', { finite: 0, legacy: 1 }]
    ]) {
      assert.equal(source.split(needle).length, 2, 'control must land on actual source'); let observed;
      await assert.rejects(registryCurrent(value => value.replace(needle, replacement), value => { observed = value; }),
        error => error.code === 'ERR_ASSERTION' && error.actual === 0 && error.expected === 200);
      assert.equal(observed.reached, true); assert.equal(observed.assertionsReached, false);
      assert.equal(observed.finite, expected.finite); assert.equal(observed.legacy, expected.legacy);
      await registryCurrent();
    }
  });

});
