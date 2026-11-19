'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { optInSuite } = require('./support/opt-in');
const { run } = require('../lib/migrations/postgres');
const readiness = require('../lib/server/serve/evaluator-readiness');
const lifecycleCheck = require('../lib/server/serve/platform-verification-lifecycle');
const native = require('../lib/tenant-lifecycle/native-selection');
const adminCheck = require('../lib/server/serve/platform-verification-admin');
const columns = require('../lib/pgstream/realtime-receipt').COLUMNS;
const quote = name => '"' + name + '"';

optInSuite(process.env.NS_PGSTREAM_ROLE_TEST === '1' && !!process.env.NS_TEST_POSTGRES_ADMIN_URI,
  'NS_PGSTREAM_ROLE_TEST=1 with disposable NS_TEST_POSTGRES_ADMIN_URI')('native platform pre-start catalogue checks', function () {
  this.timeout(30000);
  const prefix = 'native_scope_' + crypto.randomBytes(5).toString('hex');
  const ns = Object.fromEntries(['clock', 'rt', 'source', 'control', 'unrelated'].map(kind => [kind, prefix + '_' + kind]));
  const owner = prefix + '_owner', role = prefix + '_reader', lifetime = prefix + '_lifetime';
  const config = { namespaces: {clock: ns.clock, checkpoint: ns.rt}, completedOutput: {namespace: ns.source} };
  const table = (kind, name) => quote(ns[kind]) + '.' + quote(name);
  let admin, reader, lifecycle, selected, operationConfig, previousTenancyMode;
  const consumerURIs = {}, consumerRoles = {outbox: prefix + '_outbox', alarm: prefix + '_alarm'};
  const consumerNamespaces = {outbox: prefix + '_outbox', alarm: prefix + '_alarm'};
  const createdSchemas = [], createdRoles = [], createdDatabases = [];
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
  async function check() { await readiness.screen(reader, config, {lifecycle}); }
  async function rejectedGrant(grant, revoke, pattern) {
    await check();
    await admin.query(grant);
    try { await assert.rejects(check(), pattern); }
    finally { await admin.query(revoke); }
    await check();
  }
  before(async function () {
    const tenancy = require('../lib/storage/tenant-scope'); previousTenancyMode = tenancy.getTenancyMode(); tenancy.setTenancyMode('multi');
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
    for (const [kind, catalogue] of [['outbox', require('../lib/tenant-notifications/postgres-candidate.json')], ['alarm', require('../migrations/candidates/postgres-alarm-suppression-v1.json')]]) {
      const name = consumerRoles[kind], namespace = consumerNamespaces[kind], password = crypto.randomBytes(24).toString('hex');
      await own(namespace, catalogue);
      await admin.query('CREATE ROLE ' + quote(name) + " LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION PASSWORD '" + password + "'"); createdRoles.push(name);
      const uri = new URL(process.env.NS_TEST_POSTGRES_ADMIN_URI); uri.username = name; uri.password = password; consumerURIs[kind] = uri.toString();
      await admin.query('GRANT USAGE ON SCHEMA ' + quote(namespace) + ' TO ' + quote(name));
      for (const sql of require('../lib/server/ordinary-deployment-grants').lifetimeGrants({namespaces: {control: ns.control}, roles: {reader: name}}, ['reader'])) await admin.query(sql);
      for (const sql of native.servingGrants({namespace: ns.control, role: name})) await admin.query(sql);
      if (kind === 'outbox') {
        await admin.query('GRANT SELECT ON ' + quote(namespace) + '.schema_migrations TO ' + quote(name));
        await admin.query('GRANT SELECT,INSERT,UPDATE(request_id,blocked_until) ON ' + quote(namespace) + '.tenant_notification_heads TO ' + quote(name));
        await admin.query('GRANT SELECT,INSERT,UPDATE(state,next_at,attempt,attempt_token,attempt_until,accepted_at,receipt,cleared_at) ON ' + quote(namespace) + '.tenant_notification_requests TO ' + quote(name));
        await admin.query('GRANT SELECT,INSERT,UPDATE(revision,config_identity,producer) ON ' + quote(namespace) + '.tenant_notification_state TO ' + quote(name));
      } else await admin.query('GRANT SELECT ON ' + quote(namespace) + '.tenant_alarm_suppression,' + quote(namespace) + '.schema_migrations TO ' + quote(name));
    }
    // The deployment's due-discovery grants on the outbox (lib/server/ordinary-deployment-grants.js).
    for (const sql of require('../lib/server/ordinary-deployment-grants').notificationScheduleGrants({
      namespace: consumerNamespaces.outbox, owner, outboxRole: consumerRoles.outbox, ackRole: consumerRoles.alarm })) await admin.query(sql);
    operationConfig = {namespace: ns.control, poolOptions: {connectionString: urls[lifetime]}, nativeSelection: selected};
    lifecycle = await lifecycleCheck.inspect(operationConfig);
    reader = new Client({connectionString: urls[role]});
    await reader.connect();
    config.connectionString = urls[role];
    config.consumers = { realtime: {
      outbox: {namespace: consumerNamespaces.outbox, connectionString: consumerURIs.outbox},
      suppression: {namespace: consumerNamespaces.alarm, connectionString: consumerURIs.alarm}
    } };
  });
  after(async function () {
    await reader?.end();
    if (previousTenancyMode !== undefined) require('../lib/storage/tenant-scope').setTenancyMode(previousTenancyMode);
    if (admin) {
      try {
        for (const database of createdDatabases) await admin.query('DROP DATABASE ' + quote(database));
        for (const namespace of [...createdSchemas].reverse()) await admin.query('DROP SCHEMA IF EXISTS ' + quote(namespace) + ' CASCADE');
        for (const name of [...createdRoles].reverse()) { await admin.query('DROP OWNED BY ' + quote(name)); await admin.query('DROP ROLE ' + quote(name)); }
      } finally { await admin.end(); }
    }
  });
  it('checks the selected lifecycle catalogue and admits its restricted recommission reads', async function () {
    await check();
    const allowed = await lifecycle.controlReads(reader);
    assert.deepEqual(allowed, ['schema_migrations', 'tenant_lifecycle_windows', 'tenant_lifecycle_operations', 'tenant_lifecycle_recommission'].map(name => ns.control + '.' + name));
    await assert.rejects(lifecycleCheck.inspect({...operationConfig, nativeSelection: undefined}), {code: 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE'});
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

  async function operational() {
    return adminCheck.checkTarget({role: 'evaluator', config, operationConfig});
  }
  function refused(causeCode) {
    return error => error.verificationDiagnostic?.targetRole === 'evaluator' &&
      error.verificationDiagnostic.checkPhase === 'CONSUMER_READINESS' && error.verificationDiagnostic.causeCode === causeCode;
  }
  it('refuses a suppression port in another database before issuing a proof', async function () {
    await operational();
    const foreignDatabase = prefix + '_foreign';
    await admin.query('CREATE DATABASE ' + quote(foreignDatabase)); createdDatabases.push(foreignDatabase);
    const binding = config.consumers.realtime.suppression;
    const foreign = new URL(binding.connectionString); foreign.pathname = '/' + foreignDatabase;
    config.consumers.realtime.suppression = {...binding, connectionString: foreign.toString()};
    try { await assert.rejects(operational(), refused('EVALUATOR_CONSUMER_READINESS_REFUSED')); }
    finally { config.consumers.realtime.suppression = binding; }
    await operational();
  });
  it('refuses suppression catalogue drift and excess grants at admin pre-start, then passes after repair', async function () {
    await operational();
    const alarmTable = quote(consumerNamespaces.alarm) + '.tenant_alarm_suppression';
    await admin.query('REVOKE SELECT ON ' + alarmTable + ' FROM ' + quote(consumerRoles.alarm));
    try { await assert.rejects(operational(), refused('EVALUATOR_CONSUMER_READINESS_REFUSED')); }
    finally { await admin.query('GRANT SELECT ON ' + alarmTable + ' TO ' + quote(consumerRoles.alarm)); }
    await operational();
    await admin.query('GRANT SELECT(value) ON ' + table('unrelated', 'private_rows') + ' TO ' + quote(consumerRoles.alarm));
    try { await assert.rejects(operational(), refused('EVALUATOR_CONSUMER_READINESS_REFUSED')); }
    finally { await admin.query('REVOKE SELECT(value) ON ' + table('unrelated', 'private_rows') + ' FROM ' + quote(consumerRoles.alarm)); }
    await operational();
    await admin.query('GRANT SELECT(claim_id) ON ' + table('control', 'tenant_lifecycle_recommission') + ' TO ' + quote(consumerRoles.alarm));
    try { await assert.rejects(operational(), refused('LIFECYCLE_WINDOW_SCHEMA_UNSAFE')); }
    finally { await admin.query('REVOKE SELECT(claim_id) ON ' + table('control', 'tenant_lifecycle_recommission') + ' FROM ' + quote(consumerRoles.alarm)); }
    await operational();
  });
  it('refuses an unreadable outbox at admin pre-start', async function () {
    const heads = quote(consumerNamespaces.outbox) + '.tenant_notification_heads';
    await admin.query('REVOKE SELECT ON ' + heads + ' FROM ' + quote(consumerRoles.outbox));
    try { await assert.rejects(operational(), refused('NOTIFICATION_SCHEMA_UNSAFE')); }
    finally { await admin.query('GRANT SELECT ON ' + heads + ' TO ' + quote(consumerRoles.outbox)); }
    await operational();
  });
});
