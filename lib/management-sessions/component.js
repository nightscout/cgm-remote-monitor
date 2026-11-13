'use strict';

// Private operator issuance identifies a current owner; it does not grant
// ownership or embed grants. Every use still checks current management state.
function createManagementSessions ({ store, keySource, issuer, audience }) {
  if (!store || typeof store.issue !== 'function' || !keySource || typeof keySource.select !== 'function' ||
      typeof issuer !== 'string' || !issuer || typeof audience !== 'string' || !audience) throw new TypeError('Explicit management issuer, audience, store and signing capability required');
  return Object.freeze({
    async issue (input) {
      return store.issue(input, async ({ record, keys, existing }) => {
        const selected = await keySource.select({ tenant: record.tenant_id, keys, ...(existing ? { expected: record } : {}) });
        const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'ns-access+jwt', kid: selected.kid })).toString('base64url');
        const payload = Buffer.from(JSON.stringify({ iss: issuer, aud: audience, tid: record.tenant_id, purpose: 'management',
          sub: record.subject_id, sid: record.session_id, cv: record.credential_generation,
          iat: Number(record.issued_at), nbf: Number(record.issued_at), exp: Number(record.expires_at) })).toString('base64url');
        const signed = header + '.' + payload;
        const signature = await selected.sign(Buffer.from(signed));
        if (!Buffer.isBuffer(signature) || signature.length !== 64) throw Object.assign(new Error('MANAGEMENT_SESSION_KEY_REFUSED'), { code: 'MANAGEMENT_SESSION_KEY_REFUSED' });
        return { token: signed + '.' + signature.toString('base64url'), kid: selected.kid, keyVersion: selected.keyVersion };
      });
    }
  });
}
module.exports = { createManagementSessions };
