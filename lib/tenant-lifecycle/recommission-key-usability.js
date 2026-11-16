'use strict';

// Current provider keys must work before reconstructed credentials commit.
// Challenges are domain-separated random bytes, never tokens or tenant data.
const crypto = require('node:crypto');
const PURPOSES = new Set(['access', 'management', 'human-data', 'human-management']);
async function verify ({ tenant, provider, keys, signers }) {
  let challenge, hmac;
  try {
    if (typeof tenant !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tenant) ||
        typeof provider?.sign !== 'function' || typeof provider?.verify !== 'function' || !Number.isSafeInteger(provider.signingVersion) || provider.signingVersion < 1 ||
        !Array.isArray(keys) || keys.length > 256 || !signers || typeof signers !== 'object') throw null;
    challenge = Buffer.concat([Buffer.from('nightscout-recommission-key-proof-v1:' + tenant + ':'), crypto.randomBytes(32)]);
    hmac = await provider.sign(challenge);
    if (!Buffer.isBuffer(hmac) || hmac.length !== 32 || await provider.verify(provider.signingVersion, challenge, hmac) !== true) throw null;
    const seen = new Set();
    for (const key of keys) {
      let signature;
      try {
        const id = key.purpose + ':' + key.kid;
        if (!PURPOSES.has(key.purpose) || typeof key.kid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(key.kid) || seen.has(id) ||
            typeof key.publicKey !== 'string' || typeof signers[key.purpose]?.sign !== 'function') throw null;
        seen.add(id);
        const raw = Buffer.from(key.publicKey, 'base64');
        if (raw.length !== 32 || raw.toString('base64') !== key.publicKey) throw null;
        const publicKey = crypto.createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') } });
        signature = await signers[key.purpose].sign(challenge);
        if (!Buffer.isBuffer(signature) || signature.length !== 64 || !crypto.verify(null, challenge, publicKey, signature)) throw null;
      } finally { if (Buffer.isBuffer(signature)) signature.fill(0); }
    }
    return Object.freeze({ verified: true });
  } catch {
    const code = 'LIFECYCLE_RECOMMISSION_PROVIDER_KEYS_REFUSED'; throw Object.assign(new Error(code), { code });
  } finally { if (Buffer.isBuffer(challenge)) challenge.fill(0); if (Buffer.isBuffer(hmac)) hmac.fill(0); }
}
module.exports = { verify };
