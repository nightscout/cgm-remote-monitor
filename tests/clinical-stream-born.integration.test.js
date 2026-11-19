'use strict';
// Decision predictable-fixes-then-test (new tenant serves immediately), on a
// disposable PostgreSQL (synthetic tenant only). A tenant whose provisioning
// transaction arrives through the stream is born with complete, empty input at
// that commit position. Its first clinical input is applied by the receipt and
// evaluated with no snapshot recovery. Red arm: the same stream without the
// birth (provisioned before the slot existed) still goes through recovery.
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { Pool } = require('pg');
const { optInSuite } = require('./support/opt-in');
const connect = require('../lib/storage/postgres-connection');
const scope = require('../lib/storage/tenant-scope');
const replayFactory = require('../lib/storage/postgres-durable-replay');
const receiverFactory = require('../lib/pgstream/receiver');
const policy = require('../lib/storage/clinical-working-set-policy');
const evaluator = require('../lib/data/tenant-projection-evaluator');
const native = require('./lib/clinical-stream-native');
const uri = process.env.NS_TEST_POSTGRES_ADMIN_URI;
const N = '44444444-4444-4444-8444-444444444444', P = '55555555-5555-4555-8555-555555555555';
const at = Date.UTC(2026, 10, 19, 12), limits = { maxRows: 256, maxBytes: 1048576 }, bounds = { maxTransactionRows: 1024, maxTransactionBytes: 4194304 };

optInSuite(uri, 'NS_TEST_POSTGRES_ADMIN_URI')('a freshly provisioned tenant serves its first input without snapshot recovery', function () {
  this.timeout(30000);
  let pool, connection, cohort, lifecycle, clock, mode, appRole;
  before(async function () {
    mode = scope.getTenancyMode(); scope.setTenancyMode('multi');
    pool = new Pool({ connectionString: uri, max: 4 });
    cohort = await require('./fixtures/clinical-native-cohort').create({ admin: pool, pool, prefix: 'synthetic_born_' + randomBytes(4).toString('hex'), tenants: [N, P] });
    lifecycle = cohort.prefix + '_control'; clock = cohort.prefix + '_clock';
    await pool.query('CREATE SCHEMA ' + clock + '; CREATE TABLE ' + clock + '.tenant_write_clock(tenant_id uuid PRIMARY KEY,last_stamp bigint,last_delete_stamp bigint)');
    // The evaluator's store is an ordinary application role, as in serving.
    appRole = cohort.prefix + '_app'; const password = randomBytes(24).toString('hex');
    await pool.query('CREATE ROLE ' + appRole + " LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '" + password + "'");
    for (const schema of [...Object.values(cohort.domains).map(relation => relation.split('.')[0]), cohort.table.split('.')[0], clock]) {
      await pool.query('GRANT USAGE ON SCHEMA ' + schema + ' TO ' + appRole + '; GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA ' + schema + ' TO ' + appRole);
    }
    const app = new URL(uri); app.username = appRole; app.password = password;
    connection = await connect({ connectionString: app.toString(), max: 2, connectionTimeoutMillis: 2000, query_timeout: 5000 });
  });
  after(async function () {
    await connection?.end(); await cohort?.close();
    if (clock) await pool.query('DROP SCHEMA IF EXISTS ' + clock + ' CASCADE');
    if (appRole) await pool.query('DROP OWNED BY ' + appRole + '; DROP ROLE IF EXISTS ' + appRole);
    await pool?.end(); scope.setTenancyMode(mode);
  });

  // One evaluator's stream wiring: the actual receiver, durable replay and
  // projection evaluator. Recovery only counts; it must not be reached.
  async function harness (tenant) {
    const handle = replayFactory({ connection, checkpointTable: cohort.table, clockTable: clock + '.tenant_write_clock', domains: cohort.domains,
      consumer: cohort.consumer, projectionVersion: 'clinical-current-rows-v1', pageSize: 5, maxRows: limits.maxRows, stream: true });
    const recoveries = [];
    handle.configureStream({ recovery: { withSnapshot: async ({ tenant: recovered }) => { recoveries.push(recovered); throw new Error('SYNTHETIC_RECOVERY_REACHED'); } },
      expectedSource: native.source, generation: () => 'fixture:1', assertFence: async () => 'fixture:1', lockKey: () => '124252342164564', maxBytes: limits.maxBytes });
    // As provisioning writes them (lib/tenant-registry/provision.js).
    await pool.query('UPDATE ' + cohort.table + ' SET projection=NULL,checkpoint=0,contract_digest=$3 WHERE consumer=$1 AND tenant_id=$2', [cohort.consumer, tenant, handle.digest]);
    await pool.query('UPDATE ' + cohort.table + ' SET work_version=0,projection=NULL WHERE consumer=$1 AND tenant_id=$2', [cohort.consumer + '-completed', tenant]);
    const store = { consumer: cohort.consumer + '-completed', digest: cohort.completedDigest, available: true };
    const routes = [...cohort.routes.map(route => ({ ...route, kind: 'clinical' })), { schema: lifecycle, table: 'tenant_lifecycle_windows', kind: 'lifecycle' }];
    const receive = receiverFactory.create({ routes, store, onInput: () => {}, onSchema: async () => {},
      clinical: { ...bounds, acceptTransaction: (event, options) => handle.acceptTransaction(event, { ...options, ...bounds }) } });
    return { handle, recoveries, receive };
  }
  const birth = (tenant, position) => native.envelope([{ action: 'I', xid: 42, lsn: position, schema: lifecycle, table: 'tenant_lifecycle_windows',
    columns: [{ name: 'tenant_id', value: tenant }, { name: 'lock_key', value: 1 }, { name: 'phase', value: 'active' }, { name: 'generation', value: 1, type: 'bigint' }] }], position);
  const reading = (tenant, position) => native.envelope([{ ...native.row('first', 123, 'I', tenant), lsn: position, schema: cohort.domains.entries.split('.')[0],
    columns: native.row('first', 123, 'I', tenant).columns.map(column => column.name === 'doc' ? { ...column, value: { _id: 'first', date: at - 60000, type: 'sgv', sgv: 123 } } : column) }], position);
  const evaluate = (handle, tenant) => {
    const component = evaluator({ tenant, replay: handle, connection, env: require('../lib/server/tenant-app/environment')({ settings: { enable: ['bgnow'] } }),
      language: require('../lib/language')(), dbstats: async () => ({ dataSize: 0, indexSize: 0 }), maxRows: limits.maxRows, maxBytes: limits.maxBytes, includeFrame: true });
    return component.evaluate({ at }).finally(() => component.close());
  };

  it('applies the first input of a tenant born in the stream and evaluates it with zero snapshot recoveries', async function () {
    const { handle, recoveries, receive } = await harness(N);
    await receive(birth(N, '0/30'));
    await receive(reading(N, '0/40'));
    const result = await scope.withTenant(N, () => evaluate(handle, N));
    assert.equal((await cohort.read(N)).projection[0].stream.snapshot_position, '0/30', 'BORN_AT_PROVISIONING_POSITION');
    assert.equal(result.properties.bgnow.mean, 123, 'FIRST_INPUT_EVALUATED');
    assert.deepEqual(recoveries, [], 'NEW_TENANT_MUST_NOT_RECOVER');
    assert.equal(handle.sourceAccess().snapshotAttempts, 0);
    assert.equal(handle.sourceAccess().dataAttempts, 0, 'NO_SOURCE_SCAN');
    assert.equal((await cohort.output(N)).work_observed[5], '2', 'FIRST_INPUT_DURABLY_PENDING');
  });

  it('control: without the birth in the stream, the first input still requires recovery (red arm)', async function () {
    const { handle, recoveries, receive } = await harness(P);
    await receive(reading(P, '0/50'));
    await assert.rejects(scope.withTenant(P, () => evaluate(handle, P)), /SYNTHETIC_RECOVERY_REACHED/);
    assert.deepEqual(recoveries, [P], 'UNSEEN_PROVISIONING_MUST_RECOVER');
  });
});
