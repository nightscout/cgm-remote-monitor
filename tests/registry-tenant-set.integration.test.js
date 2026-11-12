'use strict';

// The registry tenant set of the evaluator and realtime (decision
// tenant-registry, stage 1): active tenants enumerated at start; a removed
// tenant is inactive within the refresh bound; a tenant added after start is
// counted as waiting and alerted; and what a restart costs to pick one up
// (enumeration and entry build) at the tenant counts this lab can run.
// Registry-only rows written as the database owner; synthetic ids and hosts.
// covers: lib/server/serve/registry-tenant-set.js, lib/server/serve/evaluator-config.js
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { Client } = require('pg');
const scope = require('../lib/storage/tenant-scope');
const { run } = require('../lib/migrations/postgres');
const registry = require('../lib/tenant-registry/postgres');
const { registryEntry } = require('../lib/server/serve/evaluator-config');
const { open } = require('../lib/server/serve/registry-tenant-set');
const { optInSuite } = require('./support/opt-in');

const ADMIN = process.env.NS_TEST_POSTGRES_ADMIN_URI;
const COUNTS = (process.env.NS_REGISTRY_RESTART_COUNTS || '100,1000,3000').split(',').map(Number);
optInSuite(!!ADMIN && /test/i.test(new URL(ADMIN || 'postgres://x/none').pathname),
  'disposable NS_TEST_POSTGRES_ADMIN_URI (database name containing "test")')('registry tenant set (actual PostgreSQL)', function () {
  this.timeout(300000);
  const id = randomUUID().replace(/-/g, '').slice(0, 10);
  const ns = 'rts_reg_' + id, owner = 'rts_owner_' + id, role = 'rts_eval_' + id;
  let admin, url, prior;
  const q = (sql, values) => admin.query(sql, values);
  async function add (tenants) {
    await q(`INSERT INTO "${ns}".tenant_registry (tenant_id, state, signing_version) SELECT unnest($1::uuid[]), 'active', 1`, [tenants]);
    await q(`INSERT INTO "${ns}".tenant_registry_hosts (host, tenant_id, kind) SELECT 'h-' || t || '.example.test', t, 'alias' FROM unnest($1::uuid[]) t`, [tenants]);
  }
  before(async function () {
    prior = scope.getTenancyMode(); scope.setTenancyMode('multi');
    admin = new Client({ connectionString: ADMIN }); await admin.connect();
    await q(`CREATE ROLE "${owner}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    const password = randomBytes(18).toString('hex');
    await q(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
    const u = new URL(ADMIN); u.username = role; u.password = password; url = u.toString();
    await q(`CREATE SCHEMA "${ns}"`);
    await run('up', { direct: true, connectionString: ADMIN, namespace: ns, catalogue: registry.catalogue });
    await q(`ALTER SCHEMA "${ns}" OWNER TO "${owner}"`);
    for (const table of ['tenant_registry', 'tenant_registry_hosts', 'tenant_registry_keys', 'tenant_registry_clock']) await q(`ALTER TABLE "${ns}".${table} OWNER TO "${owner}"`);
    for (const fn of ['tenant_registry_lookup(text, text)', 'tenant_registry_revision()', 'tenant_registry_tenants(uuid, integer)', 'tenant_registry_touch()']) await q(`ALTER FUNCTION "${ns}".${fn} OWNER TO "${owner}"`);
    for (const sql of registry.grants({ namespace: ns, enumerators: [role] })) await q(sql);
  });
  after(async function () {
    if (admin) {
      await q(`DROP SCHEMA IF EXISTS "${ns}" CASCADE`).catch(() => {});
      for (const name of [role, owner]) { await q(`DROP OWNED BY "${name}"`).catch(() => {}); await q(`DROP ROLE IF EXISTS "${name}"`).catch(() => {}); }
      await admin.end();
    }
    scope.setTenancyMode(prior);
  });

  it('RS_START_REMOVE_WAIT: the start set is the active tenants; a removal is inactive after one poll; added tenants are counted as waiting and alerted with the count', async function () {
    const start = Array.from({ length: 5 }, () => randomUUID());
    await add(start);
    const alerts = [];
    const set = await open({ settings: { namespace: ns, refreshMs: 60000 }, connectionString: url, maxTenants: 100000, build: registryEntry,
      alert: (code, detail) => alerts.push([code, detail]) });
    try {
      assert.deepEqual([...set.tenants.keys()].sort(), start.slice().sort());
      assert.ok(start.every(set.isActive));
      assert.equal(set.tenants.get(start[0]).tenant, start[0]);
      await q(`DELETE FROM "${ns}".tenant_registry_hosts WHERE tenant_id = $1`, [start[0]]);
      await q(`UPDATE "${ns}".tenant_registry SET state = 'removed' WHERE tenant_id = $1`, [start[0]]);
      await set.poll();
      assert.equal(set.isActive(start[0]), false, 'removed tenant inactive');
      assert.equal(set.isActive(start[1]), true);
      await add([randomUUID()]); await set.poll();
      await add([randomUUID(), randomUUID()]); await set.poll();
      assert.equal(set.waiting(), 3);
      assert.deepEqual(alerts, [['TENANT_REGISTRY_EXPANSION_RESTART', { waiting: 1 }], ['TENANT_REGISTRY_EXPANSION_RESTART', { waiting: 3 }]]);
      assert.equal(set.stats().waiting, 3);
      assert.equal(set.tenants.size, 5, 'the served set stays the start set');
    } finally { await set.close(); }
  });

  it('RS_RESTART_COST: one restart picks up a waiting tenant; enumeration and entry build timed at ' + COUNTS.join(', ') + ' tenants', async function () {
    await q(`DELETE FROM "${ns}".tenant_registry_hosts`); await q(`DELETE FROM "${ns}".tenant_registry_keys`); await q(`DELETE FROM "${ns}".tenant_registry`);
    let have = 0;
    for (const count of COUNTS) {
      const batch = Array.from({ length: count - have }, () => randomUUID());
      for (let i = 0; i < batch.length; i += 1000) await add(batch.slice(i, i + 1000));
      have = count;
      const late = randomUUID();
      const before = await open({ settings: { namespace: ns, refreshMs: 60000 }, connectionString: url, maxTenants: 100000, build: registryEntry, alert: () => {} });
      await add([late]); await before.poll();
      assert.equal(before.waiting(), 1); await before.close();
      const t0 = process.hrtime.bigint();
      const restarted = await open({ settings: { namespace: ns, refreshMs: 60000 }, connectionString: url, maxTenants: 100000, build: registryEntry, alert: () => {} });
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      try {
        assert.ok(restarted.tenants.has(late) && restarted.isActive(late), 'picked up on restart');
        assert.equal(restarted.tenants.size, count + 1);
        console.log('      RS_RESTART_COST ' + (count + 1) + ' tenants: enumerate + build ' + ms.toFixed(0) + ' ms (' + restarted.stats().enumerations + ' enumeration)');
      } finally { await restarted.close(); }
      have += 1;
    }
  });
});
