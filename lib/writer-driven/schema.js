'use strict';

// Writer-driven evaluator start check (decision stable-evaluator-runtime). With
// no stream there is no DDL gate: at boot the evaluator verifies that every
// migration ledger it reads, including the lifecycle catalogue its window read
// and completion fence use, is exactly the reviewed catalogue it requires. Any
// mismatch (unknown, drifted, out of order or pending migration) refuses the
// role with one typed code. There is no in-flight detection: an operator runs
// migrations, then restarts the role.
const { Client } = require('pg');
const { validateCatalogue } = require('../migrations/catalogue');
const { inspect } = require('../migrations/postgres-check');

const CODE = 'EVALUATOR_SCHEMA_REFUSED';
const refuse = (detail, cause) => Object.assign(new Error(CODE), { code: CODE, detail, ...(cause ? { cause } : {}) });

// ledgers: [{connectionString, namespace, catalogue}] (role-readiness ledgers()).
async function check (ledgers, { timeoutMs = 5000 } = {}) {
  if (!Array.isArray(ledgers) || !ledgers.length) throw new TypeError('Explicit evaluator ledgers required');
  const byConnection = new Map();
  for (const row of ledgers) {
    if (!byConnection.has(row.connectionString)) byConnection.set(row.connectionString, []);
    byConnection.get(row.connectionString).push(row);
  }
  for (const [connectionString, rows] of byConnection) {
    const client = new Client({ connectionString, connectionTimeoutMillis: timeoutMs, statement_timeout: timeoutMs,
      application_name: 'nightscout-evaluator-schema' });
    client.on('error', () => {});
    try {
      await client.connect();
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      for (const row of rows) {
        let state;
        try { state = await inspect(client.query.bind(client), { table: '"' + row.namespace + '".schema_migrations', files: validateCatalogue(row.catalogue) }); }
        catch (error) { throw refuse(row.namespace, error); }
        if (!state.current) throw refuse(row.namespace);
      }
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      await client.end().catch(() => {});
    }
  }
}

module.exports = { CODE, check };
