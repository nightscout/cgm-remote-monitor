'use strict';

const { createHash } = require('node:crypto');

const NAME = /^[a-zA-Z0-9_-]{1,128}$/;
const domains = require('../server/tenant-app/domain-catalogue');
const { permissionsValid, permissionsContained } = require('./permission-implication');

// Compatibility inventory for existing probes; never an authority boundary.
const TERMINAL_OPERATIONS = Object.freeze(domains.names.flatMap(name =>
  ['create', 'read', 'update', 'delete', 'admin'].map(action => 'api:' + name + ':' + action))
  .concat(['api:status:read', 'admin:api:permissions:read']));

function forbidden () {
  throw Object.assign(new Error('SUBJECT_ADMIN_FORBIDDEN'), { code: 'SUBJECT_ADMIN_FORBIDDEN' });
}

function catalogueDigest (catalogue) {
  if (!permissionsValid(catalogue, true)) throw new TypeError('Owner catalogue requires distinct Shiro permissions');
  return createHash('sha256').update(JSON.stringify(catalogue.slice().sort())).digest('hex');
}

// plane 'owner': an active owner actor row supplies authority and delegation.
// plane 'root': the tenant's root secret (single-site API_SECRET parity) supplies
// authority without an actor row; its delegation is the operator ceiling. Root
// never reads or locks owner actor rows here, so it has no owner authority.
function createOwnerPolicy ({ namespace, catalogue, plane = 'owner' }) {
  if (!['owner', 'root'].includes(plane)) throw new TypeError('Owner policy requires an explicit owner or root plane');
  if (typeof namespace !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(namespace) ||
      namespace === 'public' || namespace === 'information_schema' || namespace.startsWith('pg_')) {
    throw new TypeError('Owner policy requires an explicit non-system namespace');
  }
  const digest = catalogueDigest(catalogue);
  const project = catalogue.slice();
  const prefix = '"' + namespace + '".';
  const config = prefix + 'tenant_authorization_config';
  const roles = prefix + 'tenant_authorization_roles';
  const policy = prefix + 'tenant_owner_policy';
  const actors = prefix + 'tenant_owner_actors';

  async function assertPrivileges (connection) {
    const result = await connection.query(`SELECT c.relrowsecurity AND c.relforcerowsecurity AS secured,
      pg_has_role(current_user,c.relowner,'MEMBER') AS owns,
      has_table_privilege(c.oid,'SELECT') AS reads,
      has_table_privilege(c.oid,'INSERT') AS inserts,
      has_any_column_privilege(c.oid,'INSERT') AS column_inserts, c.oid::regclass::text AS name,
      has_table_privilege(c.oid,'UPDATE,TRUNCATE,TRIGGER,REFERENCES') OR
        has_any_column_privilege(c.oid,'REFERENCES') AS mutates,
      has_table_privilege(c.oid,'DELETE') AS deletes,
      ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0
        AND NOT a.attisdropped AND has_column_privilege(c.oid,a.attnum,'UPDATE') ORDER BY a.attnum) AS update_columns
      FROM pg_class c WHERE c.oid=ANY($1::regclass[])`, [[config, roles, policy, actors]]);
    // Root never locks actor rows: its identity reads them (last-owner guard) and
    // holds no UPDATE column on them; every other fenced table keeps owner_fence.
    // Root alone edits role permissions and deletes unheld roles.
    const fence = row => plane !== 'root' ? ['owner_fence'] : row.name === actors.replaceAll('"', '') ? []
      : row.name === roles.replaceAll('"', '') ? ['permissions', 'owner_fence'] : ['owner_fence'];
    const deletes = row => plane === 'root' && row.name === roles.replaceAll('"', '');
    if (result.rows.length !== 4 || result.rows.some(row => !row.secured || row.owns || !row.reads || row.mutates ||
        row.deletes !== deletes(row) ||
        row.inserts !== (row.name === roles.replaceAll('"', '')) || row.column_inserts !== row.inserts ||
        !Array.isArray(row.update_columns) || JSON.stringify(row.update_columns) !== JSON.stringify(fence(row)))) {
      throw Object.assign(new Error('SUBJECT_ADMIN_STORE_UNSAFE'), { code: 'SUBJECT_ADMIN_STORE_UNSAFE' });
    }
  }

  async function authority (connection, actor) {
    if (['principal', 'consumer'].some(key => typeof actor[key] !== 'string' || !NAME.test(actor[key]))) forbidden();
    // Row SHARE locks fence raw operator UPDATE/DELETE, not just cooperating app calls.
    // Keep this order ahead of target subject/credential locks on every proposal.
    const defaults = (await connection.query('SELECT anonymous_roles FROM ' + config +
      ' WHERE tenant_id=$1 FOR SHARE', [actor.tenant])).rows[0];
    const currentPolicy = (await connection.query('SELECT catalogue_digest,ceiling FROM ' + policy +
      ' WHERE tenant_id=$1 FOR SHARE', [actor.tenant])).rows[0];
    const currentActor = plane === 'root'
      ? (currentPolicy ? { active: true, can_update: true, delegable: currentPolicy.ceiling } : undefined)
      : (await connection.query('SELECT active,can_update,delegable FROM ' + actors +
        ' WHERE tenant_id=$1 AND principal=$2 AND consumer=$3 FOR SHARE',
      [actor.tenant, actor.principal, actor.consumer])).rows[0];
    if (!defaults || !currentPolicy || !currentActor || currentPolicy.catalogue_digest !== digest ||
        currentActor.active !== true || currentActor.can_update !== true ||
        !permissionsValid(currentPolicy.ceiling) || !permissionsValid(currentActor.delegable) ||
        !Array.isArray(defaults.anonymous_roles) || defaults.anonymous_roles.length > 3 ||
        new Set(defaults.anonymous_roles).size !== defaults.anonymous_roles.length ||
        defaults.anonymous_roles.some(role => !['denied', 'readable', 'status-only'].includes(role))) forbidden();
    return { defaults, ceiling: currentPolicy.ceiling, delegation: currentActor.delegable };
  }

  function assertContained (permissions, current) {
    if (!permissionsValid(permissions) || !permissionsContained(permissions, project) ||
        !permissionsContained(permissions, current.ceiling) ||
        !permissionsContained(permissions, current.delegation)) forbidden();
  }

  async function authorizePermissions (connection, actor, permissions) {
    const current = await authority(connection, actor);
    assertContained(permissions, current);
  }

  async function authorizeUpdate (connection, actor, subjectId, value) {
    const current = await authority(connection, actor);
    const proposed = await connection.query('SELECT name,permissions FROM ' + roles +
      ' WHERE tenant_id=$1 AND name=ANY($2::text[]) ORDER BY name FOR SHARE', [actor.tenant, value.roles]);
    if (proposed.rows.length !== value.roles.length) {
      throw Object.assign(new Error('SUBJECT_ADMIN_UNKNOWN_ROLE'), { code: 'SUBJECT_ADMIN_UNKNOWN_ROLE' });
    }
    const effective = new Set(current.defaults.anonymous_roles.includes('status-only') ? ['api:status:read'] : []);
    for (const role of proposed.rows) {
      if (!permissionsValid(role.permissions)) forbidden();
      for (const permission of role.permissions) effective.add(permission);
    }
    // Anonymous defaults are not delegated subject grants: readable remains
    // read-clamped by the data reader, even if its stored role is corrupted.
    // A status-only default retains the existing explicit status requirement.
    assertContained([...effective], current);
  }

  return Object.freeze({ plane, assertPrivileges, authorizeUpdate, authorizePermissions });
}

module.exports = { createOwnerPolicy, catalogueDigest, TERMINAL_OPERATIONS, permissionsValid, permissionsContained };
