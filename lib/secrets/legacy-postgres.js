'use strict';

const connect = require('../storage/postgres-connection');
const scope = require('../storage/tenant-scope');

function failure (code) {
  return Object.assign(new Error(code), { code });
}

module.exports = async function createLegacyAuthority ({ connectionString, namespace, localVerification = false }) {
  if (scope.getTenancyMode() !== 'multi' || typeof namespace !== 'string' ||
      !/^[a-z][a-z0-9_]{0,62}$/.test(namespace) || namespace === 'public' ||
      namespace.startsWith('pg_') || namespace === 'information_schema') {
    throw new TypeError('Legacy authority requires multi mode and a non-system namespace');
  }
  const config = '"' + namespace + '".legacy_credential_config';
  const subjects = '"' + namespace + '".legacy_credential_subjects';
  const keys = '"' + namespace + '".legacy_data_keys';
  let connection;
  try {
    connection = await connect({ connectionString, max: 4, connectionTimeoutMillis: 5000,
      statement_timeout: 5000, query_timeout: 5000, application_name: 'nightscout-legacy-authority' });
    const state = await connection.withTenant('00000000-0000-0000-0000-000000000000', () =>
      connection.query(`SELECT c.relrowsecurity AND c.relforcerowsecurity AS secured,
        pg_has_role(current_user, c.relowner, 'MEMBER') AS owns,
        has_table_privilege(c.oid, 'SELECT') AS reads,
        has_table_privilege(c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') OR
        has_any_column_privilege(c.oid, 'INSERT,UPDATE,REFERENCES') AS writes
        FROM pg_class c WHERE c.oid IN (to_regclass($1), to_regclass($2)${localVerification ? ', to_regclass($3)' : ''})`, localVerification ? [config, subjects, keys] : [config, subjects]));
    if (state.rows.length !== (localVerification ? 3 : 2) || state.rows.some(row => !row.secured || row.owns || !row.reads || row.writes)) {
      throw failure('SECRETS_LEGACY_AUTHORITY_UNSAFE');
    }
  } catch (error) {
    if (connection) await connection.end();
    if (error.code === 'SECRETS_LEGACY_AUTHORITY_UNSAFE') throw error;
    throw failure('SECRETS_LEGACY_AUTHORITY_UNAVAILABLE');
  }
  return Object.freeze({
    async read (tenant) {
      let result;
      try {
        result = await connection.withTenant(tenant, () => connection.query(`
          SELECT c.root_reference_id, s.subject_id, s.token_prefix
          FROM ${config} c LEFT JOIN ${subjects} s ON s.tenant_id = c.tenant_id
          WHERE c.tenant_id = $1 ORDER BY s.subject_id`, [tenant]));
      } catch {
        throw failure('SECRETS_LEGACY_AUTHORITY_UNAVAILABLE');
      }
      if (!result.rows.length) throw failure('SECRETS_LEGACY_AUTHORITY_UNKNOWN');
      return Object.freeze({
        reference: Object.freeze({ tenant, id: result.rows[0].root_reference_id }),
        subjects: Object.freeze(result.rows.filter(row => row.subject_id !== null)
          .map(row => Object.freeze({ subjectId: row.subject_id, tokenPrefix: row.token_prefix })))
      });
    },
    async readVerification (tenant) {
      if (!localVerification) throw failure('SECRETS_OPERATION_UNSUPPORTED');
      let result;
      try {
        result = await connection.withTenant(tenant, () => connection.query(`SELECT
          c.root_verifiers, c.root_version, c.root_reference_id, c.verifier_root_reference_id,
          s.subject_id, s.verifiers, s.credential_version, s.token_prefix, s.verifier_token_prefix,
          (SELECT coalesce(jsonb_agg(jsonb_build_object('kid',k.kid,'publicKey',k.public_key,'active',k.active)), '[]'::jsonb)
            FROM ${keys} k WHERE k.tenant_id=c.tenant_id) AS keys
          FROM ${config} c LEFT JOIN ${subjects} s ON s.tenant_id=c.tenant_id
          WHERE c.tenant_id=$1 ORDER BY s.subject_id`, [tenant]));
      } catch { throw failure('SECRETS_LEGACY_AUTHORITY_UNAVAILABLE'); }
      if (!result.rows.length) throw failure('SECRETS_LEGACY_AUTHORITY_UNKNOWN');
      const first = result.rows[0];
      if (!first.verifier_root_reference_id || first.verifier_root_reference_id !== first.root_reference_id) {
        throw failure('SECRETS_LEGACY_AUTHORITY_INVALID');
      }
      return Object.freeze({ rootVerifiers: first.root_verifiers, rootVersion: first.root_version, keys: first.keys,
        subjects: result.rows.filter(row => row.subject_id !== null).map(row => ({ subjectId: row.subject_id,
          verifiers: row.verifier_token_prefix === row.token_prefix ? row.verifiers : null, credentialVersion: row.credential_version })) });
    },
    async signingKey (tenant) {
      if (!localVerification) throw failure('SECRETS_OPERATION_UNSUPPORTED');
      let result;
      try {
        result = await connection.withTenant(tenant, () => connection.query(`SELECT kid, private_key
          FROM ${keys} WHERE tenant_id=$1 AND active AND signing`, [tenant]));
      } catch { throw failure('SECRETS_LEGACY_AUTHORITY_UNAVAILABLE'); }
      if (result.rows.length !== 1) throw failure('SECRETS_KEY_VERSION');
      return Object.freeze({ kid: result.rows[0].kid, privateKey: result.rows[0].private_key });
    },
    close () { return connection.end(); }
  });
};
