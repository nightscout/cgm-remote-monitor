'use strict';

// Native fixture only; consumes an externally supplied disposable PG instance.
// No Docker, default environment URL, listener or provider is started here.
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const connect = require('../../lib/storage/postgres-connection');
const { run } = require('../../lib/migrations/postgres');
const { createReceiver, createCycle } = require('../../lib/tenant-alarms/composition');
const { createReader } = require('../../lib/tenant-alarms/postgres');
const { createForwarder } = require('../../lib/server/tenant-socket-forwarding');
const scope = require('../../lib/storage/tenant-scope');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
module.exports = function alarmLab () {
  const name = 'alarm_test_' + crypto.randomBytes(8).toString('hex'), namespace = name + '_state';
  const roles = { writer: name + '_writer', reader: name + '_reader', realtime: name + '_realtime' };
  const table = '"' + namespace + '".tenant_alarm_suppression';
  const clients = []; let admin, mode;
  const lab = { A, B, namespace, roles, table, commits: [],
    async open () {
      const uri = process.env.NS_TEST_POSTGRES_ADMIN_URI, parsed = new URL(uri);
      assert.match(parsed.pathname, /test/i, 'Native fixture requires explicitly disposable test database');
      mode = scope.getTenancyMode(); scope.setTenancyMode('multi');
      admin = lab.admin = new Client({ connectionString: uri }); await admin.connect();
      await run('up', { direct: true, connectionString: uri, namespace,
        catalogue: require('../../migrations/candidates/postgres-alarm-suppression-v1.json') });
      await admin.query(`CREATE TABLE "${namespace}".fixture_authority (tenant_id uuid NOT NULL, credential text NOT NULL, active boolean NOT NULL, PRIMARY KEY(tenant_id,credential))`);
      await admin.query(`INSERT INTO "${namespace}".fixture_authority VALUES($1,'owner-a',true),($1,'owner-a2',true),($2,'owner-b',true)`, [A, B]);
      for (const [kind, role] of Object.entries(roles)) {
        const password = crypto.randomBytes(24).toString('hex');
        await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
        await admin.query(`GRANT USAGE ON SCHEMA "${namespace}" TO "${role}"`);
        if (kind === 'writer') {
          await admin.query(`GRANT SELECT,INSERT,UPDATE(acked_at,expires_at) ON ${table} TO "${role}"`);
          await admin.query(`GRANT SELECT ON "${namespace}".fixture_authority TO "${role}"`);
        } else if (kind === 'reader') await admin.query(`GRANT SELECT ON ${table} TO "${role}"`);
        const url = new URL(uri); url.username = role; url.password = password;
        const connection = await connect({ connectionString: url.toString(), max: 2, statement_timeout: 10000 });
        clients.push(connection); lab[kind] = connection;
      }
      lab.suppressionReader = createReader({ connection: lab.reader, namespace, maxRows: 100, maxBytes: 100000 });
    },
    async reset () {
      lab.commits.length = 0;
      await admin.query(`DELETE FROM ${table}`);
      await admin.query(`UPDATE "${namespace}".fixture_authority SET active=true`);
    },
    async physical (tenant = A) {
      return (await admin.query(`SELECT tenant_id,alarm_group,alarm_level,acked_at,expires_at FROM ${table} WHERE tenant_id=$1 ORDER BY alarm_group COLLATE "C",alarm_level`, [tenant])).rows;
    },
    async active (tenant, credential) {
      return (await admin.query(`SELECT active FROM "${namespace}".fixture_authority WHERE tenant_id=$1 AND credential=$2`, [tenant, credential?.id])).rows[0]?.active === true;
    },
    async waitForWriterLock () {
      const until = Date.now() + 5000;
      while (Date.now() < until) {
        const rows = (await admin.query("SELECT pid,wait_event_type FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock'", [roles.writer])).rows;
        if (rows.length) return rows;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error('ALARM_NATIVE_CONCURRENT_LOCK_NOT_OBSERVED');
    },
    receiver ({ connection = lab.writer, afterOuterAdmission, afterUpdate, failCommit = false, beforeCommit } = {}) {
      const db = { ...connection,
        async query (text, values) {
          const result = await connection.query(text, values);
          if (text.startsWith('INSERT') && afterUpdate) await afterUpdate(result);
          return result;
        },
        async transaction (fn) {
          let xid;
          try {
            const result = await connection.transaction(async () => {
              xid = (await connection.query('SELECT pg_current_xact_id()::text AS xid')).rows[0].xid;
              const value = await fn();
              if (beforeCommit) await beforeCommit();
              if (failCommit) throw new Error('SYNTHETIC_ACK_TRANSACTION_FAILURE');
              return value;
            });
            const status = (await admin.query('SELECT pg_xact_status($1::xid8) AS status', [xid])).rows[0].status;
            lab.commits.push({ xid, status });
            return result;
          } catch (error) {
            if (xid) lab.commits.push({ xid, status: (await admin.query('SELECT pg_xact_status($1::xid8) AS status', [xid])).rows[0].status });
            throw error;
          }
        } };

      return createReceiver({ connection: db, namespace,
        authenticateTransport: async request => request.syntheticTrustedTransport === true,
        resolveTenant: async request => request.tenant,
        async authorizeSocket (operation) {
          if (!await lab.active(operation.tenant, operation.credential)) return null;
          if (afterOuterAdmission) await afterOuterAdmission(operation);
          return { tenant: operation.tenant, subject: operation.credential.id };
        },
        async authorizeAckInTransaction ({ connection: tx, tenant, credential }) {
          // One current fixture authority query inside the actual write boundary;
          // not a production token verifier or a claimed deployment adapter.
          const answer = await tx.query(`SELECT active FROM "${namespace}".fixture_authority WHERE tenant_id=$1 AND credential=$2`, [tenant, credential.id]);
          return answer.rows[0]?.active === true;
        },
        executeWrite: async () => { throw new Error('Alarm fixture does not admit DATA writes'); }
      });
    },
    forwarder ({ tenant = A, credential = { id: 'owner-a' }, receiver = lab.receiver(), admitted = true } = {}) {
      return createForwarder({ contextForSocket: async () => ({ tenant, credential }),
        transport: envelope => receiver({ tenant, syntheticTrustedTransport: admitted }, envelope) });
    },
    cycle (current, isCurrent = async () => true) {
      return createCycle({ connection: lab.reader, namespace, maxRows: 100, maxBytes: 100000, current, isCurrent });
    },
    async close () {
      try {
        await Promise.all(clients.map(client => client.end()));
        if (admin) {
          await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
          for (const role of Object.values(roles)) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
        }
      } finally { if (admin) await admin.end(); if (mode) scope.setTenancyMode(mode); }
    }
  };
  return lab;
};
