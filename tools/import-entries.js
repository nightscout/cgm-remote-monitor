'use strict';

const scope = require('../lib/storage/tenant-scope');
const postgresConnection = require('../lib/storage/postgres-connection');
const {
  createNightscoutEntriesSource,
  createPostgresTarget,
  importEntries
} = require('../lib/import/entries');

async function main (env = process.env) {
  const tenant = env.NS_IMPORT_TENANT_ID;
  const namespace = env.NS_TARGET_POSTGRES_NAMESPACE;
  if (!env.NS_SOURCE_URL || !env.NS_SOURCE_READ_TOKEN || !env.NS_TARGET_POSTGRES_URL ||
      typeof tenant !== 'string' || typeof namespace !== 'string') {
    throw new TypeError('Entries import requires source, token, target and tenant environment');
  }
  const source = createNightscoutEntriesSource({
    baseUrl: env.NS_SOURCE_URL,
    token: env.NS_SOURCE_READ_TOKEN
  });
  const previousMode = scope.getTenancyMode();
  scope.setTenancyMode('multi');
  let connection;
  try {
    connection = await postgresConnection({
      connectionString: env.NS_TARGET_POSTGRES_URL,
      max: 2,
      connectionTimeoutMillis: 5000,
      statement_timeout: 30000,
      query_timeout: 30000,
      application_name: 'nightscout-entries-import'
    });
    const target = createPostgresTarget({ connection, tenant, table: namespace + '.entries' });
    const requestedPageSize = env.NS_IMPORT_PAGE_SIZE === undefined ? 100 : Number(env.NS_IMPORT_PAGE_SIZE);
    return await importEntries({ source, target, tenant, pageSize: requestedPageSize });
  } finally {
    try {
      if (connection) await connection.end();
    } finally {
      scope.setTenancyMode(previousMode);
    }
  }
}

if (require.main === module) {
  main().then(result => {
    process.stdout.write(JSON.stringify(result) + '\n');
  }).catch(error => {
    const code = error && typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
      ? error.code
      : 'IMPORT_FAILED';
    process.stderr.write(code + '\n');
    process.exitCode = 1;
  });
}

module.exports = { main };
