'use strict';

const { randomUUID } = require('node:crypto');
const postgresConnection = require('../storage/postgres-connection');
const scope = require('../storage/tenant-scope');
const subjectUpdate = require('./update');
const { createOwnerPolicy } = require('./owner-policy');

function failure (code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function validNamespace (value) {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,62}$/.test(value) &&
    value !== 'public' && !value.startsWith('pg_') && value !== 'information_schema';
}

module.exports = async function createPostgresSubjectAdmin ({ connectionString, namespace, credentialNamespace, ownerPolicy }) {
  if (scope.getTenancyMode() !== 'multi' || !validNamespace(namespace) || !validNamespace(credentialNamespace)) {
    throw new TypeError('Subject management requires explicit multi mode and non-system namespaces');
  }
  if (ownerPolicy !== undefined && (!ownerPolicy || typeof ownerPolicy !== 'object' ||
      Array.isArray(ownerPolicy) || Object.keys(ownerPolicy).some(key => key !== 'catalogue'))) {
    throw new TypeError('Owner policy requires an explicit catalogue');
  }
  const owner = ownerPolicy === undefined ? null : createOwnerPolicy({ namespace, catalogue: ownerPolicy.catalogue });
  let connection;
  try {
    connection = await postgresConnection({ connectionString, max: 4, connectionTimeoutMillis: 5000,
      statement_timeout: 5000, query_timeout: 5000, application_name: 'nightscout-subject-admin' });
  } catch { throw failure('SUBJECT_ADMIN_STORE_UNAVAILABLE'); }
  const subjects = '"' + namespace + '".tenant_authorization_subjects';
  const roles = '"' + namespace + '".tenant_authorization_roles';
  const links = '"' + namespace + '".tenant_authorization_subject_roles';
  const credentials = '"' + credentialNamespace + '".legacy_credential_subjects';
  const audit = '"' + namespace + '".tenant_subject_admin_audit';
  const actors = '"' + namespace + '".tenant_owner_actors';
  async function transaction (tenant, fn) {
    if (typeof tenant !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tenant)) {
      throw new TypeError('Subject management requires canonical UUID tenant');
    }
    try {
      return await connection.withTenant(tenant, async () => {
        await connection.query("SET LOCAL synchronous_commit = 'on'");
        return fn();
      });
    } catch (error) {
      if (['SUBJECT_ADMIN_UNKNOWN_ROLE', 'SUBJECT_ADMIN_METADATA_MISSING', 'SUBJECT_ADMIN_FORBIDDEN', 'SUBJECT_ADMIN_NOT_FOUND', 'SUBJECT_ADMIN_CONFLICT', 'SUBJECT_ADMIN_LAST_OWNER'].includes(error.code)) throw error;
      if (error.code === '23505') throw failure('SUBJECT_ADMIN_CONFLICT');
      throw failure('SUBJECT_ADMIN_STORE_UNAVAILABLE');
    }
  }
  try {
    const result = await transaction('00000000-0000-0000-0000-000000000000', () => connection.query(`
      SELECT c.relrowsecurity AND c.relforcerowsecurity AS secured,
        pg_has_role(current_user, c.relowner, 'MEMBER') AS owns,
        has_table_privilege(c.oid, 'SELECT') AS reads,
        has_table_privilege(c.oid, 'INSERT') AS inserts,
        has_table_privilege(c.oid, 'UPDATE') AS updates,
        has_table_privilege(c.oid, 'DELETE') AS deletes,
        has_table_privilege(c.oid, 'TRUNCATE,TRIGGER,REFERENCES') OR
          has_any_column_privilege(c.oid, 'REFERENCES') AS unsafe,
        has_any_column_privilege(c.oid, 'SELECT') AS column_reads,
        has_any_column_privilege(c.oid, 'INSERT') AS column_inserts,
        has_any_column_privilege(c.oid, 'UPDATE') AS column_updates,
        c.oid::regclass::text AS name
      FROM pg_class c WHERE c.oid IN (to_regclass($1), to_regclass($2), to_regclass($3),
        to_regclass($4), to_regclass($5))`, [subjects, roles, links, credentials, audit]));
    const expected = new Map([[subjects.replaceAll('"', ''), [true, !!owner, true, true]],
      [roles.replaceAll('"', ''), [true, !!owner, false, false]],
      [links.replaceAll('"', ''), [true, true, false, true]],
      [credentials.replaceAll('"', ''), [true, !!owner, true, true]],
      [audit.replaceAll('"', ''), [false, true, false, false]]]);
    if (result.rows.length !== 5 || result.rows.some(row => {
      const privileges = expected.get(row.name);
      return !privileges || !row.secured || row.owns || row.unsafe ||
        [row.reads, row.inserts, row.updates, row.deletes].some((value, index) => value !== privileges[index]) ||
        row.column_reads !== privileges[0] || row.column_inserts !== privileges[1] ||
        row.column_updates !== (owner && row.name === roles.replaceAll('"', '') ? true : privileges[2]);
    })) throw failure('SUBJECT_ADMIN_STORE_UNSAFE');
    if (owner) await transaction('00000000-0000-0000-0000-000000000000', () => owner.assertPrivileges(connection));
  } catch (error) {
    await connection.end();
    if (error.code === 'SUBJECT_ADMIN_STORE_UNSAFE') throw error;
    throw failure('SUBJECT_ADMIN_STORE_UNSAFE');
  }
  async function lock (tenant, subjectId) {
    const result = await connection.query('SELECT display_name, notes, created_at FROM ' + subjects +
      ' WHERE tenant_id = $1 AND subject_id = $2 FOR UPDATE', [tenant, subjectId]);
    if (!result.rows[0]) return undefined;
    const metadata = await connection.query('SELECT subject_id FROM ' + credentials +
      ' WHERE tenant_id = $1 AND subject_id = $2 FOR UPDATE', [tenant, subjectId]);
    if (!metadata.rows[0]) throw failure('SUBJECT_ADMIN_METADATA_MISSING');
    return result.rows[0];
  }
  async function record (actor, subjectId, operation) {
    await connection.query('INSERT INTO ' + audit +
      ' (event_id, tenant_id, principal, consumer, subject_id, operation, event_time) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [randomUUID(), actor.tenant, actor.principal, actor.consumer, subjectId, operation, Date.now()]);
  }
  return Object.freeze({
    async create (actor, value) {
      if (!owner) throw failure('SUBJECT_ADMIN_FORBIDDEN');
      const proposal = subjectUpdate(value), subjectId = randomUUID().replaceAll('-', '');
      return transaction(actor.tenant, async () => {
        await owner.authorizeUpdate(connection, actor, subjectId, proposal);
        const createdAt = proposal.created_at || new Date().toISOString();
        await connection.query('INSERT INTO ' + subjects +
          ' (tenant_id,subject_id,display_name,notes,created_at) VALUES ($1,$2,$3,$4,$5)',
        [actor.tenant, subjectId, proposal.name, proposal.notes ?? null, createdAt]);
        await connection.query('INSERT INTO ' + credentials + ' (tenant_id,subject_id,token_prefix) VALUES ($1,$2,$3)',
          [actor.tenant, subjectId, proposal.name.toLowerCase().replace(/[\W]/g, '').substring(0, 10)]);
        for (const role of proposal.roles) await connection.query('INSERT INTO ' + links +
          ' (tenant_id,subject_id,role_name) VALUES ($1,$2,$3)', [actor.tenant, subjectId, role]);
        await record(actor, subjectId, 'create');
        return { subjectId, ...proposal, created_at: createdAt };
      });
    },
    async createRole (actor, value) {
      if (!owner) throw failure('SUBJECT_ADMIN_FORBIDDEN');
      const { permissionsValid } = require('./owner-policy');
      if (!value || typeof value.name !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.name) ||
          !permissionsValid(value.permissions)) throw new TypeError('Invalid role definition');
      const proposal = { name: value.name, permissions: value.permissions.slice() };
      return transaction(actor.tenant, async () => {
        await owner.authorizePermissions(connection, actor, proposal.permissions);
        await connection.query('INSERT INTO ' + roles + ' (tenant_id,name,permissions) VALUES ($1,$2,$3)',
          [actor.tenant, proposal.name, proposal.permissions]);
        await record(actor, proposal.name, 'create-role');
        return proposal;
      });
    },
    async withCredential (actor, subjectId, issue) {
      if (!owner || typeof issue !== 'function') throw failure('SUBJECT_ADMIN_FORBIDDEN');
      return transaction(actor.tenant, async () => {
        // Lock authority before subject rows, matching assignment/removal lock order.
        await owner.authorizePermissions(connection, actor, []);
        const assigned = await connection.query('SELECT role_name FROM ' + links +
          ' WHERE tenant_id=$1 AND subject_id=$2 ORDER BY role_name', [actor.tenant, subjectId]);
        await owner.authorizeUpdate(connection, actor, subjectId, { roles: assigned.rows.map(row => row.role_name) });
        if (!await lock(actor.tenant, subjectId)) throw failure('SUBJECT_ADMIN_NOT_FOUND');
        // Detect role replacement that committed while authority/role locks were acquired.
        const current = await connection.query('SELECT role_name FROM ' + links +
          ' WHERE tenant_id=$1 AND subject_id=$2 ORDER BY role_name', [actor.tenant, subjectId]);
        if (JSON.stringify(current.rows) !== JSON.stringify(assigned.rows)) throw failure('SUBJECT_ADMIN_CONFLICT');
        await record(actor, subjectId, 'issue');
        return issue();
      });
    },
    async update (actor, subjectId, value) {
      const proposal = owner ? subjectUpdate(value) : value;
      const acting = owner ? { tenant: actor.tenant, principal: actor.principal, consumer: actor.consumer } : actor;
      return transaction(acting.tenant, async () => {
        if (owner) await owner.authorizeUpdate(connection, acting, subjectId, proposal);
        const previous = await lock(acting.tenant, subjectId);
        if (!previous) return undefined;
        if (!owner) {
          const known = await connection.query('SELECT name FROM ' + roles +
            ' WHERE tenant_id = $1 AND name = ANY($2::text[])', [acting.tenant, proposal.roles]);
          if (known.rows.length !== proposal.roles.length) throw failure('SUBJECT_ADMIN_UNKNOWN_ROLE');
        }
        const notes = proposal.notes === undefined ? previous.notes : proposal.notes;
        const createdAt = proposal.created_at || previous.created_at || new Date().toISOString();
        await connection.query('UPDATE ' + subjects +
          ' SET display_name = $3, notes = $4, created_at = $5 WHERE tenant_id = $1 AND subject_id = $2',
        [acting.tenant, subjectId, proposal.name, notes, createdAt]);
        await connection.query('UPDATE ' + credentials +
          ' SET token_prefix = $3 WHERE tenant_id = $1 AND subject_id = $2',
        [acting.tenant, subjectId, proposal.name.toLowerCase().replace(/[\W]/g, '').substring(0, 10)]);
        await connection.query('DELETE FROM ' + links + ' WHERE tenant_id = $1 AND subject_id = $2',
          [acting.tenant, subjectId]);
        for (const role of proposal.roles) {
          await connection.query('INSERT INTO ' + links + ' (tenant_id,subject_id,role_name) VALUES ($1,$2,$3)',
            [acting.tenant, subjectId, role]);
        }
        await record(acting, subjectId, 'update');
        return { subjectId, name: proposal.name, roles: proposal.roles.slice(), notes, created_at: createdAt };
      });
    },
    async remove (actor, subjectId) {
      return transaction(actor.tenant, async () => {
        if (owner) {
          await owner.authorizePermissions(connection, actor, []);
          // Last-owner protection: a usable owner is an active, updating actor
          // whose subject exists. Lock every owner subject in one sorted order
          // before the target, so concurrent revocations serialize here instead
          // of each seeing the other's owner and orphaning the tenant together.
          const owners = new Set((await connection.query('SELECT s.subject_id FROM ' + subjects + ' s JOIN ' + actors +
            ' a ON a.tenant_id = s.tenant_id AND a.principal = s.subject_id WHERE s.tenant_id = $1 AND a.active AND a.can_update' +
            ' ORDER BY s.subject_id FOR UPDATE OF s', [actor.tenant])).rows.map(row => row.subject_id));
          if (owners.has(subjectId) && owners.size === 1) throw failure('SUBJECT_ADMIN_LAST_OWNER');
        }
        if (!await lock(actor.tenant, subjectId)) return false;
        await connection.query('DELETE FROM ' + links + ' WHERE tenant_id = $1 AND subject_id = $2',
          [actor.tenant, subjectId]);
        await connection.query('DELETE FROM ' + credentials + ' WHERE tenant_id = $1 AND subject_id = $2',
          [actor.tenant, subjectId]);
        await connection.query('DELETE FROM ' + subjects + ' WHERE tenant_id = $1 AND subject_id = $2',
          [actor.tenant, subjectId]);
        await record(actor, subjectId, 'remove');
        return true;
      });
    },
    async close () { await connection.end(); }
  });
};
