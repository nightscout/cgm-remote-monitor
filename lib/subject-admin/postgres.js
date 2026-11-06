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
    throw new TypeError('Owner policy requires an explicit concrete catalogue');
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
      if (['SUBJECT_ADMIN_UNKNOWN_ROLE', 'SUBJECT_ADMIN_METADATA_MISSING', 'SUBJECT_ADMIN_FORBIDDEN'].includes(error.code)) throw error;
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
    const expected = new Map([[subjects.replaceAll('"', ''), [true, false, true, true]],
      [roles.replaceAll('"', ''), [true, false, false, false]],
      [links.replaceAll('"', ''), [true, true, false, true]],
      [credentials.replaceAll('"', ''), [true, false, true, true]],
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
      if (owner) throw failure('SUBJECT_ADMIN_FORBIDDEN');
      return transaction(actor.tenant, async () => {
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
