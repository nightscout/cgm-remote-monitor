'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { run } = require('../../lib/migrations/postgres');
const connect = require('../../lib/storage/postgres-connection');
const decorate = require('../../lib/storage/postgres-write-clock');
const scope = require('../../lib/storage/tenant-scope');

module.exports = function clockPortLab () {
  const name = 'clock_test_' + crypto.randomBytes(8).toString('hex');
  const role = name + '_app';
  const domains = ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity', 'settings'];
  const namespaces = { ...Object.fromEntries(domains.map(domain => [domain, name + '_' + domain])), clock: name + '_clock' };
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  const raw = [], clocks = [];
  let admin, mode, roleCreated = false;
  const ownedSchemas = new Set();
  const lab = { name, role, namespaces, domains, A, B, raw, clocks,
    table: namespaces.entries + '.entries',
    async open () {
      mode = scope.getTenancyMode();
      scope.setTenancyMode('multi');
      const connectionString = process.env.NS_TEST_POSTGRES_ADMIN_URI;
      const url = new URL(connectionString);
      assert.match(url.pathname, /test/i, 'A disposable test database must be explicitly selected');
      admin = lab.admin = new Client({ connectionString });
      await admin.connect();
      lab.version = (await admin.query('SELECT version() AS version')).rows[0].version;
      const password = crypto.randomBytes(24).toString('hex');
      await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
      roleCreated = true;
      for (const [kind, catalogue] of Object.entries({
        ...Object.fromEntries(domains.map(domain => [domain,
          require('../../lib/server/serve/postgres-domains').get(domain).catalogue])),
        clock: require('../../migrations/candidates/postgres-write-clock-v1.json')
      })) {
        await admin.query('CREATE SCHEMA "' + namespaces[kind] + '"');
        ownedSchemas.add(namespaces[kind]);
        await run('up', { direct: true, connectionString, namespace: namespaces[kind], catalogue });
        await admin.query(`GRANT USAGE ON SCHEMA "${namespaces[kind]}" TO "${role}"`);
      }
      for (const domain of domains) {
        await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON "${namespaces[domain]}"."${domain}" TO "${role}"`);
      }
      await admin.query(`GRANT SELECT,UPDATE(last_stamp) ON "${namespaces.clock}".tenant_write_clock TO "${role}"`);
      url.username = role;
      url.password = password;
      for (let i = 0; i < 2; i++) {
        const connection = await connect({ connectionString: url.toString(), max: 4,
          application_name: name + '_' + i, statement_timeout: 10000, connectionTimeoutMillis: 5000 });
        raw.push(connection);
        clocks.push(decorate(connection, namespaces.clock));
      }
      await lab.reset();
    },
    async reset () {
      for (const domain of domains) await admin.query(`TRUNCATE "${namespaces[domain]}"."${domain}"`);
      await admin.query(`DELETE FROM "${namespaces.clock}".tenant_write_clock`);
      lab.initial = Date.now() + 100000;
      await admin.query(`INSERT INTO "${namespaces.clock}".tenant_write_clock VALUES ($1,$3),($2,$3)`, [A, B, lab.initial]);
    },
    async floor (tenant) {
      return Number((await admin.query(`SELECT last_stamp FROM "${namespaces.clock}".tenant_write_clock WHERE tenant_id=$1`, [tenant])).rows[0].last_stamp);
    },
    async rows (tenant = A, after = -1) {
      return (await admin.query(`SELECT doc FROM "${namespaces.entries}".entries WHERE tenant_id=$1 AND "srvModified">$2 ORDER BY "srvModified","_id"`,
        [tenant, after])).rows.map(row => row.doc);
    },
    async waitForClockLock () {
      const deadline = Date.now() + 5000;
      do {
        const state = await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE application_name LIKE $1 AND wait_event_type='Lock' AND query LIKE '%tenant_write_clock%FOR UPDATE%'`, [name + '_%']);
        if (state.rows[0].n > 0) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      } while (Date.now() < deadline);
      throw new Error('No actual PostgreSQL clock-row lock wait was observed');
    },
    async close () {
      const errors = [], attempt = async fn => {try {await fn();} catch(error) {errors.push(error);}};
      for (const connection of raw) await attempt(() => connection.end());
      if (admin) {
        for (const namespace of [...ownedSchemas]) await attempt(async () => {
          await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`); ownedSchemas.delete(namespace);
        });
        if (roleCreated) await attempt(async () => {await admin.query(`DROP ROLE IF EXISTS "${role}"`); roleCreated = false;});
        await attempt(() => admin.end());
      }
      if (mode) scope.setTenancyMode(mode);
      if (errors.length) throw new globalThis.AggregateError(errors, 'Clock fixture owned cleanup refused');
    }
  };
  return lab;
};
