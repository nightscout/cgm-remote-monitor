'use strict';

const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { Client } = require('pg');
const connect = require('../lib/storage/postgres-connection');
const scope = require('../lib/storage/tenant-scope');

const uri = process.env.NS_TEST_POSTGRES_ADMIN_URI;
const suite = uri ? describe : describe.skip;
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

suite('PostgreSQL transaction foundation (requires NS_TEST_POSTGRES_ADMIN_URI)', function () {
  this.timeout(15000);
  const name = 'ns_rls_' + randomUUID().replace(/-/g, '');
  const role = name + '_app';
  let admin, store, appURI, mode;
  const table = '"' + name + '".entries';
  const released = [];

  class ObservedClient extends Client {
    async query (...args) {
      const result = await super.query(...args);
      if (args[0] === 'COMMIT' || args[0] === 'ROLLBACK') {
        const probe = await super.query(
          "SELECT pg_backend_pid() AS pid, NULLIF(current_setting('app.current_tenant_id', true), '') AS tenant");
        released.push(probe.rows[0]);
      }
      return result;
    }
  }

  before(async function () {
    mode = scope.getTenancyMode();
    scope.setTenancyMode('multi');
    admin = new Client({ connectionString: uri });
    await admin.connect();
    const password = randomBytes(24).toString('hex');
    await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
    await admin.query(`CREATE SCHEMA "${name}"`);
    await admin.query(`CREATE TABLE ${table} (
      tenant_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid,
      doc jsonb NOT NULL,
      "_id" text GENERATED ALWAYS AS (doc ->> '_id') STORED NOT NULL,
      PRIMARY KEY (tenant_id, "_id")
    )`);
    await admin.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    await admin.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    await admin.query(`CREATE POLICY tenant ON ${table} USING
      (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)`);
    await admin.query(`GRANT USAGE ON SCHEMA "${name}" TO "${role}"`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO "${role}"`);
    const url = new URL(uri);
    url.username = role;
    url.password = password;
    appURI = url.toString();
    store = await connect({ connectionString: appURI, max: 1, Client: ObservedClient });
  });

  beforeEach(async function () {
    await admin.query(`TRUNCATE ${table}`);
    released.length = 0;
    for (const tenant of [A, B]) {
      await store.withTenant(tenant, () => store.query(
        `INSERT INTO ${table} (doc) VALUES ($1)`,
        [{ _id: 'same-id', identifier: 'same-identifier', sgv: tenant === A ? 100 : 200 }]));
    }
  });

  after(async function () {
    try {
      if (store) await store.end();
      if (admin) {
        try {
          await admin.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
          await admin.query(`DROP ROLE IF EXISTS "${role}"`);
        } finally {
          await admin.end();
        }
      }
    } finally {
      if (mode !== undefined) scope.setTenancyMode(mode);
    }
  });

  async function unbound () {
    const client = new Client({ connectionString: appURI });
    await client.connect();
    try {
      return await client.query(`SELECT doc FROM ${table}`);
    } finally {
      await client.end();
    }
  }

  it('isolates overlapping identities for reads, updates and deletes', async function () {
    const read = tenant => store.withTenant(tenant, () => store.query(`SELECT doc FROM ${table}`));
    assert.deepEqual((await read(A)).rows.map(x => x.doc.sgv), [100]);
    assert.deepEqual((await read(B)).rows.map(x => x.doc.sgv), [200]);
    await store.withTenant(A, async function () {
      assert.equal((await store.query(`UPDATE ${table} SET doc = doc || '{"sgv":101}'`)).rowCount, 1);
      assert.equal((await store.query(`DELETE FROM ${table} WHERE doc ->> '_id' = 'same-id'`)).rowCount, 1);
    });
    assert.equal((await read(A)).rowCount, 0);
    assert.deepEqual((await read(B)).rows.map(x => x.doc.sgv), [200]);
  });

  it('refuses unbound application calls; raw unbound reads see no rows', async function () {
    assert.throws(() => store.query(`SELECT doc FROM ${table}`), /no tenant bound/);
    assert.equal((await unbound()).rowCount, 0);
  });

  it('checks inserted tenant IDs as well as visible rows', async function () {
    await assert.rejects(store.withTenant(A, () => store.query(
      `INSERT INTO ${table} (tenant_id, doc) VALUES ($1, $2)`,
      [B, { _id: 'forged' }])), /row-level security/);
    await assert.rejects(store.withTenant(A, () => store.query(
      `UPDATE ${table} SET tenant_id = $1`, [B])), /row-level security/);
    await assert.rejects(store.withTenant(A, () => store.query(`TRUNCATE ${table}`)), /permission denied/);
  });

  it('reuses one connection, clears bindings after commit and error, and rolls back writes', async function () {
    const pid = tenant => store.withTenant(tenant, async function () {
      const first = await store.query('SELECT pg_backend_pid() AS pid');
      const nested = await store.withTenant(tenant, () => store.query('SELECT pg_backend_pid() AS pid'));
      assert.equal(first.rows[0].pid, nested.rows[0].pid);
      return first.rows[0].pid;
    });
    const first = await pid(A);
    assert.equal(await pid(B), first);
    await assert.rejects(store.withTenant(A, async function () {
      await store.query(`INSERT INTO ${table} (doc) VALUES ($1)`, [{ _id: 'rolled-back' }]);
      await store.query('SELECT 1 / 0');
    }), /division by zero/);
    await scope.withTenant(A, async function () {
      assert.equal((await store.query(`SELECT doc FROM ${table} WHERE "_id" = 'rolled-back'`)).rowCount, 0);
    });
    assert.equal(await pid(B), first);
    assert.equal((await unbound()).rowCount, 0);
    assert.ok(released.length >= 5);
    assert.ok(released.every(probe => probe.pid === first && probe.tenant === null),
      'the same pooled connection must have no binding after each commit or rollback');
    await admin.query(`SET ROLE "${role}"`);
    try {
      assert.equal((await admin.query(`SELECT row_security_active('${table}') AS active`)).rows[0].active, true);
    } finally {
      await admin.query('RESET ROLE');
    }
  });

  it('rejects cross-tenant nesting, non-UUID bindings and privileged application roles', async function () {
    await assert.rejects(connect({}), /explicit connectionString/);
    await store.withTenant(A, async function () {
      assert.throws(() => store.withTenant(B, () => {}), /cannot rebind/);
    });
    assert.throws(() => store.withTenant('not-a-uuid', () => {}), /UUID tenant binding/);
    await assert.rejects(connect({ connectionString: uri }), /NOSUPERUSER NOBYPASSRLS/);
  });

  it('refuses async work retaining a transaction after its connection is released', async function () {
    let late;
    await store.withTenant(A, async function () {
      late = new Promise(resolve => {
        setTimeout(() => {
          assert.throws(() => store.query(`SELECT doc FROM ${table}`), /scope is closed/);
          resolve();
        }, 20);
      });
    });
    await late;
  });

  it('does not report success when a caller catches an error inside an aborted transaction', async function () {
    await assert.rejects(store.withTenant(A, async function () {
      await store.query(`INSERT INTO ${table} (doc) VALUES ($1)`, [{ _id: 'aborted' }]);
      await assert.rejects(store.query('SELECT 1 / 0'), /division by zero/);
      return 'not committed';
    }), /transaction was aborted/);
    const stored = await store.withTenant(A, () => store.query(
      `SELECT doc FROM ${table} WHERE "_id" = 'aborted'`));
    assert.equal(stored.rowCount, 0);
  });

  it('recovers statement failure at a savepoint without losing preceding writes, but outer rollback still wins', async function () {
    await store.withTenant(A, async function () {
      await store.query(`INSERT INTO ${table} (doc) VALUES ($1)`, [{ _id: 'prefix' }]);
      await assert.rejects(store.withSavepoint(async function () {
        await store.query(`INSERT INTO ${table} (doc) VALUES ($1)`, [{ _id: 'discarded' }]);
        await store.query('SELECT 1 / 0');
      }), /division by zero/);
      await store.query(`INSERT INTO ${table} (doc) VALUES ($1)`, [{ _id: 'suffix' }]);
    });
    await store.withTenant(A, async function () {
      assert.equal((await store.query(`SELECT doc FROM ${table} WHERE "_id" IN ('prefix', 'suffix')`)).rowCount, 2);
      assert.equal((await store.query(`SELECT doc FROM ${table} WHERE "_id" = 'discarded'`)).rowCount, 0);
      await assert.rejects(store.withSavepoint(() => store.withSavepoint(() => {})), /nested savepoint/);
    });
    await assert.rejects(store.withTenant(A, async function () {
      await store.withSavepoint(() => store.query(`DELETE FROM ${table}`));
      throw new Error('outer cancellation');
    }), /outer cancellation/);
    assert.equal((await store.withTenant(A, () => store.query(`SELECT doc FROM ${table}`))).rowCount, 3);
    await scope.withTenant(A, () => store.transaction(() => store.query('SELECT 1')));
    await assert.rejects(store.withTenant(A, () => store.transaction(() => {})), /new transaction/);
  });

  it('red control: removing the row policy exposes the other tenant', async function () {
    assert.equal((await unbound()).rowCount, 0);
    await admin.query(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`);
    try {
      assert.equal((await unbound()).rowCount, 2, 'fixture must contain visible rows from both tenants');
    } finally {
      await admin.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    }
    assert.equal((await unbound()).rowCount, 0);
  });

  it('red control: session-scoped binding leaks onto the next unbound transaction', async function () {
    const client = new Client({ connectionString: appURI });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_tenant_id', $1, false)", [B]);
      await client.query('COMMIT');
      assert.equal((await client.query(`SELECT doc FROM ${table}`)).rowCount, 1);
      await client.query("SELECT set_config('app.current_tenant_id', '', false)");
      assert.equal((await client.query(`SELECT doc FROM ${table}`)).rowCount, 0);
    } finally {
      await client.end();
    }
  });
});
