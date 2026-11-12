'use strict';

// Actual local files and actual bounded reader/cache. SQL adapters are explicitly
// doubled only in the publisher and registry composition discriminators below.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const contract = require('../lib/server/realtime/contract');
const configFile = require('../lib/server/serve/config-file');
const fixture = require('./fixtures/realtime-placement-map');

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
function replace (file, value) { fs.writeFileSync(file + '.next', JSON.stringify(value)); fs.renameSync(file + '.next', file); }

function isolatedModule (relative, overrides = {}) {
  const filename = require.resolve(relative), original = require('node:module').createRequire(filename), output = { exports: {} };
  require('node:vm').runInThisContext('(function(require,module,exports){' + fs.readFileSync(filename, 'utf8') + '\n})', { filename })(
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

  it('PLACEMENT_FAILED_CONFIG: malformed pool credential encodings refuse before acquiring a placement descriptor', function () {
    fs.writeFileSync(file, JSON.stringify(fixture.config())); const observed = observe(file);
    const config = path.join(dir, 'operation.json'), roles = ['api', 'evaluator', 'realtime', 'tenant-admin'];
    const value = { version: 2, namespace: 'synthetic_window', connectionEnv: 'SYNTHETIC_PG', locks: [{ tenant: fixture.A, key: '17' }], participantId: 'peer_0',
      participants: roles.map((role, index) => ({ id: 'peer_' + index, roles: [role], namespaces: ['clinical_' + index], maxMessageBytes: 100000, timeoutMs: 1000 })) };
    fs.writeFileSync(config, JSON.stringify(value));
    const source = { MULTITENANT_OPERATION_CONFIG: config, MULTITENANT_REALTIME_PLACEMENT: file, NS_SERVE_INTERNAL_SOCKET: '/synthetic/api.sock',
      ...Object.fromEntries(roles.slice(1).map(role => ['NS_' + role.toUpperCase().replace('-', '_') + '_INTERNAL_SOCKET', '/synthetic/' + role + '.sock'])) };
    try {
      // Confirm all other parser inputs actually admit the selected placement.
      source.SYNTHETIC_PG = 'postgresql://synthetic:synthetic@127.0.0.1/disposable_test';
      const loaded = require('../lib/server/serve/operation-cohort-config').load(source);
      assert.equal(observed.fds.size, 1); loaded.placement.close(); assert.equal(observed.fds.size, 0);
      for (const url of ['postgresql://%ZZ:synthetic@127.0.0.1/disposable_test', 'postgresql://synthetic:%ZZ@127.0.0.1/disposable_test', 'postgresql://synthetic:synthetic@127.0.0.1/%ZZ']) {
        source.SYNTHETIC_PG = url;
        assert.throws(() => require('../lib/server/serve/operation-cohort-config').load(source), /invalid explicit tenant operation configuration/);
        assert.equal(observed.fds.size, 0, 'PLACEMENT_FAILED_CONFIG failed parser must retain no descriptor');
      }
    } finally { observed.restore(); }
  });

  it('PLACEMENT_EVALUATOR_VALIDATE: pure refusals acquire no handles and repeated hot parses retain only boot transport', async function () {
    fs.writeFileSync(file, JSON.stringify(fixture.config())); const observed = observe(file);
    const source = { MULTITENANT_REALTIME_PLACEMENT: file, EVAL_PG: 'postgres://eval:synthetic@127.0.0.1/synthetic_test',
      OUTBOX_PG: 'postgres://outbox:synthetic@127.0.0.1/synthetic_test', ALARM_PG: 'postgres://alarm:synthetic@127.0.0.1/synthetic_test', NS_REALTIME_INTERNAL_SOCKET: '/tmp/realtime-service.sock' };
    const value = { version: 1, postgres: { connectionEnv: 'EVAL_PG', namespaces: Object.fromEntries(['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity', 'clock', 'checkpoint'].map(name => [name, 'eval_' + name])) },
      consumer: 'evaluator-cache', pageSize: 1, maxRows: 10, maxBytes: 10000, maxTenants: 2, recoveryIntervalMs: 100, timeIntervalMs: 200,
      tenants: [{ id: fixture.A, revision: 'one', settings: { enable: ['bgnow'] } }], consumers: { realtime: {
        outbox: { connectionEnv: 'OUTBOX_PG', namespace: 'cache_outbox', maxRows: 10, maxBytes: 100000, maxConnections: 2 },
        suppression: { connectionEnv: 'ALARM_PG', namespace: 'cache_alarm', maxRows: 10, maxBytes: 100000, maxConnections: 2 },
        route: { id: 'realtime-cache', maxMessageBytes: 20000, operationTimeoutMs: 500 }, maxPayloadBytes: 10000, maxInflight: 2, attemptTimeoutMs: 1000, retryDelayMs: 100, pollIntervalMs: 100, retryIntervalMs: 200 } } };
    try {
      const parse = require('../lib/server/serve/evaluator-config').parse;
      const accepted = parse(value, source); assert.equal(observed.fds.size, 1); accepted.consumers.realtime.placement.close();
      const acquired = observed.handles;
      for (const change of [v => { v.socketOrderDomains = ['unknown']; }, v => { v.tenantSettings = {}; }, v => { v.activity = {}; }, v => { v.changeFeed = {}; },
        v => { delete v.tenants; v.registry = { namespace: 'bad!' }; }]) {
        const invalid = structuredClone(value); change(invalid); assert.throws(() => parse(invalid, source), /invalid/);
        assert.equal(observed.fds.size, 0, 'PLACEMENT_EVALUATOR_VALIDATE refused parser leaked descriptor');
        assert.equal(observed.handles, acquired, 'pure validation must precede resource acquisition');
      }
      const config = path.join(dir, 'evaluator.json'); fs.writeFileSync(config, JSON.stringify(value)); source.MULTITENANT_EVALUATOR_CONFIG = config;
      const loaded = require('../lib/server/serve/evaluator-config').load(source);
      try {
        for (let i = 0; i < 20; i++) {
          const changed = structuredClone(value); changed.tenants[0].revision = String(i); replace(config, changed);
          assert.equal((await loaded.readCurrent(fixture.A)).revision, String(i));
          assert.equal(observed.fds.size, 1, 'PLACEMENT_EVALUATOR_REPARSE only the initial transport owns a descriptor');
          assert.equal(loaded.consumers.realtime.placement.current().generation, 1, 'boot transport remains usable');
        }
        const invalid = structuredClone(value); invalid.consumer = 'evaluator-restart'; replace(config, invalid);
        await assert.rejects(loaded.readCurrent(fixture.A), /requires restart/);
        assert.equal(observed.fds.size, 1, 'refused secondary infrastructure parse retains no descriptor');
      } finally { loaded.consumers.realtime.placement.close(); }
      assert.equal(observed.fds.size, 0);
    } finally { observed.restore(); }
  });

  for (const failure of ['later-role', 'static-mode', 'start']) it('PLACEMENT_CLI_' + failure + ': CLI closes previously parsed placement on later refusal', async function () {
    fs.writeFileSync(file, JSON.stringify(fixture.config())); const observed = observe(file);
    const reader = () => fixture.placement.load({ MULTITENANT_REALTIME_PLACEMENT: file }, { internal: fixture.internal });
    const overrides = {
      '../../server/serve/operation-cohort-config': { load: () => ({ placement: reader() }) },
      '../../server/realtime/config': { load: () => { if (failure === 'later-role') throw new Error('synthetic later-role refusal'); return { placement: reader() }; } },
      '../../server/serve/static-tenants': { check: () => { if (failure === 'static-mode') throw new Error('synthetic static-mode refusal'); } },
      '../../server/serve': { start: async () => { throw new Error('synthetic start refusal'); } }
    };
    const cli = isolatedModule('../lib/cli/commands/multitenant', overrides), errors = [];
    try {
      const result = await cli.runRoles(['realtime'], { env: { NS_SERVE_INTERNAL_SOCKET: '/synthetic/cli.sock', NS_API_INTERNAL_SOCKET: '/synthetic/api.sock' }, stderr: { write: value => errors.push(value) } }, 'synthetic-cli', true);
      assert.equal(result, failure === 'start' ? 1 : 78); assert.equal(errors.length, 1);
      assert.equal(observed.fds.size, 0, 'PLACEMENT_CLI previously parsed resources must close');
    } finally { observed.restore(); }
  });

  for (const failure of ['listener', 'replica', 'checkpoint', 'admin', 'feed']) it('PLACEMENT_PRECHECK_' + failure + ': serve closes supplied readers on pre-boot refusal', async function () {
    fs.writeFileSync(file, JSON.stringify(fixture.config())); const observed = observe(file);
    const placement = fixture.placement.load({ MULTITENANT_REALTIME_PLACEMENT: file }, { internal: fixture.internal });
    const serve = isolatedModule('../lib/server/serve', { './listeners': { resolve: () => { if (failure === 'listener') throw new Error('synthetic listener refusal'); return []; }, close: async () => {} } });
    const names = failure === 'replica' ? ['api'] : failure === 'checkpoint' ? ['realtime', 'evaluator'] : failure === 'admin' ? ['admin'] : failure === 'feed' ? ['feed-reader', 'realtime'] : ['realtime'];
    const options = { realtimePreview: { placement, namespaces: { checkpoint: 'same' } } };
    if (failure === 'replica') options.operationConfig = { participants: [{ roles: ['api'] }, { roles: ['api'] }] };
    if (failure === 'checkpoint') options.evaluatorPreview = { namespaces: { checkpoint: 'same' } };
    if (failure === 'admin') options.operationConfig = {};
    try { await assert.rejects(serve.start(names, {}, null, {}, options)); assert.equal(observed.fds.size, 0, 'PLACEMENT_PRECHECK supplied reader must close'); }
    finally { placement.close(); observed.restore(); }
  });

  for (const failure of ['boot', 'shutdown', 'none']) it('PLACEMENT_CLOSE_' + failure + ': actual role composition closes the pinned reader on every exit', async function () {
    fs.writeFileSync(file, JSON.stringify(fixture.config())); const observed = observe(file);
    const placement = fixture.placement.load({ MULTITENANT_REALTIME_PLACEMENT: file }, { internal: fixture.internal });
    const filename = require.resolve('../lib/server/serve'), original = require('node:module').createRequire(filename), output = { exports: {} };
    const overrides = {
      './listeners': { resolve: () => [], close: async () => {} }, './internal-listener': { plan: () => [] },
      './preview-realtime': { boot: async () => { if (failure === 'boot') throw new Error('synthetic boot failure'); return { close: async () => { if (failure === 'shutdown') throw new Error('synthetic shutdown failure'); } }; } }
    };
    require('node:vm').runInThisContext('(function(require,module,exports){' + fs.readFileSync(filename, 'utf8') + '\n})', { filename })(
      id => Object.hasOwn(overrides, id) ? overrides[id] : original(id), output, output.exports);
    try {
      const boot = output.exports.start(['realtime'], {}, null, {}, { realtimePreview: { placement } });
      if (failure === 'boot') await assert.rejects(boot, /synthetic boot failure/);
      else {
        const running = await boot;
        if (failure === 'shutdown') await assert.rejects(running.stop(), /Role shutdown failed/);
        else await running.stop();
      }
      assert.equal(observed.fds.size, 0, 'PLACEMENT_CLOSE descriptor must not survive role exit');
    } finally { placement.close(); observed.restore(); }
  });

  it('PLACEMENT_WRITER: actual fenced publisher uses fsync/rename and actual placement reader observes its generation', async function () {
    fs.writeFileSync(file, JSON.stringify(fixture.config()));
    const observed = observe(file, true), reader = fixture.placement.load({ MULTITENANT_REALTIME_PLACEMENT: file }, { internal: fixture.internal });
    const admission = require('../lib/tenant-lifecycle/operation-window-readiness'), original = admission.admit;
    const calls = [], native = require('node:fs/promises'), rename = native.rename, open = native.open;
    admission.admit = async () => {}; // SQL admission is covered by native publication integration; not claimed here.
    native.rename = async (...args) => { calls.push('rename'); return rename(...args); };
    native.open = async (...args) => {
      const handle = await open(...args), sync = handle.sync.bind(handle);
      handle.sync = async () => { calls.push('sync'); return sync(); }; return handle;
    };
    try {
      for (let i = 0; i < 100; i++) assert.equal(reader.current().generation, 1);
      assert.equal(observed.handles, 1);
      await require('../lib/realtime-placement/publish').publish({ file, candidate: fixture.move(fixture.config(), 'b'), internal: fixture.internal,
        client: { query: async sql => ({ rows: sql.includes('pg_try_advisory') ? [{ held: true }] : [] }) },
        registry: { revision: async () => '1', page: async () => ({ revision: '1', tenants: [] }) }, controlNamespace: 'synthetic_control', confirmStopped: async () => true });
      assert.deepEqual(calls, ['sync', 'rename', 'sync']);
      assert.equal(reader.current().generation, 2); assert.equal(observed.fds.size, 1);
    } finally { reader.close(); assert.equal(observed.fds.size, 0); observed.restore(); admission.admit = original; native.rename = rename; native.open = open; }
  });
});
