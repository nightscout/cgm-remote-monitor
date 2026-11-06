'use strict';

const connect = require('../storage/postgres-connection');
const scope = require('../storage/tenant-scope');
const shiro = require('shiro-trie');
const DEFAULTS = Object.freeze({ denied: [], readable: ['*:*:read'], 'status-only': ['api:status:read'] });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = /^[A-Za-z0-9_-]{1,128}$/;
const fail = code => Object.assign(new Error(code), { code });

module.exports = async function createAccessAuthority ({ connectionString, namespace, authorityNamespace }) {
  const valid = name => typeof name === 'string' && /^[a-z][a-z0-9_]{0,62}$/.test(name) &&
    name !== 'public' && name !== 'information_schema' && !name.startsWith('pg_');
  if (scope.getTenancyMode() !== 'multi' || !valid(namespace) || !valid(authorityNamespace) || namespace === authorityNamespace) {
    throw new TypeError('Local access requires distinct explicit multitenant namespaces');
  }
  const connection = await connect({ connectionString, max: 4, connectionTimeoutMillis: 1000,
    statement_timeout: 1000, query_timeout: 1000, application_name: 'nightscout-current-access' });
  const tables = ['tenants', 'credentials', 'sessions', 'keys'].map(t => '"' + namespace + '".access_' + t);
  const authority = ['config', 'subjects', 'subject_roles', 'roles'].map(t => '"' + authorityNamespace + '".tenant_authorization_' + t);
  try {
    const state = await connection.withTenant('00000000-0000-0000-0000-000000000000', () => connection.query(`SELECT c.relrowsecurity AND c.relforcerowsecurity AS secured,
      pg_has_role(current_user,c.relowner,'MEMBER') AS owns,
      has_table_privilege(c.oid,'SELECT') AS reads,
      has_table_privilege(c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') OR
      has_any_column_privilege(c.oid,'INSERT,UPDATE,REFERENCES') AS writes
      FROM pg_class c WHERE c.oid=ANY($1::regclass[])`, [tables.concat(authority)]));
    if (state.rows.length !== 8 || state.rows.some(row => !row.secured || row.owns || !row.reads || row.writes)) {
      throw fail('ACCESS_AUTHORITY_UNSAFE');
    }
  } catch (error) { await connection.end(); throw fail(error.code === 'ACCESS_AUTHORITY_UNSAFE' ? error.code : 'ACCESS_AUTHORITY_UNAVAILABLE'); }

  return Object.freeze({
    async snapshot (claims) {
      if (!claims || !UUID.test(claims.tid) || ![claims.sub, claims.sid, claims.kid].every(v => typeof v === 'string' && NAME.test(v)) ||
          !['data', 'management'].includes(claims.purpose)) throw fail('ACCESS_AUTHORITY_INVALID');
      let result;
      try {
        result = await connection.withTenant(claims.tid, () => connection.query(`SELECT
          t.active, c.enabled AS credential_enabled, c.generation,
          s.active AS session_active, s.generation AS session_generation, s.expires_at,
          k.active AS key_active, a.display_name, cfg.anonymous_roles,
          l.role_name, r.name AS found_role, r.permissions
          FROM ${tables[0]} t
          JOIN ${tables[2]} s ON s.tenant_id=t.tenant_id AND s.session_id=$3 AND s.subject_id=$2 AND s.purpose=$5
          JOIN ${tables[1]} c ON c.tenant_id=s.tenant_id AND c.credential_id=s.credential_id AND c.subject_id=s.subject_id
          JOIN ${tables[3]} k ON k.tenant_id=t.tenant_id AND k.kid=$4 AND k.purpose=s.purpose
          JOIN ${authority[0]} cfg ON cfg.tenant_id=t.tenant_id
          JOIN ${authority[1]} a ON a.tenant_id=t.tenant_id AND a.subject_id=s.subject_id
          LEFT JOIN ${authority[2]} l ON l.tenant_id=a.tenant_id AND l.subject_id=a.subject_id
          LEFT JOIN ${authority[3]} r ON r.tenant_id=l.tenant_id AND r.name=l.role_name
          WHERE t.tenant_id=$1 ORDER BY l.role_name`, [claims.tid, claims.sub, claims.sid, claims.kid, claims.purpose]));
      } catch { throw fail('ACCESS_AUTHORITY_UNAVAILABLE'); }
      if (!result.rows.length) return null;
      const first = result.rows[0];
      if (!Number.isSafeInteger(Number(first.expires_at))) throw fail('ACCESS_AUTHORITY_INVALID');
      if (typeof first.display_name !== 'string' || !first.display_name.trim() || !Array.isArray(first.anonymous_roles) ||
          first.anonymous_roles.some(role => !Object.hasOwn(DEFAULTS, role))) throw fail('ACCESS_AUTHORITY_INVALID');
      const groups = first.anonymous_roles.map(role => DEFAULTS[role]);
      for (const row of result.rows) {
        if (row.role_name === null) continue;
        if (row.found_role !== row.role_name || !Array.isArray(row.permissions) || row.permissions.length > 256 ||
            row.permissions.some(p => typeof p !== 'string' || !p || p.length > 512 || p.split('').some(c => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127))) {
          throw fail('ACCESS_AUTHORITY_INVALID');
        }
        groups.push(row.permissions);
      }
      const tries = groups.map(group => { const trie = shiro.new(); trie.add(group); return trie; });
      return Object.freeze({ active: first.active && first.credential_enabled,
        sessionActive: first.session_active && first.session_generation === first.generation,
        keyActive: first.key_active, credentialVersion: first.generation,
        sessionExpiresAt: Number(first.expires_at), name: first.display_name,
        permissionGroups: Object.freeze(groups.map(group => Object.freeze(group.slice()))),
        allows: permission => tries.some(trie => trie.check(permission)) });
    },
    close () { return connection.end(); }
  });
};
