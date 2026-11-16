'use strict';

// Read-only cryptographic preflight, not provider-key recovery or admission.
// The caller supplies its trusted current tenant provider. No plaintext,
// credential, ciphertext, provider error or verifier material leaves this port.
const { isDeepStrictEqual } = require('node:util');
const artifacts = require('./artifact');
const verifiers = require('../secrets/legacy-verifiers');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = /^[A-Za-z0-9_-]{1,128}$/;
const named = value => typeof value === 'string' && NAME.test(value);

async function verify (input) {
  // Every thrown error is recreated here using a code owned by this function;
  // no thrown provider/source value becomes an error message, detail or cause.
  let failure = 'INPUT_INVALID';
  try {
    const { artifact, tenant, provider } = input || {};
    if (typeof tenant !== 'string' || !UUID.test(tenant) || typeof provider?.decrypt !== 'function') throw null;
    failure = 'ARTIFACT_INVALID';
    artifacts.validateArtifact(artifact);
    failure = 'TENANT_MISMATCH';
    if (artifact.manifest.tenant !== tenant) throw null;
    failure = 'PREPARATION_REQUIRED';
    // Own the small relevant input before the first asynchronous provider call.
    // The large clinical inventory remains with the caller's exact-artifact gate.
    const captured = JSON.parse(JSON.stringify({ records: artifact.tables['secrets.secret_records'],
      configs: artifact.tables['legacy.legacy_credential_config'], subjects: artifact.tables['legacy.legacy_credential_subjects'] }));
    const { records, configs, subjects } = captured;
    if (!Array.isArray(records) || !Array.isArray(configs) || configs.length !== 1 || !Array.isArray(subjects)) throw null;
    const config = configs[0];
    if (!named(config.root_reference_id) || config.verifier_root_reference_id !== config.root_reference_id ||
        !Array.isArray(config.root_verifiers) || config.root_verifiers.length !== 2) throw null;
    const identifiers = new Set(), metadata = [];
    for (const subject of subjects) {
      if (!named(subject.subject_id) || identifiers.has(subject.subject_id) || typeof subject.token_prefix !== 'string' ||
          !/^[a-z0-9_]{0,10}$/.test(subject.token_prefix) || subject.verifier_token_prefix !== subject.token_prefix ||
          !Array.isArray(subject.verifiers) || subject.verifiers.length !== 50) throw null;
      identifiers.add(subject.subject_id);
      metadata.push({ subjectId: subject.subject_id, tokenPrefix: subject.token_prefix });
    }
    failure = 'RECORD_INVALID';
    const ids = new Set();
    for (const record of records) {
      if (record.tenant_id !== tenant || !named(record.id) || ids.has(record.id) || record.format !== 1 ||
          typeof record.ciphertext !== 'string' || !record.ciphertext.length) throw null;
      ids.add(record.id);
    }
    failure = 'ROOT_REQUIRED';
    if (!ids.has(config.root_reference_id)) throw null;
    for (const record of records) {
      let bytes, decoded;
      try {
        failure = 'DECRYPT_REFUSED';
        bytes = await provider.decrypt(record.ciphertext);
        failure = 'RECORD_INVALID';
        if (!Buffer.isBuffer(bytes)) throw null;
        const value = JSON.parse(bytes.toString('utf8'));
        // Same immutable plaintext binding and canonical format-1 data encoding
        // as secrets/component.js read(), including canonical empty data.
        if (!value || value.tenant !== tenant || value.id !== record.id || typeof value.data !== 'string') throw null;
        decoded = Buffer.from(value.data, 'base64');
        if (decoded.toString('base64') !== value.data) throw null;
        if (record.id === config.root_reference_id) {
          failure = 'VERIFIER_MISMATCH';
          const prepared = verifiers.prepare(decoded, metadata);
          if (!isDeepStrictEqual(prepared.rootVerifiers, config.root_verifiers) ||
              prepared.subjects.some((subject, index) => !isDeepStrictEqual(subject.verifiers, subjects[index].verifiers))) throw null;
        }
      } finally {
        if (Buffer.isBuffer(decoded)) decoded.fill(0);
        if (bytes instanceof Uint8Array) bytes.fill(0);
      }
    }
    return Object.freeze({ verified: true });
  } catch {
    const code = 'LIFECYCLE_RECOMMISSION_SECRETS_' + failure;
    throw Object.assign(new Error(code), { code });
  }
}

module.exports = { verify };
