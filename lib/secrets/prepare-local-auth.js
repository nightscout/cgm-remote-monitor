'use strict';

const verifiers = require('./legacy-verifiers');
const { generateKey } = require('../tenant-authorization/legacy-data-token');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Trusted maintenance port, never installed on a serving listener. The caller
// supplies its existing exclusive lifecycle/restore window and writer connection.
// readRoot must use the current reference and durable secrets audit boundary.
module.exports = function createPreparation ({ connection, namespace, withCurrentTenant, readRoot }) {
  if (typeof connection?.withTenant !== 'function' || typeof connection?.query !== 'function' ||
      typeof withCurrentTenant !== 'function' || typeof readRoot !== 'function' || typeof namespace !== 'string' ||
      !/^[a-z][a-z0-9_]{0,62}$/.test(namespace) || ['public', 'information_schema'].includes(namespace) || namespace.startsWith('pg_')) {
    throw new TypeError('Local authentication preparation requires a fenced tenant writer and audited root reader');
  }
  const table = name => '"' + namespace + '".' + name;
  return async function prepare (tenant, { rotateSigningKey = false } = {}) {
    if (typeof tenant !== 'string' || !UUID.test(tenant) || typeof rotateSigningKey !== 'boolean') throw new TypeError('Canonical tenant preparation required');
    return withCurrentTenant(tenant, () => connection.withTenant(tenant, async () => {
      await connection.query("SET LOCAL synchronous_commit = 'on'");
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
      const keys = await connection.query('SELECT kid FROM ' + table('legacy_data_keys') + ' WHERE tenant_id=$1 AND active AND signing FOR UPDATE', [tenant]);
      if (rotateSigningKey || !keys.rows.length) {
        const key = generateKey();
        await connection.query('UPDATE ' + table('legacy_data_keys') + ' SET signing=false,private_key=NULL WHERE tenant_id=$1 AND signing', [tenant]);
        await connection.query('INSERT INTO ' + table('legacy_data_keys') +
          ' (tenant_id,kid,public_key,private_key,active,signing) VALUES ($1,$2,$3,$4,true,true)',
        [tenant, key.kid, key.publicKey, key.privateKey]);
      }
      // No bearer, verifier fingerprint, root bytes or private key leaves this port.
      return Object.freeze({ prepared: true });
    }));
  };
};
