'use strict';

const { Client } = require('pg');
const { isDeepStrictEqual } = require('node:util');
const datastore = require('../../storage/postgres-datastore');
const { admit } = require('../../tenant-lifecycle/operation-window-readiness');

// Pre-start checks use the configured identities on direct, read-only transactions.
// Closing the client also releases the transaction on refusal.
async function withClient (options, check, Driver = Client) {
  const client = new Driver({ ...options, connectionTimeoutMillis: 5000, statement_timeout: 5000,
    application_name: 'nightscout-platform-catalogue-check' });
  try {
    await client.connect();
    await client.query('BEGIN READ ONLY');
    try { return await check(client); } finally { await client.query('ROLLBACK'); }
  } finally { await client.end(); }
}

async function inspect (selected, Driver = Client) {
  if (!selected) return undefined;
  const { namespace, intakeProfile } = selected;
  const { identity, database } = await withClient(selected.poolOptions, async client => ({
    identity: await admit(client, namespace, { lifetime: true, intakeProfile }),
    database: await datastore.read(client)
  }), Driver);
  const tables = ['schema_migrations', 'tenant_lifecycle_windows', 'tenant_lifecycle_operations'];
  if (require('../../tenant-lifecycle/native-selection').isNative(intakeProfile)) tables.push(require('../../tenant-lifecycle/recommission-candidate').TABLE);
  const reads = Object.freeze(tables.map(table => namespace + '.' + table));
  return Object.freeze({
    intakeProfileDigest: intakeProfile?.digest,
    async controlReads (client) {
      // Grant only the source-described exceptions after their exact catalogue,
      // owner, policies, column privileges and actual datastore were checked.
      await admit(client, namespace, { identity, intakeProfile });
      if (!isDeepStrictEqual(await datastore.read(client), database)) {
        throw Object.assign(new Error('LIFECYCLE_WINDOW_DATASTORE_CHANGED'), { code: 'LIFECYCLE_WINDOW_DATASTORE_CHANGED' });
      }
      return reads;
    }
  });
}

module.exports = { withClient, inspect };
