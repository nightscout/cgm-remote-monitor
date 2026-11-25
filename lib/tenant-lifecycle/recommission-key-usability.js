'use strict';

// The tenant's current signing keys must be usable before reconstructed
// credentials commit. Signing keys are derived from the deployment signing
// secret (decision deployment-signing-secret): each active stored public key
// must be this deployment's derivation for its tenant, purpose and version, so
// a recommission into a deployment holding another secret refuses here. No
// Vault call; the HS256 liveness probe is retired with the HS256 profile.
const PURPOSES = new Set(['management', 'human-data', 'human-management']);
async function verify ({ tenant, keys, signing }) {
  try {
    if (typeof tenant !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tenant) ||
        typeof signing?.matching !== 'function' || !Array.isArray(keys) || keys.length > 256) throw null;
    const seen = new Set();
    for (const key of keys) {
      const id = key?.purpose + ':' + key?.kid;
      if (!PURPOSES.has(key?.purpose) || typeof key.kid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(key.kid) || seen.has(id) ||
          typeof key.publicKey !== 'string') throw null;
      seen.add(id);
      signing.matching(tenant, key.purpose, { kid: key.kid, publicKey: key.publicKey });
    }
    return Object.freeze({ verified: true });
  } catch {
    const code = 'LIFECYCLE_RECOMMISSION_PROVIDER_KEYS_REFUSED'; throw Object.assign(new Error(code), { code });
  }
}
module.exports = { verify, PURPOSES };
