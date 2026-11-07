'use strict';

const { createHash } = require('node:crypto');

const NAME = /^[a-zA-Z0-9_-]{1,128}$/;
const domains = require('../server/tenant-app/domain-catalogue');
const shiro = require('shiro-trie');

// This bounded REST universe mirrors rest-context's requested operations. Adding
// domains/actions or deeper permission checks requires reviewing this boundary.
const TERMINAL_OPERATIONS = Object.freeze(domains.names.flatMap(name =>
  ['create', 'read', 'update', 'delete', 'admin'].map(action => 'api:' + name + ':' + action))
  .concat(['api:status:read', 'admin:api:permissions:read']));
const terminals = new Set(TERMINAL_OPERATIONS);
let universeChecked = false;

function assertTerminalUniverse () {
  if (universeChecked) return;
  if (terminals.size !== TERMINAL_OPERATIONS.length || TERMINAL_OPERATIONS.some(grant =>
    grant.split(':').length < 2 || grant.split(':').some(segment => !/^[a-zA-Z0-9_-]+$/.test(segment)) ||
    TERMINAL_OPERATIONS.some(operation => operation.startsWith(grant + ':')))) {
    throw new TypeError('Owner operation universe must be distinct and prefix-free');
  }
  for (const grant of TERMINAL_OPERATIONS) {
    const trie = shiro.new();
    trie.add(grant);
    if (TERMINAL_OPERATIONS.some(operation => trie.check(operation) !== (operation === grant))) {
      throw new TypeError('Owner operation universe has nonterminal Shiro implications');
    }
  }
  universeChecked = true;
}

function forbidden () {
  throw Object.assign(new Error('SUBJECT_ADMIN_FORBIDDEN'), { code: 'SUBJECT_ADMIN_FORBIDDEN' });
}

function concretePermissions (values, nonempty = false) {
  return Array.isArray(values) && values.length <= 256 && (!nonempty || values.length > 0) &&
    new Set(values).size === values.length && values.every(value => terminals.has(value));
}

function catalogueDigest (catalogue) {
  assertTerminalUniverse();
  if (!concretePermissions(catalogue, true)) throw new TypeError('Owner catalogue requires distinct reviewed terminal permissions');
  return createHash('sha256').update(JSON.stringify(catalogue.slice().sort())).digest('hex');
}

function createOwnerPolicy ({ namespace, catalogue }) {
  if (typeof namespace !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(namespace) ||
      namespace === 'public' || namespace === 'information_schema' || namespace.startsWith('pg_')) {
    throw new TypeError('Owner policy requires an explicit non-system namespace');
  }
  const digest = catalogueDigest(catalogue);
  const project = new Set(catalogue.slice());
  const prefix = '"' + namespace + '".';
  const config = prefix + 'tenant_authorization_config';
  const roles = prefix + 'tenant_authorization_roles';
  const policy = prefix + 'tenant_owner_policy';
  const actors = prefix + 'tenant_owner_actors';

  async function assertPrivileges (connection) {
    const result = await connection.query(`SELECT c.relrowsecurity AND c.relforcerowsecurity AS secured,
      pg_has_role(current_user,c.relowner,'MEMBER') AS owns,
      has_table_privilege(c.oid,'SELECT') AS reads,
      has_table_privilege(c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') OR
        has_any_column_privilege(c.oid,'INSERT,REFERENCES') AS mutates,
      ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0
        AND NOT a.attisdropped AND has_column_privilege(c.oid,a.attnum,'UPDATE') ORDER BY a.attnum) AS update_columns
      FROM pg_class c WHERE c.oid=ANY($1::regclass[])`, [[config, roles, policy, actors]]);
    if (result.rows.length !== 4 || result.rows.some(row => !row.secured || row.owns || !row.reads || row.mutates ||
        !Array.isArray(row.update_columns) || row.update_columns.length !== 1 || row.update_columns[0] !== 'owner_fence')) {
      throw Object.assign(new Error('SUBJECT_ADMIN_STORE_UNSAFE'), { code: 'SUBJECT_ADMIN_STORE_UNSAFE' });
    }
  }

  async function authorizeUpdate (connection, actor, subjectId, value) {
    if (['principal', 'consumer'].some(key => typeof actor[key] !== 'string' || !NAME.test(actor[key]))) forbidden();
    // Row SHARE locks fence raw operator UPDATE/DELETE, not just cooperating app calls.
    // Keep this order ahead of target subject/credential locks on every proposal.
    const defaults = (await connection.query('SELECT anonymous_roles FROM ' + config +
      ' WHERE tenant_id=$1 FOR SHARE', [actor.tenant])).rows[0];
    const currentPolicy = (await connection.query('SELECT catalogue_digest,ceiling FROM ' + policy +
      ' WHERE tenant_id=$1 FOR SHARE', [actor.tenant])).rows[0];
    const currentActor = (await connection.query('SELECT active,can_update,delegable FROM ' + actors +
      ' WHERE tenant_id=$1 AND principal=$2 AND consumer=$3 FOR SHARE',
    [actor.tenant, actor.principal, actor.consumer])).rows[0];
    if (!defaults || !currentPolicy || !currentActor || currentPolicy.catalogue_digest !== digest ||
        currentActor.active !== true || currentActor.can_update !== true ||
        !concretePermissions(currentPolicy.ceiling) || !concretePermissions(currentActor.delegable) ||
        !Array.isArray(defaults.anonymous_roles) || defaults.anonymous_roles.length > 3 ||
        new Set(defaults.anonymous_roles).size !== defaults.anonymous_roles.length ||
        defaults.anonymous_roles.some(role => !['denied', 'status-only'].includes(role))) forbidden();
    const proposed = await connection.query('SELECT name,permissions FROM ' + roles +
      ' WHERE tenant_id=$1 AND name=ANY($2::text[]) ORDER BY name FOR SHARE', [actor.tenant, value.roles]);
    if (proposed.rows.length !== value.roles.length) {
      throw Object.assign(new Error('SUBJECT_ADMIN_UNKNOWN_ROLE'), { code: 'SUBJECT_ADMIN_UNKNOWN_ROLE' });
    }
    const effective = new Set(defaults.anonymous_roles.includes('status-only') ? ['api:status:read'] : []);
    for (const role of proposed.rows) {
      if (!concretePermissions(role.permissions)) forbidden();
      for (const permission of role.permissions) effective.add(permission);
    }
    const ceiling = new Set(currentPolicy.ceiling);
    const delegation = new Set(currentActor.delegable);
    for (const permission of effective) {
      if (!project.has(permission)) forbidden();
      if (!ceiling.has(permission)) forbidden();
      if (!delegation.has(permission)) forbidden();
    }
  }

  return Object.freeze({ assertPrivileges, authorizeUpdate });
}

module.exports = { createOwnerPolicy, catalogueDigest, TERMINAL_OPERATIONS };
