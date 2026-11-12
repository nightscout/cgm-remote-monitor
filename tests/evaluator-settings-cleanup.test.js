'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const CleanupError = require('../lib/storage/postgres-cleanup-error');
function isolated (file, mocks, mutate = source => source) {
  const filename = path.resolve(__dirname, '../lib/' + file), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = loaded.require.bind(loaded); loaded.require = name => Object.hasOwn(mocks, name) ? mocks[name] : original(name);
  loaded._compile(mutate(fs.readFileSync(filename, 'utf8')), filename); return loaded.exports;
}
function fixture (kind, { broken = false, data = false } = {}) {
  const state = { fail: false, queryFailure: true, pools: 0, clients: 0, ends: 0 };
  const primary = Error('SYNTHETIC_PRIMARY_' + kind), cleanup = Error('SYNTHETIC_END_' + kind);
  class Client {
    constructor () { state.clients++; }
    async connect () { if (state.fail && kind === 'migration') throw primary; }
    async query (sql) {
      if (state.fail && state.queryFailure) throw primary;
      if (sql.includes('pg_roles')) return { rows: [{ rolsuper: false, rolbypassrls: false }] };
      return { rows: [{ creates: false, mutates: false }] };
    }
    async end () { state.ends++; if (state.fail) throw cleanup; }
  }
  const readiness = kind === 'readiness' ? isolated('tenant-settings/readiness.js', { pg: { Client } }) : async () => {};
  const migrations = kind === 'migration' ? isolated('migrations/postgres.js', { pg: { Client } }) : null;
  const migration = { run: (...args) => state.fail && migrations ? migrations.run(...args) : Promise.resolve() };
  class Pool {
    constructor () { state.pools++; }
    on () {}
    async query () { throw primary; }
    async end () { state.ends++; throw cleanup; }
  }
  const startup = kind === 'startup' ? isolated('storage/postgres-connection.js', { pg: { Pool }, '../diagnostics/m7': { observePool () {} } }) : null;
  const factory = isolated('tenant-settings/effective-postgres.js', {
    '../storage/tenant-scope': { getTenancyMode: () => 'multi', currentTenant: () => undefined },
    './readiness': readiness, '../migrations/postgres': migration, './component': { resolveEffectiveSettings: () => ({}) },
    '../storage/postgres-connection': startup || (async () => { state.pools++; return {
      withTenant: async (tenant, fn) => fn(),
      async query (sql) { return { rows: sql.includes('pg_class') ? [0, 1].map(() => ({ secured: !(state.fail && kind === 'screen'), owns: false, reads: true, writes: false })) : [{}] }; },
      async end () { state.ends++; if (state.fail && kind === 'screen') throw cleanup; }
    }; })
  });
  const presentation = isolated('tenant-settings/presentation-reader.js', { './effective-postgres': factory }, source => broken
    ? source.replaceAll('if (revalidate && error instanceof PostgresCleanupError && !cleanupErrors.includes(error)) cleanupErrors.push(error);', '') : source);
  const configuration = { connectionString: 'postgres://synthetic:synthetic@127.0.0.1/synthetic', namespaces: { settings: 'synthetic_settings', operatorPolicy: 'synthetic_policy' } };
  const reader = presentation(configuration, data ? {} : { revalidate: true, preserveErrors: true, concurrency: 4, maxPending: 2 });
  return { state, reader, primary, cleanup };
}
const tenant = '00000000-0000-0000-0000-000000000001';
describe('unconfirmed settings PostgreSQL cleanup', function () {
  for (const [kind, refresh] of [['screen', false], ['startup', false], ['readiness', false], ['migration', false], ['readiness', true], ['migration', true]]) {
    it('poisons ' + kind + (refresh ? ' refresh' : ' initialization') + ' end failure, with removed signal handling red and restoration green', async function () {
      async function observe (broken) {
        const f = fixture(kind, { broken });
        if (refresh) await f.reader.read(tenant);
        f.state.fail = true;
        await assert.rejects(f.reader.read(tenant), error => {
          assert(error instanceof CleanupError); assert.equal(error.code, 'POSTGRES_CLEANUP_UNCONFIRMED');
          assert.equal(error.cleanupError, f.cleanup);
          if (kind === 'screen') assert.equal(error.cause.code, 'SETTINGS_STORE_UNSAFE');
          else assert.equal(error.cause, f.primary);
          return true;
        });
        const before = f.state.clients + f.state.pools;
        await assert.rejects(f.reader.read(tenant), broken ? { code: 'POSTGRES_CLEANUP_UNCONFIRMED' } : { code: 'SETTINGS_POLICY_UNAVAILABLE' });
        const after = f.state.clients + f.state.pools;
        if (broken) await f.reader.close();
        else await assert.rejects(f.reader.close(), error => error.errors.some(value => value instanceof CleanupError));
        return { before, after };
      }
      const old = await observe(true); assert(old.after > old.before, 'mutant creates another backend after unconfirmed cleanup');
      assert.throws(() => assert.equal(old.after, old.before), { code: 'ERR_ASSERTION' });
      const fixed = await observe(false); assert.equal(fixed.after, fixed.before, 'strict owner refuses replacement');
    });
  }
  it('poisons a successful readiness check whose direct client end alone fails', async function () {
    const f = fixture('readiness'); f.state.queryFailure = false; f.state.fail = true;
    await assert.rejects(f.reader.read(tenant), error => error instanceof CleanupError && error.cause === f.cleanup && error.cleanupError === f.cleanup);
    await assert.rejects(f.reader.read(tenant), { code: 'SETTINGS_POLICY_UNAVAILABLE' }); assert.equal(f.state.clients, 1);
    await assert.rejects(f.reader.close(), /shutdown failed/);
  });
  it('preserves DATA default refusal mapping and initial failure retry behavior', async function () {
    const f = fixture('screen', { data: true }); f.state.fail = true;
    for (let i = 0; i < 2; i++) await assert.rejects(f.reader.read(tenant), { code: 'SETTINGS_POLICY_UNAVAILABLE' });
    assert.equal(f.state.pools, 2); await f.reader.close();
  });
});
