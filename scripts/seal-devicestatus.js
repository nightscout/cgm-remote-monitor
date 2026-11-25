'use strict';

// One bounded transaction per part. A stopped invocation can be restarted
// with the same tenant. The ordinary replacement/generation fence protects
// every publication; receivers and evaluators see no clinical mutation.
const { Pool } = require('pg');
const connect = require('../lib/storage/postgres-connection');
const scope = require('../lib/storage/tenant-scope');
const generation = require('../lib/tenant-lifecycle/generation-scope');

async function sealTenant ({ connectionString, namespace, lifecycleNamespace, tenant }) {
  if (typeof namespace !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(namespace) || !connectionString) {
    throw new TypeError('A device-status namespace and operator connection are required');
  }
  const pool = new Pool({ connectionString, max: 1 });
  const window = generation.create({ namespace: lifecycleNamespace, lockRule: 'tenant-id-sha256-v1', pool });
  let connection;
  try {
    await window.ready();
    connection = await connect({ connectionString, operationWindow: window, max: 1, direct: true });
    return await scope.withTenant(tenant, () => window.run(tenant, async () => {
      let sealed = 0;
      for (;;) {
        const result = await connection.query('SELECT "' + namespace + '".devicestatus_seal_day() AS n');
        const count = result.rows[0].n;
        if (!count) return sealed;
        sealed += count;
      }
    }));
  } finally {
    if (connection) await connection.end();
    await window.close();
    await pool.end();
  }
}

if (require.main === module) {
  const [namespace, lifecycleNamespace, tenant] = process.argv.slice(2);
  scope.setTenancyMode('multi');
  sealTenant({ namespace, lifecycleNamespace, tenant, connectionString: process.env.NS_DEVICESTATUS_SEAL_URI })
    .then(sealed => console.log(JSON.stringify({ sealed })))
    .catch(error => { console.error('Device-status sealing failed', error.code || error.message); process.exitCode = 1; });
}
module.exports = { sealTenant };
