'use strict';
// Explicit parent-owned native phase only. Root hands in two dedicated schemas;
// no container or role provisioning, no historical-order inference/backfill.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
module.exports = async function upgrade (input) {
  const config = require('./profile-differential').configuration(input);
  const owned = JSON.parse(fs.readFileSync(config.ownershipFile, 'utf8'));
  assert.deepEqual(config.upgradeNamespaces, owned.upgradeNamespaces);
  assert(config.upgradeNamespaces && Object.keys(config.upgradeNamespaces).length === 2);
  assert(config.upgradeNamespaces.empty !== config.upgradeNamespaces.populated);
  for (const namespace of Object.values(config.upgradeNamespaces)) assert.match(namespace, /^[a-z][a-z0-9_]{0,62}$/);
  const { Client } = require('pg'), admin = new Client({ connectionString: input.env.NS_TEST_POSTGRES_ADMIN_URI });
  const { run } = require('../../../lib/migrations/postgres');
  const old = require('../../../migrations/candidates/postgres-profile-v1.json');
  const successor = require('../../../migrations/candidates/postgres-profile-socket-order-v1.json');
  const observations = [], save = () => fs.writeFileSync(path.join(input.captureDir, 'profile-upgrade-physical.json'), JSON.stringify(observations, null, 2) + '\n');
  const options = (namespace, catalogue) => ({ direct: true, connectionString: input.env.NS_TEST_POSTGRES_ADMIN_URI, namespace, catalogue });
  async function physical (namespace) {
    return { documents: (await admin.query('SELECT id_kind,doc FROM "' + namespace + '".profile')).rows,
      ledger: (await admin.query('SELECT name,checksum FROM "' + namespace + '".schema_migrations ORDER BY name')).rows,
      columns: (await admin.query('SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position', [namespace, 'profile'])).rows,
      guards: (await admin.query('SELECT conname FROM pg_constraint WHERE connamespace=$1::regnamespace AND conname=$2', [namespace, 'socket_order_requires_empty'])).rows };
  }
  try {
    await admin.connect();
    for (const namespace of Object.values(config.upgradeNamespaces)) {
      assert.match(namespace, /^[a-z][a-z0-9_]{0,62}$/); assert.equal((await run('check', options(namespace, old))).current, true);
      assert.deepEqual((await physical(namespace)).documents, [], 'root hands in empty owned base schemas');
    }
    const populated = config.upgradeNamespaces.populated;
    await admin.query('INSERT INTO "' + populated + '".profile(tenant_id,id_kind,doc) VALUES($1,$2,$3::jsonb)',
      [config.tenant, 'string', JSON.stringify({ _id: 'synthetic-existing', NSCLIENT_ID: 'synthetic-existing' })]);
    const before = await physical(populated); let code;
    try { await run('up', options(populated, successor)); } catch (error) {
      for (let cause = error; cause; cause = cause.cause) if (cause.code === '23514') code = cause.code;
      if (!code) throw error;
    }
    const after = await physical(populated); observations.push({ kind: 'populated', before, after, code }); save();
    assert.equal(code, '23514', 'PROFILE_POPULATED_UPGRADE_REFUSED refuses rather than inventing past order');
    assert.deepEqual(after, before, 'PROFILE_POPULATED_UPGRADE_ATOMIC rows/columns/ledger unchanged');
    const empty = config.upgradeNamespaces.empty;
    await run('up', options(empty, successor));
    assert.equal((await run('check', options(empty, successor))).current, true);
    let oldCode; try { await run('check', options(empty, old)); } catch (error) { oldCode = error.code; }
    assert.equal(oldCode, 'MIG_UNKNOWN', 'PROFILE_OLD_CATALOGUE_REFUSES_SUCCESSOR explicit rollback boundary');
    for (const id of ['z-first', 'a-second']) await admin.query('INSERT INTO "' + empty + '".profile(tenant_id,id_kind,doc) VALUES($1,$2,$3::jsonb)',
      [config.tenant, 'string', JSON.stringify({ _id: id, NSCLIENT_ID: 'synthetic-match' })]);
    const ordinals = (await admin.query('SELECT "_id",insertion_ordinal FROM "' + empty + '".profile ORDER BY insertion_ordinal')).rows;
    await admin.query('UPDATE "' + empty + '".profile SET doc=doc || $1::jsonb WHERE "_id"=$2', [JSON.stringify({ marker: 'synthetic-edit' }), 'z-first']);
    const retained = (await admin.query('SELECT "_id",insertion_ordinal FROM "' + empty + '".profile ORDER BY insertion_ordinal')).rows;
    observations.push({ kind: 'empty', oldCode, ordinals, retained }); save();
    assert.deepEqual(ordinals.map(row => row._id), ['z-first', 'a-second']); assert.deepEqual(retained, ordinals, 'PROFILE_ORDINAL_RETAINED edit cannot reorder insertion');
  } finally {
    // Root owns schema lifecycle; reset only inserted synthetic tenant rows.
    const errors = [];
    for (const namespace of Object.values(config.upgradeNamespaces)) try {
      await admin.query('DELETE FROM "' + namespace + '".profile WHERE tenant_id=$1', [config.tenant]);
    } catch (error) { errors.push(error.code || 'CLEANUP_FAILED'); }
    await admin.end(); observations.push({ cleanupErrors: errors, schemasUntouched: true }); save(); assert.equal(errors.length, 0);
  }
};
