'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const scope = require('../lib/storage/tenant-scope');
const { options, connectionOptions } = require('../lib/migrations/postgres-check');
const A = '00000000-0000-0000-0000-000000000001';
const config = { connectionString: 'postgres://synthetic:synthetic@127.0.0.1/synthetic_test',
  namespaces: { settings: 'synthetic_settings', operatorPolicy: 'synthetic_policy' } };
// Each ablation removes one part of the screening schedule.
const ABLATIONS = {
  admission: ['if (ticket) { ticket.admitted = true; return; }', 'if (ticket) return;'],
  cadence: [' || ticket.at - passed.at >= screenIntervalMs', ''],
  failClosed: ['catch (error) { refusedThrough = issued; throw error; }', 'catch (error) { throw error; }'],
  narrow: ['catch (error) { refusedThrough = issued; throw error; }', 'catch (error) { refusedThrough = ticket.id; throw error; }']
};
function fixture (ablation) {
  const calls = [], state = { role: {}, scope: {}, object: {}, ledger: null, value: 1, fresh: false }, pools = [], clock = { t: 0 };
  const catalogues = Object.fromEntries(Object.entries({ settings: require('../lib/tenant-settings/postgres-candidate.json'),
    operatorPolicy: require('../lib/operator-policy/postgres-candidate.json') }).map(([kind, catalogue]) => {
    const opts = options({ ...config, direct: true, namespace: config.namespaces[kind], catalogue });
    return [opts.table, opts.files.map(({ name, checksum }) => ({ name, checksum }))];
  }));
  const filename = path.resolve(__dirname, '../lib/tenant-settings/effective-postgres.js'), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = loaded.require.bind(loaded);
  const answer = backend => async (sql, args) => {
    calls.push({ sql, args, tenant: scope.currentTenant(), backend });
    if (/^(BEGIN|ROLLBACK)/.test(sql)) return { rows: [] };
    if (sql.includes('FROM pg_roles')) await state.beforeScreen?.(backend);
    if (sql.includes('FROM pg_roles')) return { rows: [{ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, ...state.role }] };
    if (sql.includes('AS creates')) return { rows: [{ creates: false, mutates: backend === state.unsafeBackend, ...state.scope }] };
    if (sql.includes('to_regclass')) return { rows: [{ present: state.ledger !== 'missing' }] };
    if (sql.includes('SELECT name, checksum')) {
      const table = Object.keys(catalogues).find(table => sql.includes(table));
      const rows = structuredClone(catalogues[table]);
      if (state.ledger === 'stale') rows.pop();
      if (state.ledger === 'unknown') rows.push({ name: 'unknown', checksum: 'unknown' });
      if (state.ledger === 'checksum') rows[0].checksum = 'bad';
      if (state.ledger === 'order') rows.reverse();
      return { rows };
    }
    if (sql.includes('pg_class')) return { rows: [0, 1].map(() => ({ secured: true, owns: false, reads: true, writes: false, ...state.object })) };
    assert(sql.includes('JOIN')); return { rows: [{ version: state.value, values: {}, generation: state.value, policy: { deployment: {}, overrides: {} } }] };
  };
  // Emulates postgres-connection: admitBackend runs once per new physical
  // backend (pool construction included); a failed read evicts its backend.
  loaded.require = name => name === '../storage/postgres-connection' ? async opts => {
    pools.push(opts); const idle = []; let next = 0;
    const first = ++next; await opts.admitBackend({ query: answer(first) }); idle.push(first);
    return {
      readOnlySnapshot: (tenant, fn) => scope.withTenant(tenant, async () => {
        let backend = state.fresh ? undefined : idle.pop();
        if (backend === undefined) { backend = ++next; await opts.admitBackend({ query: answer(backend) }); }
        const value = await fn({ query: answer(backend) });
        idle.push(backend); return value;
      }), end: async () => {}
    };
  } : original(name);
  let source = fs.readFileSync(filename, 'utf8');
  if (ablation) { const [from, to] = ABLATIONS[ablation]; assert(source.includes(from), 'ablation anchor ' + ablation); source = source.replace(from, to); }
  loaded._compile(source, filename);
  const screens = () => calls.filter(call => call.sql.includes('FROM pg_roles')).length;
  const values = () => calls.filter(call => call.sql.includes('JOIN') && !call.sql.includes('pg_namespace')).length;
  return { state, calls, pools, clock, screens, values, open: () => loaded.exports(config, { now: () => clock.t }) };
}
const mutations = [
  ...['rolsuper', 'rolbypassrls', 'rolcreaterole', 'rolcreatedb', 'rolreplication'].map(key => ['role', { [key]: true }, /unsafe settings identity/]),
  ...['creates', 'mutates'].map(key => ['scope', { [key]: true }, /unsafe settings scope/]),
  ...Object.entries({ secured: false, owns: true, reads: false, writes: true }).map(([key, value]) => ['object', { [key]: value }, /SETTINGS_STORE_UNSAFE/]),
  ...[['missing', 'MIG_STALE'], ['stale', 'MIG_STALE'], ['unknown', 'MIG_UNKNOWN'], ['checksum', 'MIG_DRIFT'], ['order', 'MIG_HISTORY']].map(([value, code]) => ['ledger', value, { code }])
];
const outcome = promise => promise.then(() => 'served', error => error.message);
describe('settings owned read snapshot guard sequence', function () {
  let previous;
  beforeEach(() => { previous = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(previous));
  it('reuses one bounded direct pool; screens at backend admission and when the interval ends, not on each warm read', async function () {
    const f = fixture(), reader = await f.open();
    try {
      assert.equal(f.screens(), 1, 'pool construction screens its first backend');
      assert.deepEqual(f.calls.map(call => call.sql.split(/\s/)[0]), ['BEGIN', ...Array(7).fill('SELECT'), 'ROLLBACK']);
      const first = await reader.read(A); f.state.value++;
      const second = await reader.read(A); assert.notEqual(first.version, second.version);
      assert.equal(f.pools.length, 1); assert.equal(f.pools[0].max, 4); assert.equal(f.pools[0].direct, true);
      assert.equal(typeof f.pools[0].admitBackend, 'function');
      assert.equal(f.calls.length, 11, 'warm reads issue only the value SELECT'); assert(f.calls.slice(9).every(call => call.tenant === A && call.sql.includes('JOIN')));
      f.clock.t = 59999; await reader.read(A); assert.equal(f.screens(), 1, 'inside the interval');
      f.clock.t = 60000; await reader.read(A); assert.equal(f.screens(), 2, 'the interval ended');
      const due = f.calls.slice(-8);
      assert(due[0].sql.includes('pg_roles')); assert(due[1].sql.includes('AS creates'));
      assert(due[2].sql.includes('to_regclass')); assert(due[4].sql.includes('to_regclass'));
      assert(due[6].sql.includes('pg_class')); assert(due[7].sql.includes('JOIN')); assert(due.every(call => call.tenant === A), 'screen shares the value snapshot');
      f.state.fresh = true; await reader.read(A); assert.equal(f.screens(), 3, 'a new backend is screened before its first value');
    } finally { await reader.close(); }
  });
  it('validates the bounded interval and the clock', async function () {
    const factory = require('../lib/tenant-settings/effective-postgres');
    for (const screenIntervalMs of [-1, 1.5, 3600001, '60000']) await assert.rejects(factory({ ...config, screenIntervalMs }), { message: 'Bounded settings screen interval required' });
    await assert.rejects(factory(config, { now: 1 }), { message: 'Settings screen clock must be a function' });
    assert.equal(factory.SCREEN_INTERVAL_MS, 60000);
  });
  it('refuses role/scope/object and catalogue mutations at backend admission, at the due screen, and keeps refusing until a passing screen', async function () {
    for (const [part, value, expected] of mutations) {
      for (const via of ['admission', 'cadence']) {
        const f = fixture(), reader = await f.open();
        try {
          await reader.read(A); const old = f.state[part]; f.state[part] = value;
          await reader.read(A); // warm backend inside the interval is not screened
          if (via === 'admission') f.state.fresh = true; else f.clock.t = 60000;
          const valuesBefore = f.values();
          await assert.rejects(reader.read(A), expected);
          f.state.fresh = false;
          await assert.rejects(reader.read(A), expected, 'fail-closed on a warm backend');
          assert.equal(f.values(), valuesBefore, 'no value SELECT after a failed or pending screen');
          f.state[part] = old; f.state.value++;
          const screened = f.screens(); assert.equal((await reader.read(A)).version, 2); assert.equal(f.screens(), screened + 1, 'recovery read screens');
          await reader.read(A); assert.equal(f.screens(), screened + 1, 'then warm again');
        } finally { await reader.close(); }
      }
      const f = fixture(); f.state[part] = value;
      await assert.rejects(f.open(), expected, 'pool construction refuses');
    }
  });
  it('a screen issued before a recorded failure cannot clear it; narrowing the refusal to the failing ticket is red', async function () {
    async function observe (narrow) {
      const f = fixture(narrow ? 'narrow' : undefined), reader = await f.open();
      try {
        await reader.read(A); f.clock.t = 60000;
        let release; const held = new Promise(resolve => { release = resolve; });
        f.state.unsafeBackend = 2; f.state.fresh = true;
        const failing = reader.read(A); f.state.fresh = false;
        f.state.beforeScreen = backend => backend === 1 ? held : undefined;
        const older = reader.read(A); // issued before the failure is recorded
        await assert.rejects(failing, /unsafe settings scope/);
        f.state.beforeScreen = undefined; release();
        assert.equal((await older).version, 1, 'its own snapshot screen passed');
        const screened = f.screens(); await reader.read(A);
        return f.screens() - screened;
      } finally { await reader.close(); }
    }
    assert.equal(await observe(false), 1, 'the next warm read must screen again');
    assert.equal(await observe(true), 0, 'mutant lets an older pass clear the failure');
  });
  it('control: each ablated part serves an unsafe store, and the intact source refuses', async function () {
    async function observe (ablation) {
      const result = {};
      for (const via of ['admission', 'cadence', 'failClosed']) {
        const f = fixture(ablation), reader = await f.open();
        try {
          await reader.read(A); f.state.role = { rolsuper: true };
          if (via === 'admission') { f.state.fresh = true; result[via] = await outcome(reader.read(A)); }
          if (via === 'cadence') { f.clock.t = 60000; result[via] = await outcome(reader.read(A)); }
          if (via === 'failClosed') { f.state.fresh = true; await outcome(reader.read(A)); f.state.fresh = false; result[via] = await outcome(reader.read(A)); }
        } finally { await reader.close(); }
      }
      return result;
    }
    const refused = 'unsafe settings identity';
    assert.deepEqual(await observe(), { admission: refused, cadence: refused, failClosed: refused });
    for (const ablation of ['admission', 'cadence', 'failClosed']) {
      const red = await observe(ablation);
      assert.equal(red[ablation], 'served', ablation + ' ablation serves the unsafe store');
      assert.throws(() => assert.equal(red[ablation], refused), { code: 'ERR_ASSERTION' });
    }
  });
  it('keeps explicit direct URL and SSL normalization independent of ambient PG defaults', function () {
    const normalized = connectionOptions(config.connectionString + '?sslmode=verify-full');
    assert.equal(normalized.host, '127.0.0.1'); assert.equal(normalized.port, 5432); assert.equal(normalized.database, 'synthetic_test');
    assert.deepEqual(normalized.ssl, { rejectUnauthorized: true }); assert.equal(normalized.options, '-c search_path=pg_catalog');
    for (const url of ['synthetic', 'postgres://user@localhost/db', config.connectionString + '?sslmode=require', config.connectionString + '?options=bad']) {
      assert.throws(() => connectionOptions(url), { code: 'MIG_CONNECTION' });
    }
  });
});
