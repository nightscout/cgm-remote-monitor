'use strict';

// The identifier-array index operation (0098_<domain>_identifier_arrays,
// lib/storage/identifier-array-index-sql.js) on databases that already exist:
//   * a populated namespace at the previous catalogue (every v1 and socket-order
//     domain catalogue without 0098) reads as stale to the new catalogue, is
//     brought current by `migrate up` alone (only 0098 runs), keeps every row,
//     and then passes the ledger check the serving roles run at boot;
//   * the operation is independent of the optional ordering conversion: a v1
//     ledger with 0098 can still adopt the socket-order successor;
//   * a build without 0098 refuses the new ledger (MIG_UNKNOWN), as any
//     older catalogue does.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { run } = require('../lib/migrations/postgres');
const { inspect } = require('../lib/migrations/postgres-check');
const { validateCatalogue } = require('../lib/migrations/catalogue');
const index = require('../lib/storage/identifier-array-index-sql');
const { optInSuite } = require('./support/opt-in');

const uri = process.env.NS_TEST_POSTGRES_ADMIN_URI;
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const FILES = [...index.DOMAINS.map(domain => [domain, `postgres-${domain}-v1.json`]),
  ...['treatments', 'devicestatus', 'profile'].map(domain => [domain, `postgres-${domain}-socket-order-v1.json`])];
// eslint-disable-next-line security/detect-non-literal-require -- fixed reviewed candidate names
const load = file => require('../migrations/candidates/' + file);
const without0098 = (catalogue, domain) => ({ ...catalogue, migrations: catalogue.migrations.filter(m => m.name !== index.NAME(domain)) });

optInSuite(!!uri, 'NS_TEST_POSTGRES_ADMIN_URI (disposable PostgreSQL)')('identifier-array index migration on existing databases', function () {
  this.timeout(120000);
  const prefix = 'idarr_' + crypto.randomBytes(5).toString('hex');
  const schemas = [];
  let admin;
  before(async () => { admin = new Client({ connectionString: uri }); await admin.connect(); });
  after(async () => {
    if (!admin) return;
    for (const schema of schemas) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });
  const options = namespace => ({ direct: true, connectionString: uri, namespace, statementTimeoutMs: 10000 });
  async function rows (namespace, domain) {
    return (await admin.query(`SELECT tenant_id, id_kind, doc FROM "${namespace}"."${domain}" ORDER BY tenant_id, id_kind, "_id"`)).rows;
  }
  async function insert (namespace, domain, tenant, doc) {
    await admin.query('BEGIN');
    try {
      await admin.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenant]);
      await admin.query(`INSERT INTO "${namespace}"."${domain}" (tenant_id, id_kind, doc) VALUES ($1, 'string', $2)`, [tenant, doc]);
      await admin.query('COMMIT');
    } catch (error) { await admin.query('ROLLBACK'); throw error; }
  }
  async function indexState (namespace, domain) {
    return (await admin.query(`SELECT i.indisvalid AS valid, pg_get_expr(i.indpred, i.indrelid) AS predicate,
      pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i WHERE i.indexrelid = to_regclass($1)`,
    [`"${namespace}"."${index.INDEX(domain)}"`])).rows[0] || null;
  }

  for (const [domain, file] of FILES) {
    it(`${file}: a populated previous-catalogue namespace migrates with 0098 alone and becomes ready`, async () => {
      const catalogue = load(file), previous = without0098(catalogue, domain);
      assert.equal(catalogue.migrations.length - previous.migrations.length, 1, 'ONE_NEW_MIGRATION');
      assert.deepEqual(catalogue.migrations.find(m => m.name === index.NAME(domain)).operation, { kind: 'identifier-array-index-v1', domain });
      const namespace = prefix + '_' + file.replace(/^postgres-|-v1\.json$/g, '').replace(/-/g, '_');
      schemas.push(namespace);
      await run('up', { ...options(namespace), catalogue: previous });
      for (const [tenant, doc] of [[A, { _id: 'a-v1', note: 'no identifier' }], [A, { _id: 'a-v3', identifier: 'synthetic-id' }],
        [A, { _id: 'a-array', identifier: ['synthetic-id', 'other'] }], [B, { _id: 'b-v3', identifier: 'synthetic-id' }]]) {
        await insert(namespace, domain, tenant, doc);
      }
      const before = await rows(namespace, domain);
      assert.equal(await indexState(namespace, domain), null, 'PREVIOUS_CATALOGUE_HAS_NO_INDEX');

      // The new build sees a stale ledger: the boot ledger check waits (MIG_STALE).
      await assert.rejects(run('check', { ...options(namespace), catalogue }), error => error.code === 'MIG_STALE');
      assert.deepEqual((await run('status', { ...options(namespace), catalogue })).pending, [index.NAME(domain)]);

      const upgraded = await run('up', { ...options(namespace), catalogue });
      assert.deepEqual(upgraded.done, [index.NAME(domain)], 'ONLY_0098_RUNS');
      assert.equal(upgraded.current, true);
      assert.equal((await run('check', { ...options(namespace), catalogue })).current, true, 'READY_AFTER_MIGRATE_UP');
      // The same ledger inspection the serving roles run at boot (role-readiness).
      const state = await inspect(admin.query.bind(admin), { table: `"${namespace}".schema_migrations`, files: validateCatalogue(catalogue) });
      assert.equal(state.current, true);
      const built = await indexState(namespace, domain);
      assert.equal(built.valid, true);
      assert.equal(built.predicate, "(jsonb_typeof((doc -> 'identifier'::text)) = 'array'::text)");
      assert.match(built.definition, /USING btree \(tenant_id\) WHERE/);
      assert.deepEqual(await rows(namespace, domain), before, 'ROWS_UNCHANGED');
      // A build without the operation refuses the new ledger.
      await assert.rejects(run('check', { ...options(namespace), catalogue: previous }), error => error.code === 'MIG_UNKNOWN');
    });
  }

  for (const domain of ['treatments', 'devicestatus', 'profile']) {
    it(`${domain}: a v1 ledger holding 0098 (or not) still adopts the socket-order successor`, async () => {
      const v1 = load(`postgres-${domain}-v1.json`), successor = load(`postgres-${domain}-socket-order-v1.json`);
      for (const [label, start] of [['with', v1], ['without', without0098(v1, domain)]]) {
        const namespace = `${prefix}_${domain}_adopt_${label}`;
        schemas.push(namespace);
        await run('up', { ...options(namespace), catalogue: start });
        const adopted = await run('up', { ...options(namespace), catalogue: successor });
        assert.equal(adopted.current, true, label);
        assert.equal((await run('check', { ...options(namespace), catalogue: successor })).current, true, label);
        assert.equal((await indexState(namespace, domain)).valid, true, label);
      }
    });
  }
});
