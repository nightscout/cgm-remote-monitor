'use strict';

const connect = require('../storage/postgres-connection');
const scope = require('../storage/tenant-scope');

function failure (code) {
  return Object.assign(new Error(code), { code });
}

module.exports = async function createLegacyAuthority ({ connectionString, connection: suppliedConnection, namespace, localVerification = false, recommissionNamespace, verificationConnection, roleAdmitted = false }) {
  if (scope.getTenancyMode() !== 'multi' || typeof namespace !== 'string' ||
      !/^[a-z][a-z0-9_]{0,62}$/.test(namespace) || namespace === 'public' ||
      namespace.startsWith('pg_') || namespace === 'information_schema') {
    throw new TypeError('Legacy authority requires multi mode and a non-system namespace');
  }
  if (recommissionNamespace !== undefined && (typeof recommissionNamespace !== 'string' ||
      !/^[a-z][a-z0-9_]{0,62}$/.test(recommissionNamespace) || recommissionNamespace === 'public' ||
      recommissionNamespace.startsWith('pg_') || recommissionNamespace === 'information_schema')) throw new TypeError('Explicit selected recommission namespace required');
  const previousProfile = recommissionNamespace === undefined ? '' : 'NOT EXISTS (SELECT 1 FROM "' + recommissionNamespace +
    '".tenant_lifecycle_recommission x WHERE x.tenant_id=c.tenant_id AND x.activated) AS previous_profile_allowed,';
  if (verificationConnection !== undefined && (!localVerification || !verificationConnection ||
      ['query', 'withTenant'].some(key => typeof verificationConnection[key] !== 'function'))) {
    throw new TypeError('Explicit local verification connection required');
  }
  if (suppliedConnection !== undefined && (!suppliedConnection ||
      ['query', 'withTenant'].some(key => typeof suppliedConnection[key] !== 'function'))) {
    throw new TypeError('Explicit legacy authority connection required');
  }
  // The request path's verifier read may borrow the API connection so a caller
  // can read verifiers and current authorization in one tenant transaction.
  // Its own driver timeout stays; statement timeout and admission are the pool's.
  const verification = verificationConnection || null;
  const config = '"' + namespace + '".legacy_credential_config';
  const subjects = '"' + namespace + '".legacy_credential_subjects';
  const keys = '"' + namespace + '".legacy_data_keys';
  let connection;
  try {
    connection = suppliedConnection || await connect({ connectionString, max: 4, connectionTimeoutMillis: 5000,
      statement_timeout: 5000, query_timeout: 5000, application_name: 'nightscout-legacy-authority' });
    // Serving roles complete readiness before opening this adapter.
    const state = roleAdmitted ? null : await connection.withTenant('00000000-0000-0000-0000-000000000000', () =>
      connection.query(`SELECT c.relrowsecurity AND c.relforcerowsecurity AS secured,
        pg_has_role(current_user, c.relowner, 'MEMBER') AS owns,
        has_table_privilege(c.oid, 'SELECT') AS reads,
        has_table_privilege(c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') OR
        has_any_column_privilege(c.oid, 'INSERT,UPDATE,REFERENCES') AS writes
        FROM pg_class c WHERE c.oid IN (to_regclass($1), to_regclass($2)${localVerification ? ', to_regclass($3)' : ''})`, localVerification ? [config, subjects, keys] : [config, subjects]));
    if (state && (state.rows.length !== (localVerification ? 3 : 2) || state.rows.some(row => !row.secured || row.owns || !row.reads || row.writes))) {
      throw failure('SECRETS_LEGACY_AUTHORITY_UNSAFE');
    }
  } catch (error) {
    if (connection && !suppliedConnection) await connection.end();
    if (error.code === 'SECRETS_LEGACY_AUTHORITY_UNSAFE') throw error;
    throw failure('SECRETS_LEGACY_AUTHORITY_UNAVAILABLE');
  }
  return Object.freeze({
    usesConnection: candidate => verification !== null && candidate === verification,
    async read (tenant) {
      let result;
      try {
        result = await connection.withTenant(tenant, () => connection.query(`
          SELECT ${recommissionNamespace === undefined ? '' : previousProfile + 'c.root_version,'} c.root_reference_id, s.subject_id, s.token_prefix
          FROM ${config} c LEFT JOIN ${subjects} s ON s.tenant_id = c.tenant_id
          WHERE c.tenant_id = $1 ORDER BY s.subject_id`, [tenant]));
      } catch {
        throw failure('SECRETS_LEGACY_AUTHORITY_UNAVAILABLE');
      }
      if (!result.rows.length) throw failure('SECRETS_LEGACY_AUTHORITY_UNKNOWN');
      const first = result.rows[0];
      if (recommissionNamespace !== undefined && (typeof first.previous_profile_allowed !== 'boolean' || !Number.isSafeInteger(first.root_version) || first.root_version < 1)) throw failure('SECRETS_LEGACY_AUTHORITY_INVALID');
      return Object.freeze({
        ...(recommissionNamespace === undefined ? {} : { sessionEpoch: Object.freeze({ tenant, version: first.root_version, enforced: !first.previous_profile_allowed }) }),
        reference: Object.freeze({ tenant, id: result.rows[0].root_reference_id }),
        subjects: Object.freeze(result.rows.filter(row => row.subject_id !== null)
          .map(row => Object.freeze({ subjectId: row.subject_id, tokenPrefix: row.token_prefix })))
      });
    },
    async readVerification (tenant) {
      if (!localVerification) throw failure('SECRETS_OPERATION_UNSUPPORTED');
      let result;
      try {
        const reader = verification || connection;
        const text = `SELECT
          ${previousProfile} c.root_verifiers, c.root_version, c.root_reference_id, c.verifier_root_reference_id,
          s.subject_id, s.verifiers, s.credential_version, s.token_prefix, s.verifier_token_prefix,
          (SELECT coalesce(jsonb_agg(jsonb_build_object('kid',k.kid,'publicKey',k.public_key,'active',k.active)), '[]'::jsonb)
            FROM ${keys} k WHERE k.tenant_id=c.tenant_id) AS keys
          FROM ${config} c LEFT JOIN ${subjects} s ON s.tenant_id=c.tenant_id
          WHERE c.tenant_id=$1 ORDER BY s.subject_id`;
        result = await reader.withTenant(tenant, () => verification
          ? reader.query({ text, values: [tenant], query_timeout: 5000 }) : reader.query(text, [tenant]));
      } catch { throw failure('SECRETS_LEGACY_AUTHORITY_UNAVAILABLE'); }
      if (!result.rows.length) throw failure('SECRETS_LEGACY_AUTHORITY_UNKNOWN');
      const first = result.rows[0];
      if (recommissionNamespace !== undefined && typeof first.previous_profile_allowed !== 'boolean') throw failure('SECRETS_LEGACY_AUTHORITY_INVALID');
      if (!first.verifier_root_reference_id || first.verifier_root_reference_id !== first.root_reference_id) {
        throw failure('SECRETS_LEGACY_AUTHORITY_INVALID');
      }
      return Object.freeze({ rootVerifiers: first.root_verifiers, rootVersion: first.root_version, keys: first.keys,
        ...(recommissionNamespace === undefined ? {} : { previousProfileAllowed: first.previous_profile_allowed }),
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
    close () { return suppliedConnection ? Promise.resolve() : connection.end(); }
  });
};
