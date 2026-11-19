'use strict';

const common = require('../../../lib/tenant-operations/common');
const { refuse, qualified } = common;

function validateAcl (acl, steps) {
  if (acl === null) return;
  if (!acl || typeof acl !== 'object') throw refuse('RESTORE_ACL_ROLE_INVALID');
  if (!Object.hasOwn(acl, 'grants')) {
    if (steps?.some(step => step.files.some(migration => migration.operation?.kind === 'tenant-insertion-v1'))) {
      throw refuse('RESTORE_TENANT_COUNTER_EXPLICIT_ACL_REQUIRED');
    }
    if (typeof acl.role !== 'string' || !common.ROLE.test(acl.role)) throw refuse('RESTORE_ACL_ROLE_INVALID');
    return; // Historical representative interface; deployment composition refuses it.
  }
  if (Object.hasOwn(acl, 'role') || !Array.isArray(acl.grants)) throw refuse('RESTORE_ACL_PLAN_INVALID');
  const seen = new Set();
  if (acl.tenantInsertion !== undefined && !Array.isArray(acl.tenantInsertion)) throw refuse('RESTORE_ACL_PLAN_INVALID');
  const insertion = new Map();
  for (const declaration of acl.tenantInsertion || []) {
    const step = steps?.find(step => step.kind === declaration?.kind);
    const key = declaration?.role + '.' + declaration?.kind;
    if (!declaration || Object.keys(declaration).sort().join(',') !== 'kind,mode,role' ||
        typeof declaration.role !== 'string' || !common.ROLE.test(declaration.role) || declaration.role === 'public' || declaration.role.startsWith('pg_') ||
        !['reader', 'serving', 'restore'].includes(declaration.mode) || insertion.has(key) ||
        !step?.files.some(migration => migration.operation?.kind === 'tenant-insertion-v1' && migration.operation.domain === step.kind)) {
      throw refuse('RESTORE_TENANT_COUNTER_ACL_INVALID');
    }
    insertion.set(key, declaration);
  }
  for (const grant of acl.grants) {
    if (!grant || typeof grant.role !== 'string' || !common.ROLE.test(grant.role)) throw refuse('RESTORE_ACL_ROLE_INVALID');
    const step = steps && steps.find(item => item.kind === grant.kind);
    const key = [grant.role, grant.kind, grant.table].join('.');
    const columnPrivileges = grant.columnPrivileges || {};
    if (typeof columnPrivileges !== 'object' || Array.isArray(columnPrivileges)) throw refuse('RESTORE_ACL_PLAN_INVALID');
    for (const [privilege, columns] of Object.entries(columnPrivileges)) {
      if (!['SELECT', 'INSERT', 'UPDATE'].includes(privilege) || !Array.isArray(columns) || !columns.length ||
          columns.some(column => typeof column !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(column)) ||
          new Set(columns).size !== columns.length || grant.table === 'schema_migrations' ||
          (Array.isArray(grant.privileges) && grant.privileges.includes(privilege))) throw refuse('RESTORE_ACL_PLAN_INVALID');
    }
    if (!step || (grant.table !== 'schema_migrations' && !step.tables.includes(grant.table)) || seen.has(key) ||
        !Array.isArray(grant.privileges) || (!grant.privileges.length && !Object.keys(columnPrivileges).length) ||
        new Set(grant.privileges).size !== grant.privileges.length ||
        grant.privileges.some(value => !['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(value)) ||
        (grant.table === 'schema_migrations' && grant.privileges.some(value => value !== 'SELECT')) ||
        !Array.isArray(grant.sequencePrivileges || []) ||
        new Set(grant.sequencePrivileges || []).size !== (grant.sequencePrivileges || []).length ||
        (grant.sequencePrivileges || []).some(value => !['USAGE', 'SELECT'].includes(value))) {
      throw refuse('RESTORE_ACL_PLAN_INVALID');
    }
    seen.add(key);
    if (step.files.some(migration => migration.operation?.kind === 'tenant-insertion-v1') && grant.table !== 'schema_migrations') {
      if (!insertion.has(grant.role + '.' + grant.kind)) throw refuse('RESTORE_TENANT_COUNTER_ACL_REQUIRED', key);
      const declaration = insertion.get(grant.role + '.' + grant.kind);
      if (grant.privileges.includes('INSERT') || grant.table === 'tenant_insertion_ordinal' &&
          (grant.privileges.some(privilege => privilege !== 'SELECT' && !(privilege === 'DELETE' && declaration.mode === 'restore')) || Object.keys(columnPrivileges).length)) {
        throw refuse('RESTORE_TENANT_COUNTER_BROAD_GRANT', key);
      }
    }
  }
}

// Construct every statement and resolve sequence identities before INSERT/GRANT.
async function prepareAcl (connection, steps, work, acl) {
  if (acl === null) return { result: null, statements: [], roleChecks: [] };
  const statements = [];
  if (!Object.hasOwn(acl, 'grants')) {
    for (const step of steps) {
      statements.push('GRANT USAGE ON SCHEMA "' + step.namespace + '" TO "' + acl.role + '"');
      for (const table of step.tables) statements.push('GRANT SELECT, INSERT, UPDATE, DELETE ON ' + qualified(step.namespace, table) + ' TO "' + acl.role + '"');
      if (step.kind === 'tenant_settings') statements.push(...require('../../../lib/tenant-settings/function-privileges').writerGrants({namespace:step.namespace,role:acl.role}));
      statements.push('GRANT SELECT ON ' + qualified(step.namespace, 'schema_migrations') + ' TO "' + acl.role + '"');
      statements.push('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "' + step.namespace + '" TO "' + acl.role + '"');
    }
    return { result: acl.role, statements };
  }
  const usages = new Set();
  for (const grant of acl.grants) {
    const step = steps.find(item => item.kind === grant.kind);
    const usage = step.namespace + '.' + grant.role;
    if (!usages.has(usage)) {
      statements.push('GRANT USAGE ON SCHEMA "' + step.namespace + '" TO "' + grant.role + '"');
      usages.add(usage);
    }
    if (grant.kind === 'tenant_settings' && ['tenant_settings', 'tenant_settings_history'].includes(grant.table) &&
        ['INSERT', 'UPDATE'].some(privilege => grant.privileges.includes(privilege) ||
          (grant.columnPrivileges?.[privilege] || []).length > 0)) {
      statements.push(...require('../../../lib/tenant-settings/function-privileges').writerGrants({namespace:step.namespace,role:grant.role}));
    }
    const scopedPrivileges = grant.privileges.slice();
    for (const [privilege, columns] of Object.entries(grant.columnPrivileges || {})) {
      const item = work.find(item => item.kind === grant.kind && item.table === grant.table);
      if (!item || columns.some(column => !item.columns.some(actual => actual.name === column))) throw refuse('RESTORE_ACL_COLUMN_INVALID');
      scopedPrivileges.push(privilege + ' (' + columns.map(column => '"' + column + '"').join(', ') + ')');
    }
    statements.push('GRANT ' + scopedPrivileges.join(', ') + ' ON ' + qualified(step.namespace, grant.table) + ' TO "' + grant.role + '"');
    if ((grant.sequencePrivileges || []).length) {
      const item = work.find(item => item.kind === grant.kind && item.table === grant.table);
      if (!item || !item.columns.some(column => column.identity)) throw refuse('RESTORE_ACL_SEQUENCE_INVALID');
      for (const column of item.columns.filter(column => column.identity)) {
        const found = await connection.query('SELECT n.nspname AS namespace, c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=pg_get_serial_sequence($1,$2)::regclass', [qualified(step.namespace, grant.table), column.name]);
        const sequence = found.rows[0];
        if (!sequence || sequence.namespace !== step.namespace || !common.namespaceValid(sequence.name)) throw refuse('RESTORE_ACL_SEQUENCE_INVALID');
        statements.push('GRANT ' + grant.sequencePrivileges.join(', ') + ' ON SEQUENCE ' + qualified(sequence.namespace, sequence.name) + ' TO "' + grant.role + '"');
      }
    }
  }
  const roleChecks = [];
  for (const declaration of acl.tenantInsertion || []) {
    const step = steps.find(step => step.kind === declaration.kind);
    const sql = require('../../../lib/tenant-lifecycle/tenant-insertion-sql').build({ namespace: step.namespace, domain: step.kind });
    statements.push('GRANT USAGE ON SCHEMA "' + step.namespace + '" TO "' + declaration.role + '"');
    if (declaration.mode === 'reader') {
      for (const table of [step.kind, sql.counterTable]) statements.push('GRANT SELECT ON ' + qualified(step.namespace, table) + ' TO "' + declaration.role + '"');
    } else {
      statements.push(...(declaration.mode === 'restore' ? sql.restoreGrants(declaration.role) : sql.servingGrants(declaration.role)));
      if (declaration.mode === 'restore') {
        // Integrated private lifecycle execution also erases its own counter.
        // The original standalone grant verifier intentionally has a narrower
        // empty-target contract; current shared role admission is authoritative.
        statements.push('GRANT DELETE ON ' + qualified(step.namespace, sql.counterTable) + ' TO "' + declaration.role + '"');
      } else statements.push(sql.verifyGrants(declaration.role, { restore: false }));
    }
    roleChecks.push({ namespace: step.namespace, domain: step.kind, role: declaration.role, mode: declaration.mode });
  }
  return { result: { roles: [...new Set([...acl.grants.map(grant => grant.role), ...(acl.tenantInsertion || []).map(item => item.role)])], grants: acl.grants.length }, statements, roleChecks };
}

function insertStatement (namespace, table, columns) {
  const identity = columns.some(column => column.identity);
  return 'INSERT INTO ' + qualified(namespace, table) + ' (' + columns.map(column => '"' + column.name + '"').join(', ') + ')' +
    (identity ? ' OVERRIDING SYSTEM VALUE' : '') + ' VALUES (' +
    columns.map((column, index) => '$' + (index + 1) + '::' + column.type).join(', ') + ')';
}

function insertValues (columns, row) {
  return columns.map(column => {
    const value = row[column.name];
    if (value === null || value === undefined) return null;
    return column.type === 'jsonb' || column.type === 'json' ? JSON.stringify(value) : value;
  });
}

module.exports = { validateAcl, prepareAcl, insertStatement, insertValues };
