'use strict';

const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const baseLab = require('./tenant-commit-clock-port');
const connect = require('../../lib/storage/postgres-connection');
const createReplay = require('../../lib/storage/postgres-durable-replay');
const { run } = require('../../lib/migrations/postgres');
const { encodeDocument, decodeDocument } = require('../../lib/storage/postgres-identity');
const scope = require('../../lib/storage/tenant-scope');
const dates = require('../../lib/server/srv-dates');

module.exports = function replayLab () {
  const lab = baseLab();
  const open = lab.open.bind(lab), close = lab.close.bind(lab), reset = lab.reset.bind(lab);
  let readerCreated = false, childCreated = false, replayOwned = false;
  lab.replayNamespace = lab.name + '_replay';
  lab.readerRole = lab.name + '_reader';
  lab.makeConsumer = (consumer = 'evaluator', connection = lab.reader, overrides = {}) => createReplay({
    connection, checkpointTable: lab.replayNamespace + '.tenant_consumer_checkpoint',
    clockTable: lab.namespaces.clock + '.tenant_write_clock', domains: { entries: lab.table },
    consumer, projectionVersion: 'current-rows-v1', pageSize: 1, maxRows: 100, ...overrides
  });
  lab.open = async () => {
    await open();
    const adminUri = process.env.NS_TEST_POSTGRES_ADMIN_URI;
    await lab.admin.query('CREATE SCHEMA "' + lab.replayNamespace + '"');
    replayOwned = true;
    await run('up', { direct: true, connectionString: adminUri, namespace: lab.replayNamespace,
      catalogue: require('../../migrations/candidates/postgres-consumer-checkpoint-v1.json') });
    const password = crypto.randomBytes(24).toString('hex');
    await lab.admin.query(`CREATE ROLE "${lab.readerRole}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
    readerCreated = true;
    for (const namespace of [lab.namespaces.entries, lab.namespaces.clock, lab.replayNamespace]) {
      await lab.admin.query(`GRANT USAGE ON SCHEMA "${namespace}" TO "${lab.readerRole}"`);
    }
    await lab.admin.query(`GRANT SELECT ON "${lab.namespaces.entries}".entries,"${lab.namespaces.clock}".tenant_write_clock TO "${lab.readerRole}"`);
    await lab.admin.query(`GRANT SELECT, UPDATE(checkpoint,projection,contract_digest) ON "${lab.replayNamespace}".tenant_consumer_checkpoint TO "${lab.readerRole}"`);
    const readerUrl = new URL(adminUri); readerUrl.username = lab.readerRole; readerUrl.password = password;
    lab.reader = await connect({ connectionString: readerUrl.toString(), max: 2, statement_timeout: 10000 });
    const writerUrl = new URL(adminUri);
    const credentials = await lab.raw[0].withTenant(lab.A, () => lab.raw[0].query('SELECT current_user AS role'));
    // The base fixture's writer password is not exported. Give the child a
    // separately scoped writer identity, owned and dropped by this fixture.
    lab.childRole = lab.name + '_child';
    const childPassword = crypto.randomBytes(24).toString('hex');
    await lab.admin.query(`CREATE ROLE "${lab.childRole}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${childPassword}'`);
    childCreated = true;
    await lab.admin.query(`GRANT "${credentials.rows[0].role}" TO "${lab.childRole}"`);
    writerUrl.username = lab.childRole; writerUrl.password = childPassword;
    lab.childConfig = { connectionString: writerUrl.toString(), clockNamespace: lab.namespaces.clock, table: lab.table, tenant: lab.A };
  };
  lab.reset = async () => {
    await reset();
    if (lab.reader) await lab.admin.query(`DELETE FROM "${lab.replayNamespace}".tenant_consumer_checkpoint`);
  };
  lab.provision = async (consumer = 'evaluator', tenant = lab.A, projection = null, checkpoint = 0, digest) => {
    const handle = lab.makeConsumer(consumer);
    await lab.admin.query(`INSERT INTO "${lab.replayNamespace}".tenant_consumer_checkpoint
      (tenant_id,consumer,contract_digest,checkpoint,projection) VALUES($1,$2,$3,$4,$5::jsonb)`,
    [tenant, consumer, digest || handle.digest, checkpoint, projection === null ? null : JSON.stringify(projection)]);
    return handle;
  };
  lab.persist = (docs, tenant = lab.A) => scope.withTenant(tenant, () => lab.clocks[0].transaction(async () => {
    const modified = dates.next();
    for (const input of docs) {
      const row = encodeDocument({ ...input, srvModified: modified });
      await lab.raw[0].query(`INSERT INTO "${lab.namespaces.entries}".entries(tenant_id,id_kind,doc) VALUES($1,$2,$3::jsonb)
        ON CONFLICT(tenant_id,id_kind,"_id") DO UPDATE SET doc=excluded.doc`, [tenant, row.id_kind, JSON.stringify(row.doc)]);
    }
    return modified;
  }));
  lab.checkpoint = async (consumer = 'evaluator', tenant = lab.A) =>
    (await lab.admin.query(`SELECT checkpoint,projection,contract_digest FROM "${lab.replayNamespace}".tenant_consumer_checkpoint
      WHERE tenant_id=$1 AND consumer=$2`, [tenant, consumer])).rows[0];
  lab.typedRows = async (tenant = lab.A) => (await lab.admin.query(
    `SELECT id_kind,doc FROM "${lab.namespaces.entries}".entries WHERE tenant_id=$1
      ORDER BY "srvModified",id_kind COLLATE "C","_id" COLLATE "C"`, [tenant])).rows;
  lab.close = async () => {
    const errors = [], attempt = async fn => {try {await fn();} catch(error) {errors.push(error);}};
    if (lab.reader) await attempt(() => lab.reader.end());
    if (lab.admin) {
      if (replayOwned) await attempt(async () => {await lab.admin.query(`DROP SCHEMA IF EXISTS "${lab.replayNamespace}" CASCADE`); replayOwned = false;});
      if (childCreated) await attempt(async () => {await lab.admin.query(`DROP ROLE IF EXISTS "${lab.childRole}"`); childCreated = false;});
      if (readerCreated) await attempt(async () => {
        await lab.admin.query(`DROP OWNED BY "${lab.readerRole}"`);
        await lab.admin.query(`DROP ROLE IF EXISTS "${lab.readerRole}"`); readerCreated = false;
      });
    }
    await attempt(() => close());
    if (errors.length) throw new globalThis.AggregateError(errors, 'Replay fixture owned cleanup refused');
  };
  return lab;
};

// Compare against independent stored kind metadata, not JSON's string form of
// ObjectId. Both typed identity and all document values remain in the oracle.
module.exports.assertDocuments = (actual, stored) => assert.deepEqual(actual, stored.map(decodeDocument));
