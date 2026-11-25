'use strict';
const assert = require('node:assert/strict');
const readiness = require('../lib/server/serve/evaluator-readiness');
const config = () => ({ namespaces: { clock: 'rt_clock', checkpoint: 'rt_delivery' }, completedOutput: { namespace: 'ev_output' }, consumer: 'realtime-readiness', tenants: new Map([['11111111-1111-4111-8111-111111111111', true]]) });
describe('completed-output realtime readiness scope', function () {
  function fixture (failure) {
    const calls = [];
    const connection = { async query (sql, values) {
      calls.push({ sql, values });
      if (sql.includes('FROM pg_roles WHERE rolname=current_user')) return { rows: [{ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, operator: false }] };
      if (sql.includes('WITH identities')) return { rows: [{ creates: false, unrelated: failure === 'clinical-grant' }] };
      const own = values[0] === 'rt_delivery.tenant_consumer_checkpoint';
      return { rows: [{ secured: true, reads: failure !== 'source-select' || values[0] !== 'ev_output.tenant_consumer_checkpoint', forbidden: false,
        updates: own && failure === 'delivery-update', bookkeeping: own, extra: own && failure === 'legacy-update' }] };
    } };
    return { connection, calls };
  }
  it('selects only clock and typed delivery catalogues, without clinical ledgers or socket-order floors', async function () {
    const cfg = { ...config(), socketOrderDomains: ['profile'], namespaces: { ...config().namespaces, profile: 'obsolete_profile', changeStamps: 'obsolete_stamps' } };
    const catalogues = readiness.cataloguesFor(cfg);
    assert.deepEqual(Object.keys(catalogues), ['clock', 'checkpoint']);
    assert.deepEqual(catalogues.checkpoint, require('../migrations/candidates/postgres-realtime-output-v2.json'));
    const f = fixture(); await readiness.screen(f.connection, cfg);
    const global = f.calls.find(call => call.sql.includes('WITH identities'));
    assert.deepEqual(global.values[0], [], 'realtime is a reader: no table is writable');
    assert.deepEqual(global.values[1], ['rt_clock.tenant_write_clock', 'rt_delivery.tenant_consumer_checkpoint', 'rt_clock.schema_migrations', 'rt_delivery.schema_migrations', 'ev_output.tenant_consumer_checkpoint']);
    const tables = f.calls.filter(call => call.sql.includes('c.relrowsecurity'));
    assert.deepEqual(tables.map(call => call.values[0]), ['rt_clock.tenant_write_clock', 'rt_delivery.tenant_consumer_checkpoint', 'ev_output.tenant_consumer_checkpoint']);
    assert.deepEqual(tables.find(call => call.values[0] === 'rt_delivery.tenant_consumer_checkpoint').values[1], []);
    assert(!f.calls.some(call => /tenant_insertion_ordinal/.test(call.sql)));
  });
  it('refuses a retained delivery UPDATE, legacy checkpoint UPDATE, missing completed source SELECT and clinical grants', async function () {
    for (const reason of ['delivery-update', 'legacy-update', 'source-select', 'clinical-grant']) {
      await readiness.screen(fixture().connection, config());
      await assert.rejects(readiness.screen(fixture(reason).connection, config()), /unsafe evaluator/, reason);
      await readiness.screen(fixture().connection, config());
    }
  });
  it('provisions exact checkpoint and clock rows without clinical reads or insertion floors', async function () {
    const calls = [], cfg = config(), tenant = [...cfg.tenants.keys()][0];
    const connection = { withTenant: async (bound, fn) => { assert.equal(bound, tenant); return fn(); }, query: async (sql, values) => { calls.push({ sql, values }); return { rows: [{ checkpoint: '0', last_stamp: '0' }] }; } };
    await readiness.provisionTenant(connection, cfg, tenant);
    assert.equal(calls.length, 1);assert.match(calls[0].sql, /JOIN "rt_clock".tenant_write_clock/);assert.deepEqual(calls[0].values, [tenant, cfg.consumer]);
    await assert.rejects(readiness.provisionTenant({ ...connection, query: async () => ({ rows: [] }) }, cfg, tenant), /missing evaluator tenant provisioning/);
  });
});
