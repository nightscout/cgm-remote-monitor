'use strict';

// Shared with ordinary provisioning BEFORE key birth. One existing held client,
// no second pool slot and no transaction held open while Vault answers.
const key = (namespace, tenant) => 'nightscout:tenant-provision:' + namespace + ':' + tenant;
const fail = () => Object.assign(new Error('TENANT_PROVISION_BUSY'), { code: 'TENANT_PROVISION_BUSY' });
module.exports = {
  async acquireLifecycle (client, tenant) {
    const row = (await client.query('SELECT pg_catalog.pg_try_advisory_lock($1::bigint) AS held',[require('./rules').lockKey(tenant)])).rows[0];
    if (row?.held !== true) throw fail();
  },
  async releaseLifecycle (client, tenant) {
    const row = (await client.query('SELECT pg_catalog.pg_advisory_unlock($1::bigint) AS released',[require('./rules').lockKey(tenant)])).rows[0];
    if (row?.released !== true) throw fail();
  },
  async acquire (client, namespace, tenant) {
    const row = (await client.query('SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtextextended($1,0)) AS held', [key(namespace, tenant)])).rows[0];
    if (row?.held !== true) throw fail();
  },
  async finish (client, namespace, tenant, locked, failure, lifecycle = false) {
    let cleanupError;
    try {
      if (lifecycle && !failure) await module.exports.releaseLifecycle(client,tenant);
      if (locked && !failure) await module.exports.release(client,namespace,tenant);
    }
    catch (error) { cleanupError = error; }
    client.release(failure || cleanupError);
    if (cleanupError) throw cleanupError;
  },
  async release (client, namespace, tenant) {
    const row = (await client.query('SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended($1,0)) AS released', [key(namespace, tenant)])).rows[0];
    if (row?.released !== true) throw fail();
  }
};
