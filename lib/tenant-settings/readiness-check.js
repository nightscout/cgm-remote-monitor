'use strict';

// Each invocation checks the current transaction's role and complete write scope.
// The supplied SELECT capability owns neither connection nor transaction methods.
module.exports = async function settingsReadinessCheck (query, writable = []) {
    const role = (await query('SELECT rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication FROM pg_roles WHERE rolname=current_user')).rows[0];
    if (!role || Object.values(role).some(Boolean)) throw new Error('unsafe settings identity');
    const state = (await query(`SELECT
      EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
        AND has_schema_privilege(n.oid,'CREATE')) AS creates,
      EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p')
        AND NOT ((n.nspname || '.' || c.relname)=ANY($1::text[]))
        AND (pg_has_role(current_user,c.relowner,'MEMBER') OR
          has_table_privilege(c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
          has_any_column_privilege(c.oid,'INSERT,UPDATE,REFERENCES'))) AS mutates`, [writable])).rows[0];
    if (!state || state.creates || state.mutates) throw new Error('unsafe settings scope');
};
