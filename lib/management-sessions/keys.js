'use strict';

// Management sessions are signed in process with the tenant's derived
// management key (decision deployment-signing-secret); no Vault call. The
// store supplies the tenant's active management key rows (kid, public_key)
// from its security-definer read; the newest version whose stored public key
// matches this deployment's derivation signs. A replayed request keeps the
// kid and version it was first issued with.
const { parseKid } = require('../secrets/derived-signing');
const fail = code => Object.assign(new Error(code), { code });

function createDerivedKeySource ({ signing }) {
  if (typeof signing?.matching !== 'function') throw new TypeError('Explicit deployment signing keys required');
  return Object.freeze({
    async select ({ tenant, keys, expected }) {
      if (!Array.isArray(keys)) throw fail('MANAGEMENT_SESSION_KEY_REFUSED');
      const candidates = [];
      for (const row of keys) {
        const parsed = parseKid(row?.kid);
        if (!parsed || parsed.purpose !== 'management') continue;
        if (expected && (expected.kid !== row.kid || expected.key_version !== parsed.version)) continue;
        let derived;
        try { derived = signing.matching(tenant, 'management', { kid: row.kid, publicKey: row.public_key }); } catch { continue; }
        candidates.push(derived);
      }
      candidates.sort((a, b) => b.version - a.version);
      if (!candidates.length) throw fail('MANAGEMENT_SESSION_KEY_REFUSED');
      const chosen = candidates[0];
      return Object.freeze({ kid: chosen.kid, keyVersion: chosen.version, sign: async input => chosen.sign(input) });
    }
  });
}
module.exports = { createDerivedKeySource };
