'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client, Pool } = require('pg');
const { optInSuite } = require('./support/opt-in');
const { run } = require('../lib/migrations/postgres');
const readiness = require('../lib/server/serve/evaluator-readiness');
const windows = require('../lib/tenant-lifecycle/operation-window');
const native = require('../lib/tenant-lifecycle/native-selection');
const controlReads = require('../lib/storage/postgres-operation-control');
const columns = require('../lib/pgstream/realtime-receipt').COLUMNS;
const quote = name => '"' + name + '"';
const A = '11111111-1111-4111-8111-111111111111';

optInSuite(process.env.NS_PGSTREAM_ROLE_TEST === '1' && !!process.env.NS_TEST_POSTGRES_ADMIN_URI,
  'NS_PGSTREAM_ROLE_TEST=1 with disposable NS_TEST_POSTGRES_ADMIN_URI')('native operation-control readiness scope', function () {
  this.timeout(30000);
  const prefix = 'native_scope_' + crypto.randomBytes(5).toString('hex');
  const ns = Object.fromEntries(['clock', 'rt', 'source', 'control', 'unrelated'].map(kind => [kind, prefix + '_' + kind]));
  const owner = prefix + '_owner', role = prefix + '_reader', lifetime = prefix + '_lifetime';
  const config = { namespaces: {clock: ns.clock, checkpoint: ns.rt}, completedOutput: {namespace: ns.source} };
  const table = (kind, name) => quote(ns[kind]) + '.' + quote(name);
  let admin, reader, pool, window, selected;
  const createdSchemas = [], createdRoles = [];
  async function own(namespace, catalogue) {
    await run('up', {direct: true, connectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI, namespace, catalogue});
    createdSchemas.push(namespace);
    for (const row of (await admin.query('SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname=$1', [namespace])).rows) {
      await admin.query('ALTER TABLE ' + quote(namespace) + '.' + quote(row.tablename) + ' OWNER TO ' + quote(owner));
    }
    for (const row of (await admin.query('SELECT p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1', [namespace])).rows) {
      await admin.query('ALTER FUNCTION ' + row.signature + ' OWNER TO ' + quote(owner));
    }
    await admin.query('ALTER SCHEMA ' + quote(namespace) + ' OWNER TO ' + quote(owner));
  }
  async function check() { await readiness.screen(reader, config, {operationWindow: window}); }
  async function rejectedGrant(grant, revoke, pattern) {
    await check();
    await admin.query(grant);
    try { await assert.rejects(check(), pattern); }
    finally { await admin.query(revoke); }
    await check();
  }
  before(async function () {
    admin = new Client({connectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI}); await admin.connect();
    await admin.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await admin.query('REVOKE CREATE ON DATABASE ' + quote((await admin.query('SELECT current_database() AS name')).rows[0].name) + ' FROM PUBLIC');
    await admin.query('CREATE ROLE ' + quote(owner) + ' NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION'); createdRoles.push(owner);
    const source = (await admin.query('SELECT s.system_identifier::text AS system_id,c.timeline_id::integer AS timeline,current_database() AS database FROM pg_catalog.pg_control_system() s CROSS JOIN pg_catalog.pg_control_checkpoint() c')).rows[0];
    selected = native.create({namespace: ns.source, lifecycleNamespace: ns.control, consumer: 'evaluator-native-scope', source: {...source, slot: 'native_scope_fixture'}, generation: 'native-scope-v1'});
    await own(ns.clock, require('../migrations/candidates/postgres-write-clock-v1.json'));
    await own(ns.rt, require('../migrations/candidates/postgres-realtime-output-v2.json'));
    await own(ns.source, require('../migrations/candidates/postgres-evaluator-work-v2.json'));
    await own(ns.control, native.catalogue(selected));
    await admin.query('CREATE SCHEMA ' + quote(ns.unrelated)); createdSchemas.push(ns.unrelated);
    await admin.query('CREATE TABLE ' + table('unrelated', 'private_rows') + '(tenant_id uuid, value text)');
    const urls = {};
    for (const name of [role, lifetime]) {
      const password = crypto.randomBytes(24).toString('hex');
      await admin.query('CREATE ROLE ' + quote(name) + " LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION PASSWORD '" + password + "'"); createdRoles.push(name);
      const uri = new URL(process.env.NS_TEST_POSTGRES_ADMIN_URI); uri.username = name; uri.password = password; urls[name] = uri.toString();
      await admin.query('GRANT USAGE ON SCHEMA ' + Object.values(ns).map(quote).join(',') + ' TO ' + quote(name));
    }
    for (const sql of require('../lib/server/ordinary-deployment-grants').lifetimeGrants({namespaces: {control: ns.control}, roles: {reader: role, lifetime_reader: lifetime}}, ['reader', 'lifetime_reader'])) await admin.query(sql);
    for (const name of [role, lifetime]) {
      for (const sql of native.servingGrants({namespace: ns.control, role: name})) await admin.query(sql);
      for (const sql of native.grants({namespace: ns.control, role: name})) await admin.query(sql);
    }
    await admin.query('GRANT SELECT ON ' + [table('clock', 'schema_migrations'), table('clock', 'tenant_write_clock'), table('rt', 'schema_migrations'), table('rt', 'tenant_consumer_checkpoint'), table('source', 'tenant_consumer_checkpoint')].join(',') + ' TO ' + quote(role));
    await admin.query('GRANT UPDATE(' + columns.map(quote).join(',') + ') ON ' + table('rt', 'tenant_consumer_checkpoint') + ' TO ' + quote(role));
    pool = new Pool({connectionString: urls[lifetime], max: 1});
    window = windows.create({namespace: ns.control, locks: [{tenant: A, key: '830009'}], pool, intakeProfile: selected});
    await window.ready();
    reader = new Client({connectionString: urls[role]}); await reader.connect();
  });
  after(async function () {
    await reader?.end(); await window?.close(); await pool?.end();
    if (admin) {
      try {
        for (const namespace of [...createdSchemas].reverse()) await admin.query('DROP SCHEMA IF EXISTS ' + quote(namespace) + ' CASCADE');
        for (const name of [...createdRoles].reverse()) { await admin.query('DROP OWNED BY ' + quote(name)); await admin.query('DROP ROLE ' + quote(name)); }
      } finally { await admin.end(); }
    }
  });
  it('admits only the genuine native window and its restricted recommission reads', async function () {
    await check();
    const allowed = await controlReads(reader, window);
    assert.deepEqual(allowed, ['schema_migrations', 'tenant_lifecycle_windows', 'tenant_lifecycle_operations', 'tenant_lifecycle_recommission'].map(name => ns.control + '.' + name));
    await assert.rejects(controlReads(reader, {namespace: ns.control}), /actual operation window required/);
    const unselectedPool = new Pool({connectionString: pool.options.connectionString, max: 1});
    const unselected = windows.create({namespace: ns.control, locks: [{tenant: A, key: '830009'}], pool: unselectedPool});
    try { await assert.rejects(controlReads(reader, unselected), {code: 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE'}); }
    finally { await unselected.close(); await unselectedPool.end(); }
    const closedPool = new Pool({connectionString: pool.options.connectionString, max: 1});
    const closed = windows.create({namespace: ns.control, locks: [{tenant: A, key: '830009'}], pool: closedPool, intakeProfile: selected});
    await closed.close(); await closedPool.end();
    await assert.rejects(controlReads(reader, closed), /actual operation window required/);
    await assert.rejects(readiness.screen(reader, config), /unsafe evaluator scope/);
    await assert.rejects(reader.query('SELECT claim_id FROM ' + table('control', 'tenant_lifecycle_recommission')), {code: '42501'});
  });
  it('refuses extra recommission column SELECT after the same backend was admitted', async function () {
    await rejectedGrant('GRANT SELECT(claim_id) ON ' + table('control', 'tenant_lifecycle_recommission') + ' TO ' + quote(role), 'REVOKE SELECT(claim_id) ON ' + table('control', 'tenant_lifecycle_recommission') + ' FROM ' + quote(role), {code: 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE'});
  });
  it('refuses unrelated column reads, writes, CREATE and unsafe role membership', async function () {
    await rejectedGrant('GRANT SELECT(value) ON ' + table('unrelated', 'private_rows') + ' TO ' + quote(role), 'REVOKE SELECT(value) ON ' + table('unrelated', 'private_rows') + ' FROM ' + quote(role), /unsafe evaluator scope/);
    await rejectedGrant('GRANT UPDATE(activated) ON ' + table('control', 'tenant_lifecycle_recommission') + ' TO ' + quote(role), 'REVOKE UPDATE(activated) ON ' + table('control', 'tenant_lifecycle_recommission') + ' FROM ' + quote(role), {code: 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE'});
    await rejectedGrant('GRANT CREATE ON SCHEMA ' + quote(ns.unrelated) + ' TO ' + quote(role), 'REVOKE CREATE ON SCHEMA ' + quote(ns.unrelated) + ' FROM ' + quote(role), {code: 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE'});
    await rejectedGrant('GRANT pg_signal_backend TO ' + quote(role), 'REVOKE pg_signal_backend FROM ' + quote(role), /unsafe evaluator identity/);
  });
  it('refuses missing required recommission SELECT and a malformed selected catalogue', async function () {
    await check();
    await admin.query('REVOKE SELECT(activated) ON ' + table('control', 'tenant_lifecycle_recommission') + ' FROM ' + quote(role));
    try { await assert.rejects(check(), {code: 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE'}); }
    finally { await admin.query('GRANT SELECT(activated) ON ' + table('control', 'tenant_lifecycle_recommission') + ' TO ' + quote(role)); }
    await check();
    await admin.query('ALTER TABLE ' + table('control', 'tenant_lifecycle_recommission') + ' ALTER COLUMN activated SET DEFAULT true');
    try { await assert.rejects(check(), {code: 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE'}); }
    finally { await admin.query('ALTER TABLE ' + table('control', 'tenant_lifecycle_recommission') + ' ALTER COLUMN activated SET DEFAULT false'); }
    await check();
  });

});
