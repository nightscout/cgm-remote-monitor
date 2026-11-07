'use strict';

const { Client } = require('pg');

// Read-only startup screening. Operator migrations and row provisioning remain
// explicit; the new optional identity has no unrelated application write scope.
module.exports = async function settingsReadiness ({ connectionString, writable = [] }) {
  const client = new Client({ connectionString, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
  try {
    await client.connect(); await client.query('BEGIN READ ONLY');
    const role = (await client.query('SELECT rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication FROM pg_roles WHERE rolname=current_user')).rows[0];
    if (!role || Object.values(role).some(Boolean)) throw new Error('unsafe settings identity');
    const state = (await client.query(`SELECT
      EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
        AND has_schema_privilege(n.oid,'CREATE')) AS creates,
      EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p')
        AND NOT ((n.nspname || '.' || c.relname)=ANY($1::text[]))
        AND (pg_has_role(current_user,c.relowner,'MEMBER') OR
          has_table_privilege(c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
          has_any_column_privilege(c.oid,'INSERT,UPDATE,REFERENCES'))) AS mutates`, [writable])).rows[0];
    if (!state || state.creates || state.mutates) throw new Error('unsafe settings scope');
    await client.query('ROLLBACK');
  } finally { await client.end(); }
};
