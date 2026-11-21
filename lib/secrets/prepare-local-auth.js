'use strict';

const verifiers = require('./legacy-verifiers');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Trusted maintenance port, never installed on a serving listener. The caller
// supplies its existing exclusive lifecycle/restore window and writer connection.
// readRoot must use the current reference and durable secrets audit boundary.
// It prepares one-way verifiers only. Data signing keys are derived from the
// deployment signing secret by the issuing roles (decision
// deployment-signing-secret); provisioning writes their public rows.
module.exports = function createPreparation ({ connection, namespace, withCurrentTenant, readRoot }) {
  if (typeof connection?.withTenant !== 'function' || typeof connection?.query !== 'function' ||
      typeof withCurrentTenant !== 'function' || typeof readRoot !== 'function' || typeof namespace !== 'string' ||
      !/^[a-z][a-z0-9_]{0,62}$/.test(namespace) || ['public', 'information_schema'].includes(namespace) || namespace.startsWith('pg_')) {
    throw new TypeError('Local authentication preparation requires a fenced tenant writer and audited root reader');
  }
  return async function prepare (tenant) {
    if (typeof tenant !== 'string' || !UUID.test(tenant)) throw new TypeError('Canonical tenant preparation required');
    return withCurrentTenant(tenant, () => connection.withTenant(tenant, async () => {
      await connection.query("SET LOCAL synchronous_commit = 'on'");
      return prepareRows({ connection, namespace, readRoot, tenant });
    }));
  };
};

async function prepareRows ({ connection, namespace, readRoot, tenant }) {
  const table = name => '"' + namespace + '".' + name;
  const config = (await connection.query('SELECT root_reference_id FROM ' + table('legacy_credential_config') +
    ' WHERE tenant_id=$1 FOR UPDATE', [tenant])).rows[0];
  if (!config) throw new Error('Local authentication tenant is unprepared');
  const subjects = (await connection.query('SELECT subject_id,token_prefix FROM ' + table('legacy_credential_subjects') +
    ' WHERE tenant_id=$1 ORDER BY subject_id FOR UPDATE', [tenant])).rows.map(row => ({ subjectId: row.subject_id, tokenPrefix: row.token_prefix }));
  const root = await readRoot({ tenant, id: config.root_reference_id });
  let material;
  try { material = verifiers.prepare(root, subjects); }
  finally { if (Buffer.isBuffer(root)) root.fill(0); }
  await connection.query('UPDATE ' + table('legacy_credential_config') +
    ' SET root_version=root_version+CASE WHEN root_verifiers IS DISTINCT FROM $2::text[] THEN 1 ELSE 0 END,root_verifiers=$2,verifier_root_reference_id=$3 WHERE tenant_id=$1',
  [tenant, material.rootVerifiers, config.root_reference_id]);
  for (const subject of material.subjects) await connection.query('UPDATE ' + table('legacy_credential_subjects') +
    ' SET verifiers=$3,verifier_token_prefix=token_prefix WHERE tenant_id=$1 AND subject_id=$2', [tenant, subject.subjectId, subject.verifiers]);
  // No bearer, verifier fingerprint or root bytes leaves this port.
  return Object.freeze({ prepared: true });
}

// Reuse the real controller transaction and branded claim. Preparation cannot
// publish success before DATA commit, peer invalidation and tenant reactivation.
module.exports.withMaintenance = function ({ controller, namespace, readRoot }) {
  if (typeof controller?.withRestore !== 'function' || typeof readRoot !== 'function' ||
      typeof namespace !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(namespace) ||
      ['public', 'information_schema'].includes(namespace) || namespace.startsWith('pg_')) {
    throw new TypeError('Local authentication preparation requires an exclusive maintenance controller');
  }
  return async function prepare (tenant, { artifactDigest } = {}) {
    if (typeof tenant !== 'string' || !UUID.test(tenant) ||
        typeof artifactDigest !== 'string' || !/^[a-f0-9]{64}$/.test(artifactDigest)) throw new TypeError('Canonical tenant preparation required');
    const result = await controller.withRestore(tenant, { artifactDigest }, async ({ connection, maintenanceClaim }) => {
      const held = () => require('../tenant-lifecycle/maintenance-window').assertHeld(maintenanceClaim, { connection, tenant, artifactDigest });
      await held();
      await connection.query("SELECT set_config('synchronous_commit','on',true)");
      const prepared = await prepareRows({ connection, namespace, readRoot, tenant });
      await held();
      return prepared;
    });
    return result.result;
  };
};
