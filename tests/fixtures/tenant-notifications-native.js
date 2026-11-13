'use strict';

const { randomBytes, randomUUID } = require('node:crypto');
const { Client } = require('pg');
const scope = require('../../lib/storage/tenant-scope');
const connect = require('../../lib/storage/postgres-connection');
const { run } = require('../../lib/migrations/postgres');
const createStore = require('../../lib/tenant-notifications/postgres');
const createComponent = require('../../lib/tenant-notifications/component');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const notification = () => ({ title: 'Synthetic native alarm', message: 'Synthetic native details', level: 1, group: 'default', plugin: { name: 'synthetic' } });
module.exports = function nativeLab () {
  const name = 'notification_test_' + randomUUID().replace(/-/g, '').slice(0, 16);
  const lab = { A, B, name, role: name + '_worker', current: null, now: 2000000, components: [] };
  lab.cycle = (emitted = [notification()], tenant = A, identity = 'native-config') => {
    lab.current = { tenant, identity, runtimeId: 'native-runtime', outputRevision: (lab.current?.outputRevision || 0) + 1,
      inputCheckpoint: 0, eligible: true, result: { tenant, now: lab.now, emitted, requested: [] } };
    return lab.current;
  };
  lab.open = async () => {
    const uri = process.env.NS_TEST_POSTGRES_ADMIN_URI;
    if (!uri || !/test/i.test(new URL(uri).pathname)) throw new Error('Disposable test PostgreSQL required');
    lab.mode = scope.getTenancyMode(); scope.setTenancyMode('multi');
    lab.admin = new Client({ connectionString: uri }); await lab.admin.connect();
    await run('up', { direct: true, connectionString: uri, namespace: name,
      catalogue: require('../../lib/tenant-notifications/postgres-candidate.json') });
    const password = randomBytes(24).toString('hex');
    await lab.admin.query(`CREATE ROLE "${lab.role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
    await lab.admin.query(`GRANT SELECT ON "${name}".schema_migrations TO "${lab.role}"`);
    await lab.admin.query(`GRANT USAGE ON SCHEMA "${name}" TO "${lab.role}"`);
    await lab.admin.query(`GRANT SELECT,INSERT,UPDATE(request_id,blocked_until) ON "${name}".tenant_notification_heads TO "${lab.role}"`);
    await lab.admin.query(`GRANT SELECT,INSERT,UPDATE(state,next_at,attempt,attempt_token,attempt_until,accepted_at,receipt,cleared_at) ON "${name}".tenant_notification_requests TO "${lab.role}"`);
    await lab.admin.query(`GRANT SELECT,INSERT,UPDATE(revision,config_identity,producer) ON "${name}".tenant_notification_state TO "${lab.role}"`);
    await lab.admin.query(`CREATE TABLE "${name}".forbidden_clinical (tenant_id uuid, value text)`);
    const url = new URL(uri); url.username = lab.role; url.password = password;
    lab.childConfig = { connectionString: url.toString(), namespace: name, tenant: A, at: lab.now };
    lab.connection = await connect({ connectionString: url.toString(), max: 2, statement_timeout: 5000 });
    lab.now = Number((await lab.admin.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now')).rows[0].now);
    lab.childConfig.at = lab.now;
    lab.store = createStore({ connection: lab.connection, namespace: name, maxRows: 10, maxBytes: 65536 });
  };
  lab.component = overrides => {
    const value = createComponent({ store: lab.store, adapter: { id: 'synthetic', send (row, callback) { callback(null, { accepted: true }); } },
      selectCycle: async () => lab.current, isCurrent: async (tenant, identity) => lab.current?.tenant === tenant && lab.current.identity === identity,
      allows: async () => !lab.suppressed, now: () => lab.now, normalPolicy: 'pushnotify', maxRows: 10, maxPayloadBytes: 10000, maxInflight: 1,
      attemptTimeoutMs: 1000, retryDelayMs: 1, ...overrides });
    lab.components.push(value); return value;
  };
  lab.rows = async (tenant = A) => (await lab.admin.query(`SELECT * FROM "${name}".tenant_notification_requests WHERE tenant_id=$1 ORDER BY created_at,request_id`, [tenant])).rows;
  lab.heads = async (tenant = A) => (await lab.admin.query(`SELECT * FROM "${name}".tenant_notification_heads WHERE tenant_id=$1 ORDER BY consumer,dedup_key`, [tenant])).rows;
  lab.trace = (phase, value) => { console.log('TENANT_NOTIFICATION_OBSERVATION ' + JSON.stringify({ phase, ...value })); return value; };
  lab.reset = async () => {
    await Promise.all(lab.components.map(value => value.close())); lab.components = [];
    await lab.admin.query(`TRUNCATE "${name}".tenant_notification_requests,"${name}".tenant_notification_heads,"${name}".tenant_notification_state`);
    lab.now = Number((await lab.admin.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now')).rows[0].now);
    lab.childConfig.at = lab.now; lab.suppressed = false; lab.current = null;
  };
  lab.close = async () => {
    try {
      await Promise.all(lab.components.map(value => value.close()));
      if (lab.connection) await lab.connection.end();
      if (lab.admin) {
        await lab.admin.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
        const exists = await lab.admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [lab.role]);
        if (exists.rows.length) { await lab.admin.query(`DROP OWNED BY "${lab.role}"`); await lab.admin.query(`DROP ROLE "${lab.role}"`); }
      }
    } finally { if (lab.admin) await lab.admin.end(); if (lab.mode) scope.setTenancyMode(lab.mode); }
  };
  return lab;
};
module.exports.notification = notification;
