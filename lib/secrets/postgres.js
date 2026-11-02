'use strict';

const { randomUUID } = require('node:crypto');
const postgresConnection = require('../storage/postgres-connection');
const tenantScope = require('../storage/tenant-scope');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = /^[a-zA-Z0-9_-]{1,128}$/;
const OPERATIONS = ['encrypt', 'decrypt', 'reveal', 'sign', 'verify'];

function failure (code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function tenantId (tenant) {
  if (typeof tenant !== 'string' || !UUID.test(tenant)) throw new TypeError('Secrets PostgreSQL tenants must be canonical UUIDs');
  return tenant;
}

function identity (value) {
  if (typeof value !== 'string' || !NAME.test(value)) throw new TypeError('Invalid secrets identity');
  return value;
}

function fields (value, required, optional = []) {
  if (!value || required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new TypeError('Invalid secrets persistence record fields');
  }
}

async function createPostgresSecrets ({ connectionString, namespace }) {
  if (tenantScope.getTenancyMode() !== 'multi') throw new TypeError('Secrets PostgreSQL persistence requires explicit multi mode');
  if (typeof namespace !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(namespace) ||
      namespace === 'public' || namespace.startsWith('pg_') || namespace === 'information_schema') {
    throw new TypeError('Secrets require an explicit non-system schema');
  }
  // Private pool: no caller can nest audit writes in a transaction that has not committed.
  let connection;
  try {
    connection = await postgresConnection({
      connectionString, max: 4, connectionTimeoutMillis: 5000, statement_timeout: 5000,
      application_name: 'nightscout-secrets'
    });
  } catch { throw failure('SECRETS_STORE_UNAVAILABLE'); }
  const records = '"' + namespace + '".secret_records';
  const auditTable = '"' + namespace + '".secret_audit';

  async function query (tenant, text, values, duplicateCode) {
    try {
      return await connection.withTenant(tenant, async () => {
        await connection.query("SET LOCAL synchronous_commit = 'on'");
        return connection.query(text, values);
      });
    } catch (error) {
      // Driver detail can contain ciphertext or credentials; never propagate it.
      if (error.code === '23505' && duplicateCode) throw failure(duplicateCode);
      throw failure('SECRETS_STORE_UNAVAILABLE');
    }
  }

  try {
    const state = await query('00000000-0000-0000-0000-000000000000', `
      SELECT c.relrowsecurity AND c.relforcerowsecurity AS secured,
             pg_has_role(current_user, c.relowner, 'MEMBER') AS owns,
             has_table_privilege(c.oid, 'INSERT') AS inserts,
             has_table_privilege(c.oid, 'SELECT') AS reads,
             has_table_privilege(c.oid, 'UPDATE') OR has_table_privilege(c.oid, 'DELETE')
               OR has_table_privilege(c.oid, 'TRUNCATE') OR has_table_privilege(c.oid, 'TRIGGER')
               OR has_table_privilege(c.oid, 'REFERENCES') AS mutates,
             c.oid = to_regclass($1) AS is_records
      FROM pg_class c WHERE c.oid IN (to_regclass($1), to_regclass($2))`, [records, auditTable]);
    if (state.rows.length !== 2 || state.rows.some(row =>
      !row.secured || row.owns || !row.inserts || row.mutates || row.reads !== row.is_records)) {
      throw failure('SECRETS_STORE_UNSAFE');
    }
  } catch (error) {
    try { await connection.end(); } catch { throw failure('SECRETS_STORE_UNAVAILABLE'); }
    throw error;
  }

  return Object.freeze({
    store: Object.freeze({
      async insert (record) {
        fields(record, ['format', 'tenant', 'id', 'ciphertext']);
        tenantId(record.tenant);
        identity(record.id);
        if (record.format !== 1 || typeof record.ciphertext !== 'string' ||
            !record.ciphertext.length || Buffer.byteLength(record.ciphertext) > 1048576) {
          throw new TypeError('Invalid encrypted secrets record');
        }
        await query(record.tenant, 'INSERT INTO ' + records +
          ' (tenant_id, id, format, ciphertext) VALUES ($1, $2, $3, $4)',
        [record.tenant, record.id, record.format, record.ciphertext], 'SECRETS_REFERENCE_EXISTS');
      },
      async get (tenant, id) {
        tenantId(tenant);
        identity(id);
        const result = await query(tenant, 'SELECT tenant_id AS tenant, id, format, ciphertext FROM ' +
          records + ' WHERE tenant_id = $1 AND id = $2', [tenant, id]);
        return result.rows[0];
      }
    }),
    async audit (event) {
      fields(event, ['tenant', 'principal', 'consumer', 'operation', 'phase', 'time'], ['id']);
      tenantId(event.tenant);
      identity(event.principal);
      identity(event.consumer);
      if (event.id !== undefined) identity(event.id);
      const needsId = ['encrypt', 'decrypt', 'reveal'].includes(event.operation);
      if (!OPERATIONS.includes(event.operation) || event.phase !== 'authorized' ||
          !Number.isSafeInteger(event.time) || event.time < 0 || needsId !== (event.id !== undefined)) {
        throw new TypeError('Invalid secrets audit event');
      }
      await query(event.tenant, 'INSERT INTO ' + auditTable +
        ' (event_id, tenant_id, principal, consumer, operation, secret_id, phase, event_time) ' +
        'VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [randomUUID(), event.tenant, event.principal, event.consumer, event.operation,
        event.id === undefined ? null : event.id, event.phase, event.time]);
    },
    async close () {
      try { await connection.end(); } catch { throw failure('SECRETS_STORE_UNAVAILABLE'); }
    }
  });
}

module.exports = { createPostgresSecrets };
