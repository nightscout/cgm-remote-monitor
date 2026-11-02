'use strict';

const { randomUUID } = require('node:crypto');
const postgresConnection = require('../storage/postgres-connection');
const tenantScope = require('../storage/tenant-scope');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = /^[a-zA-Z0-9_-]{1,128}$/;
const OPERATIONS = ['encrypt', 'decrypt', 'reveal', 'sign', 'verify', 'rewrap'];

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

async function connectPersistence ({ connectionString, namespace }, maintenance) {
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
             ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid = c.oid
               AND a.attnum > 0 AND NOT a.attisdropped
               AND has_column_privilege(c.oid, a.attnum, 'UPDATE') ORDER BY a.attname) AS update_columns,
             has_any_column_privilege(c.oid, 'SELECT') AS column_reads,
             c.oid = to_regclass($1) AS is_records
      FROM pg_class c WHERE c.oid IN (to_regclass($1), to_regclass($2))`, [records, auditTable]);
    if (state.rows.length !== 2 || state.rows.some(row =>
      !row.secured || row.owns || row.inserts !== (!maintenance || !row.is_records) ||
      row.mutates || row.reads !== row.is_records || row.column_reads !== row.is_records ||
      JSON.stringify(row.update_columns) !== JSON.stringify(maintenance && row.is_records ? ['ciphertext'] : []))) {
      throw failure('SECRETS_STORE_UNSAFE');
    }
  } catch (error) {
    try { await connection.end(); } catch { throw failure('SECRETS_STORE_UNAVAILABLE'); }
    throw error;
  }

  const store = {
    async get (tenant, id) {
      tenantId(tenant);
      identity(id);
      const result = await query(tenant, 'SELECT tenant_id AS tenant, id, format, ciphertext FROM ' +
        records + ' WHERE tenant_id = $1 AND id = $2', [tenant, id]);
      return result.rows[0];
    }
  };
  if (maintenance) {
    store.compareAndSwapCiphertext = async function (tenant, id, expected, replacement) {
      tenantId(tenant);
      identity(id);
      for (const value of [expected, replacement]) {
        if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > 1048576) {
          throw new TypeError('Invalid encrypted secrets record');
        }
      }
      const result = await query(tenant, 'UPDATE ' + records +
        ' SET ciphertext = $4 WHERE tenant_id = $1 AND id = $2 AND ciphertext = $3',
      [tenant, id, expected, replacement]);
      return result.rowCount === 1;
    };
  } else {
    store.insert = async function (record) {
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
    };
  }
  return Object.freeze({
    store: Object.freeze(store),
    async audit (event) {
      fields(event, ['tenant', 'principal', 'consumer', 'operation', 'phase', 'time'], ['id', 'targetVersion']);
      tenantId(event.tenant);
      identity(event.principal);
      identity(event.consumer);
      if (event.id !== undefined) identity(event.id);
      const needsId = ['encrypt', 'decrypt', 'reveal', 'rewrap'].includes(event.operation);
      const validVersion = Number.isSafeInteger(event.targetVersion) && event.targetVersion > 0;
      if (!OPERATIONS.includes(event.operation) || event.phase !== 'authorized' ||
          !Number.isSafeInteger(event.time) || event.time < 0 || needsId !== (event.id !== undefined) ||
          (event.operation === 'rewrap' ? !validVersion : event.targetVersion !== undefined)) {
        throw new TypeError('Invalid secrets audit event');
      }
      await query(event.tenant, 'INSERT INTO ' + auditTable +
        ' (event_id, tenant_id, principal, consumer, operation, secret_id, phase, event_time, target_version) ' +
        'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [randomUUID(), event.tenant, event.principal, event.consumer, event.operation,
        event.id === undefined ? null : event.id, event.phase, event.time,
        event.targetVersion === undefined ? null : event.targetVersion]);
    },
    async close () {
      try { await connection.end(); } catch { throw failure('SECRETS_STORE_UNAVAILABLE'); }
    }
  });
}

module.exports = {
  createPostgresSecrets: options => connectPersistence(options, false),
  createPostgresSecretsMaintenance: options => connectPersistence(options, true)
};
