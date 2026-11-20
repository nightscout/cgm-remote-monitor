'use strict';

// The api's DATA credential composition for test labs (decision
// deployment-signing-secret): the product's one-way verifiers
// (lib/secrets/legacy-verifiers.js), data JWTs signed with the tenant's derived
// data key (lib/secrets/derived-signing.js, lib/tenant-authorization/legacy-data-token.js)
// and the local exchange. Nothing here decrypts a root secret or calls Vault;
// the Vault-backed verifier and the HS256 exchange are retired.
//
// Two stores:
//   memory(): verifier state held in this process, for labs that do not
//     exercise the legacy PostgreSQL store.
//   postgres.seed(): writes the same verifier state and the data public key
//     into a migrated legacy credential namespace, as provisioning does, for
//     labs that read it through lib/secrets/legacy-postgres.js
//     (localVerification: true).
const crypto = require('node:crypto');
const legacyVerifiers = require('../../lib/secrets/legacy-verifiers');
const derivedSigning = require('../../lib/secrets/derived-signing');
const legacyDataToken = require('../../lib/tenant-authorization/legacy-data-token');

const REALM = Object.freeze({ issuer: 'synthetic-data-issuer', audience: 'synthetic-data-audience' });
const VERSION = 1;

function signer (secret = crypto.randomBytes(32)) { return derivedSigning.fromSecret(secret); }

// Verifier state for one tenant from its root secret and subjects
// ({ subjectId, tokenPrefix }); credential and root versions default to 1.
function state (tenant, { root, subjects = [], rootVersion = 1, credentialVersion = 1, signing }) {
  const prepared = legacyVerifiers.prepare(Buffer.from(root), subjects);
  const key = signing.key(tenant, 'data', VERSION);
  return {
    rootVerifiers: [...prepared.rootVerifiers], rootVersion,
    keys: [{ kid: key.kid, publicKey: key.spki, active: true }],
    subjects: prepared.subjects.map(subject => ({ subjectId: subject.subjectId, verifiers: [...subject.verifiers],
      credentialVersion: typeof credentialVersion === 'function' ? credentialVersion(subject.subjectId) : credentialVersion }))
  };
}

function memory ({ realm = REALM, now, signing = signer() } = {}) {
  const codec = legacyDataToken.create({ ...realm, ...(now ? { now } : {}) });
  const tenants = new Map();
  let unavailable = false;
  const read = async tenant => {
    if (unavailable) throw Object.assign(new Error('SECRETS_LEGACY_AUTHORITY_UNAVAILABLE'), { code: 'SECRETS_LEGACY_AUTHORITY_UNAVAILABLE' });
    const found = tenants.get(tenant);
    if (!found) throw Object.assign(new Error('SECRETS_LEGACY_AUTHORITY_UNKNOWN'), { code: 'SECRETS_LEGACY_AUTHORITY_UNKNOWN' });
    return found;
  };
  const verifier = legacyVerifiers.create({ read, verifyToken: codec.verify });
  return {
    verifier, codec, signing, realm, tenants,
    set (tenant, options) { tenants.set(tenant, state(tenant, { ...options, signing })); return tenants.get(tenant); },
    // Simulate an unavailable verifier store (an outage of current authority).
    outage (value) { unavailable = value; },
    // An eight-hour data JWT for a current subject, as the exchange issues it.
    jwt (tenant, subjectId) {
      const current = tenants.get(tenant), subject = current?.subjects.find(s => s.subjectId === subjectId);
      if (!subject) throw new Error('unknown synthetic subject');
      return codec.issue(tenant, { kind: 'subject', subjectId, credentialVersion: subject.credentialVersion,
        rootVersion: current.rootVersion }, signing.key(tenant, 'data', VERSION)).token;
    },
    store: { async signingKey (tenant) { const k = (await read(tenant)).keys[0]; return { kid: k.kid, publicKey: k.publicKey }; } },
    exchange ({ authority, verifierContext, audit = async () => {}, now: clock }) {
      return require('../../lib/server/tenant-app/local-exchange')({ credentials: verifier, authority, verifierContext,
        store: this.store, codec, signing, audit, ...(clock ? { now: clock } : {}) });
    }
  };
}

// Writes verifier state and the data signing public key into a legacy credential
// namespace (the shape provisioning writes). The config and subject rows must
// already exist (tenant, root reference, token prefixes); this fills the
// verifier columns and inserts legacy_data_keys.
async function seed (admin, { namespace, tenant, root, subjects, signing, rootVersion = 1 }) {
  const ns = '"' + namespace + '"';
  const prepared = legacyVerifiers.prepare(Buffer.from(root), subjects);
  await admin.query(`UPDATE ${ns}.legacy_credential_config SET root_verifiers=$2, verifier_root_reference_id=root_reference_id, root_version=$3 WHERE tenant_id=$1`,
    [tenant, prepared.rootVerifiers, rootVersion]);
  for (const [index, subject] of prepared.subjects.entries()) {
    await admin.query(`UPDATE ${ns}.legacy_credential_subjects SET verifiers=$3, verifier_token_prefix=token_prefix WHERE tenant_id=$1 AND subject_id=$2`,
      [tenant, subject.subjectId, subject.verifiers]);
    if (subjects[index].subjectId !== subject.subjectId) throw new Error('subject order');
  }
  const key = signing.key(tenant, 'data', VERSION);
  await admin.query(`INSERT INTO ${ns}.legacy_data_keys (tenant_id, kid, public_key, active, signing) VALUES ($1, $2, $3, true, true)
    ON CONFLICT DO NOTHING`, [tenant, key.kid, key.spki]);
}

// The api's composition over a legacy-postgres adapter opened with localVerification: true.
function postgres ({ legacy, realm = REALM, now, signing }) {
  const codec = legacyDataToken.create({ ...realm, ...(now ? { now } : {}) });
  const verifier = legacyVerifiers.create({ read: legacy.readVerification, verifyToken: codec.verify, usesConnection: legacy.usesConnection });
  return {
    verifier, codec, signing,
    exchange ({ authority, verifierContext, audit = async () => {}, now: clock }) {
      return require('../../lib/server/tenant-app/local-exchange')({ credentials: verifier, authority, verifierContext,
        store: legacy, codec, signing, audit, ...(clock ? { now: clock } : {}) });
    },
    async jwt (tenant, subjectId) {
      const current = await legacy.readVerification(tenant), subject = current.subjects.find(s => s.subjectId === subjectId);
      if (!subject) throw new Error('unknown synthetic subject');
      return codec.issue(tenant, { kind: 'subject', subjectId, credentialVersion: subject.credentialVersion,
        rootVersion: current.rootVersion }, signing.matching(tenant, 'data', await legacy.signingKey(tenant))).token;
    }
  };
}

// A data JWT for a subject at the given versions, signed with the tenant's derived data key.
function issue (tenant, subjectId, { signing, realm = REALM, credentialVersion = 1, rootVersion = 1, now } = {}) {
  return legacyDataToken.create({ ...realm, ...(now ? { now } : {}) }).issue(tenant,
    { kind: 'subject', subjectId, credentialVersion, rootVersion }, signing.key(tenant, 'data', VERSION)).token;
}

// The shipping subject access token for a root secret and subject.
const subjectToken = (root, subject) => legacyVerifiers.subjectToken(Buffer.from(root), subject);

module.exports = { REALM, VERSION, signer, state, memory, seed, postgres, issue, subjectToken };
