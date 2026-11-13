'use strict';

const shiroTrie = require('shiro-trie');
const postgresConnection = require('../storage/postgres-connection');
const scope = require('../storage/tenant-scope');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME = /^[a-zA-Z0-9_-]{1,128}$/;
const DEFAULT_ROLES = new Set(['denied', 'readable', 'status-only']);
const DEFAULT_PERMISSIONS = Object.freeze({
  denied: Object.freeze([]),
  readable: Object.freeze(['*:*:read']),
  'status-only': Object.freeze(['api:status:read'])
});

function failure (code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function hasControlCharacters (value) {
  return value.split('').some(character => {
    const code = character.charCodeAt(0);
    return code <= 0x20 || code === 0x7f;
  });
}

function identifier (value, label) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new TypeError('Tenant authority requires a canonical UUID ' + label);
  }
  return value;
}

function permissionTrie (permissions) {
  if (!Array.isArray(permissions) || permissions.length > 256 ||
      permissions.some(value => typeof value !== 'string' || !value.length ||
        value.length > 512 || hasControlCharacters(value))) {
    throw failure('TENANT_AUTHORITY_INVALID');
  }
  try {
    const trie = shiroTrie.new();
    trie.add(permissions);
    return trie;
  } catch {
    throw failure('TENANT_AUTHORITY_INVALID');
  }
}

function validatePermission (permission) {
  if (typeof permission !== 'string' || !permission.length || permission.length > 512 || hasControlCharacters(permission)) {
    throw failure('TENANT_AUTHORITY_PERMISSION_INVALID');
  }
}

function anonymousMayUse (permission) {
  // Anonymous role names are a project-floor allow-list; they cannot grant writes
  // even if a tenant role row was incorrectly provisioned with a wildcard.
  return permission.endsWith(':read');
}

function validatePrincipal (principal) {
  if (!principal || typeof principal !== 'object' ||
      Object.keys(principal).some(key => !['kind', 'subjectId'].includes(key))) {
    throw failure('TENANT_AUTHORITY_PRINCIPAL_INVALID');
  }
  if (principal.kind === 'anonymous' && principal.subjectId === undefined) {
    return Object.freeze({ kind: 'anonymous' });
  }
  if (principal.kind === 'root' && principal.subjectId === undefined) {
    return Object.freeze({ kind: 'root' });
  }
  if (principal.kind === 'subject' && typeof principal.subjectId === 'string' &&
      NAME.test(principal.subjectId)) {
    return Object.freeze({ kind: 'subject', subjectId: principal.subjectId });
  }
  throw failure('TENANT_AUTHORITY_PRINCIPAL_INVALID');
}

module.exports = async function createTenantAuthorization ({ connectionString, namespace }) {
  if (scope.getTenancyMode() !== 'multi' || typeof namespace !== 'string' ||
      !/^[a-z][a-z0-9_]{0,62}$/.test(namespace) || namespace === 'public' ||
      namespace.startsWith('pg_') || namespace === 'information_schema') {
    throw new TypeError('Tenant authority requires explicit multi mode and a non-system namespace');
  }

  let connection;
  try {
    connection = await postgresConnection({
      connectionString,
      max: 4,
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
      query_timeout: 5000,
      application_name: 'nightscout-tenant-authorization'
    });
  } catch {
    throw failure('TENANT_AUTHORITY_UNAVAILABLE');
  }

  const config = '"' + namespace + '".tenant_authorization_config';
  const roles = '"' + namespace + '".tenant_authorization_roles';
  const subjects = '"' + namespace + '".tenant_authorization_subjects';
  const links = '"' + namespace + '".tenant_authorization_subject_roles';
  try {
    const result = await connection.withTenant('00000000-0000-0000-0000-000000000000', () =>
      connection.query(`
        SELECT c.relrowsecurity AND c.relforcerowsecurity AS secured,
          pg_has_role(current_user, c.relowner, 'MEMBER') AS owns,
          has_table_privilege(c.oid, 'SELECT') AS reads,
          has_table_privilege(c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') OR
            has_any_column_privilege(c.oid, 'INSERT,UPDATE,REFERENCES') AS writes,
          has_any_column_privilege(c.oid, 'SELECT') AS column_reads,
          c.oid = to_regclass($1) AS config,
          c.oid = to_regclass($2) AS roles,
          c.oid = to_regclass($3) AS subjects,
          c.oid = to_regclass($4) AS links
        FROM pg_class c
        WHERE c.oid IN (to_regclass($1), to_regclass($2), to_regclass($3), to_regclass($4))`,
      [config, roles, subjects, links]));
    if (result.rows.length !== 4 || result.rows.some(row =>
      !row.secured || row.owns || row.writes || !row.reads || !row.column_reads)) {
      throw failure('TENANT_AUTHORITY_UNSAFE');
    }
  } catch (error) {
    await connection.end();
    if (error && /^TENANT_AUTHORITY_/.test(error.code || '')) throw error;
    throw failure('TENANT_AUTHORITY_UNSAFE');
  }

  // Operation-local snapshot: one SQL statement supplies every permission check.
  // Never retain this object across requests: the next request reads current state.
  async function permissionSnapshot ({ tenant: rawTenant, principal: rawPrincipal } = {}) {
    const tenant = identifier(rawTenant, 'tenant');
    const principal = validatePrincipal(rawPrincipal);

    let result;
    try {
      result = await connection.withTenant(tenant, () => connection.query(`
        SELECT c.anonymous_roles, s.subject_id AS found_subject,
          l.role_name, r.name AS found_role, r.permissions
        FROM ${config} c
        LEFT JOIN ${subjects} s
          ON s.tenant_id = c.tenant_id AND s.subject_id = $2
        LEFT JOIN ${links} l
          ON l.tenant_id = s.tenant_id AND l.subject_id = s.subject_id
        LEFT JOIN ${roles} r
          ON r.tenant_id = l.tenant_id AND r.name = l.role_name
        WHERE c.tenant_id = $1
        ORDER BY l.role_name`,
      [tenant, principal.kind === 'subject' ? principal.subjectId : null]));
    } catch {
      throw failure('TENANT_AUTHORITY_UNAVAILABLE');
    }

    if (!result.rows.length) throw failure('TENANT_AUTHORITY_UNKNOWN');
    const anonymousRoles = result.rows[0].anonymous_roles;
    if (!Array.isArray(anonymousRoles) || anonymousRoles.length > 3 ||
        anonymousRoles.some(role => typeof role !== 'string' || !DEFAULT_ROLES.has(role)) ||
        new Set(anonymousRoles).size !== anonymousRoles.length ||
        result.rows.some(row => JSON.stringify(row.anonymous_roles) !== JSON.stringify(anonymousRoles))) {
      throw failure('TENANT_AUTHORITY_INVALID');
    }

    // The config read is in the same SQL statement/snapshot as principal roles.
    // Root is only a verifier-produced internal principal, never a JWT claim.
    if (principal.kind === 'root') return Object.freeze({ allows: permission => { validatePermission(permission); return true; } });

    const tries = [];
    const groups = [];
    if (principal.kind === 'anonymous') {
      for (const role of anonymousRoles) groups.push(DEFAULT_PERMISSIONS[role]);
    } else {
      if (!result.rows[0].found_subject) return Object.freeze({ allows: permission => { validatePermission(permission); return false; } });
      for (const role of anonymousRoles) groups.push(DEFAULT_PERMISSIONS[role]);
      for (const row of result.rows) {
        if (row.role_name === null) continue;
        if (row.found_role !== row.role_name) throw failure('TENANT_AUTHORITY_INVALID');
        groups.push(row.permissions);
      }
    }
    for (const group of groups) tries.push(permissionTrie(group));
    return Object.freeze({ allows (permission) {
      validatePermission(permission);
      return (principal.kind !== 'anonymous' || anonymousMayUse(permission)) && tries.some(trie => trie.check(permission));
    } });
  }

  return Object.freeze({
    async subjectSnapshot ({ tenant: rawTenant, principal: rawPrincipal } = {}) {
      const tenant = identifier(rawTenant, 'tenant');
      const principal = validatePrincipal(rawPrincipal);
      if (principal.kind !== 'subject') return null;
      let result;
      try {
        result = await connection.withTenant(tenant, () => connection.query(`
          SELECT c.anonymous_roles, s.subject_id, s.display_name,
            l.role_name, r.name AS found_role, r.permissions
          FROM ${config} c
          LEFT JOIN ${subjects} s ON s.tenant_id = c.tenant_id AND s.subject_id = $2
          LEFT JOIN ${links} l ON l.tenant_id = s.tenant_id AND l.subject_id = s.subject_id
          LEFT JOIN ${roles} r ON r.tenant_id = l.tenant_id AND r.name = l.role_name
          WHERE c.tenant_id = $1 ORDER BY l.role_name`, [tenant, principal.subjectId]));
      } catch {
        throw failure('TENANT_AUTHORITY_UNAVAILABLE');
      }
      if (!result.rows.length) throw failure('TENANT_AUTHORITY_UNKNOWN');
      const first = result.rows[0];
      if (!first.subject_id || typeof first.display_name !== 'string' || !first.display_name.trim()) return null;
      if (!Array.isArray(first.anonymous_roles) || first.anonymous_roles.length > 3 ||
          first.anonymous_roles.some(role => !DEFAULT_ROLES.has(role)) ||
          new Set(first.anonymous_roles).size !== first.anonymous_roles.length ||
          result.rows.some(row => row.subject_id !== first.subject_id || row.display_name !== first.display_name ||
            JSON.stringify(row.anonymous_roles) !== JSON.stringify(first.anonymous_roles))) {
        throw failure('TENANT_AUTHORITY_INVALID');
      }
      const groups = new Map();
      for (const row of result.rows) {
        if (row.role_name === null) continue;
        if (row.found_role !== row.role_name) throw failure('TENANT_AUTHORITY_INVALID');
        permissionTrie(row.permissions);
        groups.set(row.role_name, Object.freeze(row.permissions.slice()));
      }
      for (const role of first.anonymous_roles) {
        if (!groups.has(role)) groups.set(role, DEFAULT_PERMISSIONS[role]);
      }
      return Object.freeze({ sub: first.display_name, permissionGroups: Object.freeze([...groups.values()]) });
    },
    permissionSnapshot,
    async authorize ({ tenant: rawTenant, principal: rawPrincipal, permission } = {}) {
      const tenant = identifier(rawTenant, 'tenant'), principal = validatePrincipal(rawPrincipal);
      validatePermission(permission);
      return (await permissionSnapshot({ tenant, principal })).allows(permission);
    },
    async close () {
      try { await connection.end(); } catch { throw failure('TENANT_AUTHORITY_UNAVAILABLE'); }
    }
  });
};
