'use strict';


const { Client } = require('pg');
const PostgresCleanupError = require('../storage/postgres-cleanup-error');

// Read-only startup screening. Operator migrations and row provisioning remain
// explicit; the new optional identity has no unrelated application write scope.
module.exports = async function settingsReadiness ({ connectionString, writable = [] }) {
  const client = new Client({ connectionString, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
  let outcome = {};
  try {
    await client.connect(); await client.query('BEGIN READ ONLY');
    await require('./readiness-check')(client.query.bind(client), writable);
    await client.query('ROLLBACK');
  } catch (error) { outcome = { error }; }
  // Cleanup uncertainty takes precedence while preserving the primary cause.
  try { await client.end(); } catch (cleanupError) { throw new PostgresCleanupError(outcome.error || cleanupError, cleanupError); }
  if ('error' in outcome) throw outcome.error;
};
