'use strict';
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { Client } = require('pg');
const { optInSuite } = require('./support/opt-in');
const owner = require('../lib/realtime-placement/owner');
const connect = require('../lib/storage/postgres-connection');
optInSuite(!!process.env.NS_TEST_POSTGRES_ADMIN_URI, 'disposable PostgreSQL owner admission')('actual realtime worker resource', function () {
  this.timeout(30000);
  it('SHARD_DUPLICATE: actual session excludes a duplicate worker across incarnations; loss revokes and another worker remains independent', async function () {
    const admin = new Client({ connectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI });
    const tag = randomBytes(8).toString('hex'), role = 'rt_owner_' + tag, password = randomBytes(24).toString('hex');
    let a, b, held, other, restored, losses = 0;
    await admin.connect();
    try {
      await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
      const url = new URL(process.env.NS_TEST_POSTGRES_ADMIN_URI); url.username = role; url.password = password;
      const options = { connectionString: url.toString(), max: 2, connectionTimeoutMillis: 500, query_timeout: 500, statement_timeout: 500 };
      a = await connect(options); b = await connect(options);
      held = await owner.acquire({ connection: a, worker: 'a', consumer: 'realtime-stable', onLoss: () => { losses++; } });
      await held.check();
      await assert.rejects(owner.acquire({ connection: b, worker: 'a', consumer: 'realtime-stable' }), { code: 'POSTGRES_OPERATIONAL_OWNER_CONFLICT' });
      other = await owner.acquire({ connection: b, worker: 'b', consumer: 'realtime-stable' }); await other.check();
      const locks = (await admin.query("SELECT l.pid FROM pg_locks l JOIN pg_stat_activity a USING(pid) WHERE a.usename=$1 AND l.locktype='advisory' AND l.granted ORDER BY l.pid", [role])).rows;
      assert.equal(locks.length, 2, 'SHARD_DUPLICATE independently observed exclusive resources');
      // Locate A by its lower observed backend PID; A connected before B. Kill
      // that actual backend, then verify resource loss before serving again.
      await admin.query('SELECT pg_terminate_backend($1)', [locks[0].pid]);
      for (let n = 0; n < 100 && !losses; n++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.ok(losses > 0, 'loss reaches actual role shutdown callback');
      await assert.rejects(held.check(), { code: 'POSTGRES_OPERATIONAL_OWNER_LOST' });
      await other.check(); await held.close();
      restored = await owner.acquire({ connection: b, worker: 'a', consumer: 'realtime-stable' }); await restored.check();
      // Resource availability alone does not authorize a placement move. The
      // separate map still requires platform-confirmed old-owner termination.
    } finally {
      for (const resource of [held, other, restored]) await resource?.close().catch(() => {});
      await Promise.allSettled([a?.end(), b?.end()]);
      await admin.query(`DROP ROLE IF EXISTS "${role}"`); await admin.end();
    }
  });
});
