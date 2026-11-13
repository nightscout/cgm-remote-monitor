'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const scope = require('../lib/storage/tenant-scope');
const { options, connectionOptions } = require('../lib/migrations/postgres-check');
const A = '00000000-0000-0000-0000-000000000001';
const config = { connectionString: 'postgres://synthetic:synthetic@127.0.0.1/synthetic_test',
  namespaces: { settings: 'synthetic_settings', operatorPolicy: 'synthetic_policy' } };
function fixture (skip = false) {
  const calls = [], state = { role: {}, scope: {}, object: {}, ledger: null, value: 1 }, pools = [];
  const catalogues = Object.fromEntries(Object.entries({ settings: require('../lib/tenant-settings/postgres-candidate.json'),
    operatorPolicy: require('../lib/operator-policy/postgres-candidate.json') }).map(([kind, catalogue]) => {
    const opts = options({ ...config, direct: true, namespace: config.namespaces[kind], catalogue });
    return [opts.table, opts.files.map(({ name, checksum }) => ({ name, checksum }))];
  }));
  const filename = path.resolve(__dirname, '../lib/tenant-settings/effective-postgres.js'), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = loaded.require.bind(loaded);
  loaded.require = name => name === '../storage/postgres-connection' ? async opts => {
    pools.push(opts); return {
      readOnlySnapshot: (tenant, fn) => scope.withTenant(tenant, () => fn({ query: async (sql, args) => {
        calls.push({ sql, args, tenant: scope.currentTenant() });
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
      } })), end: async () => {}
    };
  } : original(name);
  let source = fs.readFileSync(filename, 'utf8'); if (skip) source = source.replace('await screen(query);', 'void 0;');
  loaded._compile(source, filename);
  return { state, calls, pools, open: () => loaded.exports(config) };
}
describe('settings owned read snapshot guard sequence', function () {
  let previous;
  beforeEach(() => { previous = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(previous));
  it('reuses one bounded direct pool, repeats every guard before every fresh value, and returns current values', async function () {
    const f = fixture(), reader = await f.open();
    try {
      const first = await reader.read(A); f.state.value++;
      const second = await reader.read(A); assert.notEqual(first.version, second.version);
      assert.equal(f.pools.length, 1); assert.equal(f.pools[0].max, 4); assert.equal(f.pools[0].direct, true);
      assert.equal(f.calls.length, 16); assert(f.calls.every(call => call.tenant === A));
      for (let i = 0; i < 16; i += 8) {
        assert(f.calls[i].sql.includes('pg_roles')); assert(f.calls[i + 1].sql.includes('AS creates'));
        assert(f.calls[i + 2].sql.includes('to_regclass')); assert(f.calls[i + 4].sql.includes('to_regclass'));
        assert(f.calls[i + 6].sql.includes('pg_class')); assert(f.calls[i + 7].sql.includes('JOIN'));
      }
    } finally { await reader.close(); }
  });
  it('refuses per-read role/scope/object and catalogue mutations before values, then reads fresh after restoration', async function () {
    const mutations = [
      ...['rolsuper', 'rolbypassrls', 'rolcreaterole', 'rolcreatedb', 'rolreplication'].map(key => ['role', { [key]: true }, /unsafe settings identity/]),
      ...['creates', 'mutates'].map(key => ['scope', { [key]: true }, /unsafe settings scope/]),
      ...Object.entries({ secured: false, owns: true, reads: false, writes: true }).map(([key, value]) => ['object', { [key]: value }, /SETTINGS_STORE_UNSAFE/]),
      ...[['missing', 'MIG_STALE'], ['stale', 'MIG_STALE'], ['unknown', 'MIG_UNKNOWN'], ['checksum', 'MIG_DRIFT'], ['order', 'MIG_HISTORY']].map(([value, code]) => ['ledger', value, { code }])
    ];
    for (const [part, value, expected] of mutations) {
      const f = fixture(), reader = await f.open();
      try {
        await reader.read(A); const old = f.state[part]; f.state[part] = value;
        await assert.rejects(reader.read(A), expected);
        assert.equal(f.calls.filter(call => call.sql.includes('JOIN') && !call.sql.includes('pg_namespace')).length, 1);
        f.state[part] = old; f.state.value++; assert.equal((await reader.read(A)).version, 2);
      } finally { await reader.close(); }
    }
  });
  it('detects omitted per-read screening against the same mutable authority and restores the source', async function () {
    async function observe (skip) {
      const f = fixture(skip), reader = await f.open();
      try { await reader.read(A); f.state.role.rolsuper = true; await assert.rejects(reader.read(A), /unsafe settings identity/); }
      finally { await reader.close(); }
    }
    await assert.rejects(observe(true), { code: 'ERR_ASSERTION' }); await observe(false);
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
