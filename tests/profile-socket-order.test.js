'use strict';
const assert = require('node:assert/strict');
const reads = require('../lib/server/storage-reads');
const profile = require('../lib/server/tenant-app/profile');
const old = require('../migrations/candidates/postgres-profile-v1.json');
const successor = require('../migrations/candidates/postgres-profile-socket-order-v1.json');
function database (rows) {
  const queries = [];
  return { queries, transaction: fn => fn(), async query (sql, values) {
    queries.push({ sql, values });
    // SQL protocol only. Native PG/Mongo restoration is independently required.
    const ordered = sql.includes('ORDER BY insertion_ordinal ASC') ? rows : [...rows].sort((a, b) => a.doc._id.localeCompare(b.doc._id));
    return { rows: ordered.slice(0, 1) };
  } };
}
describe('explicit profile socket insertion-order source contract', function () {
  it('keeps exact reviewed base migration/checksum as the validated successor prefix', function () {
    assert.deepEqual(successor.migrations.slice(0, old.migrations.length), old.migrations, 'PROFILE_CATALOGUE_PREFIX pinned base is unchanged');
    require('../lib/migrations/catalogue').validateCatalogue(successor);
    assert.equal(successor.migrations.length, old.migrations.length + 1);
  });
  it('selected full-record profile first match uses persistent arrival order, not existence or sorted identity', async function () {
    const first = { id_kind: 'string', doc: { _id: 'z-first', NSCLIENT_ID: 'synthetic', startDate: '2026-11-06', store: { Synthetic: { dia: 3 } } } };
    const second = { id_kind: 'string', doc: { _id: 'a-second', NSCLIENT_ID: 'synthetic', startDate: '2026-11-06', store: { Synthetic: { dia: 9 } } } };
    const connection = database([first, second]);
    const port = profile({ connection, table: 'profile_source.profile', source: 'socket', naturalOrder: true });
    const selected = await reads.findOne(port.storage, { NSCLIENT_ID: 'synthetic' });
    assert.equal(selected._id, 'z-first', 'PROFILE_FULL_RECORD_FIRST_MATCH selects arrival, not sorted id');
    assert.deepEqual(selected.store, first.doc.store, 'PROFILE_FULL_RECORD_FIRST_MATCH retains clinical profile, not existence projection');
    assert(connection.queries[0].sql.includes('ORDER BY insertion_ordinal ASC'));
  });
  it('selected empty profile lookup resolves absence while unselected default still refuses bounded unsorted lookup', async function () {
    const connection = database([]);
    const selected = profile({ connection, table: 'profile_source.profile', source: 'socket', naturalOrder: true });
    assert.equal(await reads.findOne(selected.storage, { startDate: 'synthetic-time' }), null, 'PROFILE_EMPTY_LOOKUP actual absence can reach canonical insert');
    const unselected = profile({ connection, table: 'profile_source.profile', source: 'socket' });
    await assert.rejects(reads.findOne(unselected.storage, { startDate: 'synthetic-time' }), /without a sort/);
  });
  it('API selected whole-domain readiness admits successor while default REST/profile-editor boot retains base', function () {
    const select = require('../lib/server/serve/postgres-domains').cataloguesFor;
    assert.equal(select({ domains: ['profile'] }).profile, old);
    assert.equal(select({ domains: ['profile'], socketForwarding: true }).profile, successor);
    assert.throws(() => profile({ connection: database([]), source: 'v3', naturalOrder: true }), /socket selection/);
    assert.throws(() => profile({ connection: database([]), source: 'socket', naturalOrder: 'true' }), /socket selection/);
  });
  it('reader readiness selects only explicit reviewed successors and preserves base defaults', function () {
    const cataloguesFor = require('../lib/server/serve/evaluator-readiness').cataloguesFor;
    assert.equal(cataloguesFor({}).profile, old);
    assert.equal(cataloguesFor({ socketOrderDomains: ['profile'] }).profile, successor);
    assert.equal(cataloguesFor({ socketOrderDomains: ['profile'] }).entries, require('../migrations/candidates/postgres-entries-v1.json'));
    for (const value of [['profile', 'profile'], ['entries'], ['unknown'], 'profile', null]) {
      assert.throws(() => cataloguesFor({ socketOrderDomains: value }), /reviewed/);
    }
  });
  it('consumed selected socket composition checks successor and returns actual profile factory port', async function () {
    const migration = require('../lib/migrations/postgres'), original = migration.run, seen = [];
    migration.run = async (action, opts) => { seen.push({ action, opts }); return { current: true }; };
    try {
      delete require.cache[require.resolve('../lib/server/tenant-socket-order-port')];
      const create = require('../lib/server/tenant-socket-order-port');
      const port = await create({ readinessConnectionString: 'postgres://synthetic', namespace: 'profile_source', logical: 'profile', connection: database([]) });
      assert.equal(seen[0].action, 'check'); assert.equal(seen[0].opts.catalogue, successor);
      assert.equal(typeof port.fallbackGetDate, 'function', 'PROFILE_REAL_FACTORY domain wrapper remains consumed');
      assert.equal(await reads.findOne(port.storage, { NSCLIENT_ID: 'synthetic' }), null);
    } finally { migration.run = original; delete require.cache[require.resolve('../lib/server/tenant-socket-order-port')]; }
  });
});
