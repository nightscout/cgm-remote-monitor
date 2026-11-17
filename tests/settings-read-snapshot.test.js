'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const { performance } = require('node:perf_hooks');
const scope = require('../lib/storage/tenant-scope');
const { options, connectionOptions } = require('../lib/migrations/postgres-check');
const A = '00000000-0000-0000-0000-000000000001';
const config = { connectionString: 'postgres://synthetic:synthetic@127.0.0.1/synthetic_test',
  namespaces: { settings: 'synthetic_settings', operatorPolicy: 'synthetic_policy' } };
// Each ablation is a control for one obligation of the new schedule.
const ABLATIONS = {
  // Put the integrity screen back into the tenant read (Control B sensitivity).
  perRead: ['return connection.readOnlySnapshot(tenant, async ({ query }) => {', 'return connection.readOnlySnapshot(tenant, async ({ query }) => { await screen(query);'],
  // Remove the startup screen (Control A sensitivity).
  startup: ['try { await check(); }', 'try { void check; }']
};
function fixture (ablation) {
  const calls = [], state = { role: {}, scope: {}, object: {}, ledger: null, value: 1 }, pools = [];
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
    if (sql.includes('FROM pg_roles')) return { rows: [{ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, ...state.role }] };
    if (sql.includes('AS creates')) return { rows: [{ creates: false, mutates: false, ...state.scope }] };
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
  // Emulates postgres-connection: readOnly runs one catalogue SELECT outside
  // any tenant; readOnlySnapshot binds the tenant around the value read.
  loaded.require = name => name === '../storage/postgres-connection' ? async opts => {
    pools.push(opts);
    return {
      readOnly: (sql, args) => answer('pool')(sql, args),
      readOnlySnapshot: (tenant, fn) => scope.withTenant(tenant, () => fn({ query: answer('snapshot') })),
      end: async () => { pools.ended = (pools.ended || 0) + 1; }
    };
  } : original(name);
  let source = fs.readFileSync(filename, 'utf8');
  if (ablation) { const [from, to] = ABLATIONS[ablation]; assert(source.includes(from), 'ablation anchor ' + ablation); source = source.replace(from, to); }
  loaded._compile(source, filename);
  const screens = () => calls.filter(call => call.sql.includes('FROM pg_roles')).length;
  const values = () => calls.filter(call => call.sql.includes('JOIN') && !call.sql.includes('pg_namespace')).length;
  return { state, calls, pools, screens, values, open: () => loaded.exports(config) };
}
const mutations = [
  ...['rolsuper', 'rolbypassrls', 'rolcreaterole', 'rolcreatedb', 'rolreplication'].map(key => ['role', { [key]: true }, /unsafe settings identity/]),
  ...['creates', 'mutates'].map(key => ['scope', { [key]: true }, /unsafe settings scope/]),
  ...Object.entries({ secured: false, owns: true, reads: false, writes: true }).map(([key, value]) => ['object', { [key]: value }, /SETTINGS_STORE_UNSAFE/]),
  ...[['missing', 'MIG_STALE'], ['stale', 'MIG_STALE'], ['unknown', 'MIG_UNKNOWN'], ['checksum', 'MIG_DRIFT'], ['order', 'MIG_HISTORY']].map(([value, code]) => ['ledger', value, { code }])
];
describe('settings owned read snapshot guard sequence', function () {
  let previous;
  beforeEach(() => { previous = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(previous));
  it('opens one bounded direct pool, screens once at open, and each read sends only the value SELECT, including after 61 s', async function () {
    const f = fixture(), reader = await f.open();
    const realNow = performance.now, realDate = Date.now;
    try {
      assert.equal(f.screens(), 1, 'opening screens once');
      assert.deepEqual(f.calls.map(call => call.backend), Array(7).fill('pool'), 'the screen runs outside any tenant snapshot');
      assert(f.calls.every(call => call.tenant === undefined));
      assert.equal(f.pools.length, 1); assert.equal(f.pools[0].max, 4); assert.equal(f.pools[0].direct, true);
      assert.equal(f.pools[0].admitBackend, undefined, 'no per-backend admission screen');
      const first = await reader.read(A); f.state.value++;
      const second = await reader.read(A); assert.notEqual(first.version, second.version);
      // A wall or monotonic clock more than 60 s later changes nothing: there is no cadence.
      performance.now = () => realNow.call(performance) + 61000; Date.now = () => realDate() + 61000;
      for (let i = 0; i < 5; i++) await reader.read(A);
      const reads = f.calls.slice(7);
      assert.equal(reads.length, 7, 'one statement per read'); assert(reads.every(call => call.backend === 'snapshot' && call.tenant === A && call.sql.includes('JOIN')));
      assert.equal(f.screens(), 1, 'no read screens');
    } finally { performance.now = realNow; Date.now = realDate; await reader.close(); }
  });
  it('accepts no screen interval or clock option', async function () {
    const factory = require('../lib/tenant-settings/effective-postgres');
    assert.equal(factory.SCREEN_INTERVAL_MS, undefined);
    assert.doesNotMatch(fs.readFileSync(path.resolve(__dirname, '../lib/tenant-settings/effective-postgres.js'), 'utf8'), /screenIntervalMs|admitBackend|AsyncLocalStorage/);
  });
  it('refuses role/scope/object and catalogue mutations at open and at check(), and passes again once restored', async function () {
    for (const [part, value, expected] of mutations) {
      const f = fixture(), reader = await f.open();
      try {
        await reader.read(A); const old = f.state[part]; f.state[part] = value;
        await assert.rejects(reader.check(), expected, part + ' check');
        f.state[part] = old; await reader.check();
      } finally { await reader.close(); }
      const refused = fixture(); refused.state[part] = value;
      await assert.rejects(refused.open(), expected, 'open refuses');
      assert.equal(refused.pools.ended, 1, 'a refused open closes its pool');
      assert.equal(refused.values(), 0, 'no value read without a passing screen');
    }
  });
  it('control: a screen put back in the read is detected by the statement count; removing the startup screen serves an unsafe store', async function () {
    const perRead = fixture('perRead'), reader = await perRead.open();
    try { await reader.read(A); assert.equal(perRead.screens(), 2); assert.throws(() => assert.equal(perRead.screens(), 1), { code: 'ERR_ASSERTION' }); }
    finally { await reader.close(); }
    const unscreened = fixture('startup'); unscreened.state.role = { rolsuper: true };
    const served = await unscreened.open(); assert.equal((await served.read(A)).version, 1, 'ablation serves the unsafe store'); await served.close();
    const intact = fixture(); intact.state.role = { rolsuper: true };
    await assert.rejects(intact.open(), /unsafe settings identity/);
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
