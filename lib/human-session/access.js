'use strict';

const { createVerifier, createHumanLookupVerifier, createSingleHumanVerifier,
  createSingleHumanLookupVerifier } = require('../tenant-authorization/access-token');
const NAME = /^[A-Za-z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail = code => Object.assign(new Error(code), { code });
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');

function createHumanTokenSelector ({ issuer, audiences }) {
  if (typeof issuer !== 'string' || !issuer || issuer.length > 256 || !audiences || Object.keys(audiences).length !== 2 ||
      !['data', 'management'].every(p => typeof audiences[p] === 'string' && audiences[p] && audiences[p].length <= 256) || audiences.data === audiences.management) {
    throw new TypeError('Explicit disjoint human token namespace required');
  }
  return token => {
    try {
      if (typeof token !== 'string' || token.length > 8192) return false;
      const parts = token.split('.');
      if (parts.length !== 3) return false;
      const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
      return header?.typ === 'ns-access+jwt' && claims?.iss === issuer &&
        [audiences.data, audiences.management].includes(claims.aud);
    } catch { return false; }
  };
}

// The issuer's signing functions are private deployment capabilities. Only
// public key objects enter verification, and current key acceptance is checked
// separately inside the human authority/session transaction on every operation.
function createHumanAccess ({ issuer, audiences, keys, mode = 'multi', now = () => Math.floor(Date.now() / 1000) }) {
  if (!['single', 'multi'].includes(mode) || typeof issuer !== 'string' || !issuer || issuer.length > 256 ||
      !audiences || Object.keys(audiences).length !== 2 || !['data', 'management'].every(p => typeof audiences[p] === 'string' && audiences[p] && audiences[p].length <= 256) ||
      audiences.data === audiences.management || !Array.isArray(keys) || !keys.length || keys.length > 10000) {
    throw new TypeError('Explicit distinct human access issuer/audiences and provisioned public keys required');
  }
  const trusted = new Map(), current = new Map(), material = new Set();
  for (const key of keys) {
    if (!key || !(mode === 'single' ? key.tenant === 'single' : UUID.test(key.tenant)) ||
        Object.keys(key).some(name => !['tenant', 'purpose', 'kid', 'publicKey', 'current', 'sign'].includes(name)) ||
        !['data', 'management'].includes(key.purpose) || !NAME.test(key.kid) ||
        !key.publicKey || key.publicKey.type !== 'public' || key.publicKey.asymmetricKeyType !== 'ed25519' ||
        typeof key.current !== 'boolean' || key.sign !== undefined && typeof key.sign !== 'function') {
      throw new TypeError('Human access requires explicit bound Ed25519 public keys');
    }
    const id = key.tenant + ':' + key.purpose + ':' + key.kid, selected = key.tenant + ':' + key.purpose;
    const publicMaterial = key.publicKey.export({ format: 'jwk' }).x;
    if (trusted.has(id) || material.has(publicMaterial) || key.current && (current.has(selected) || typeof key.sign !== 'function')) {
      throw new TypeError('Human access signing/verification profiles must be unambiguous');
    }
    trusted.set(id, Object.freeze({ ...key, issuer }));
    material.add(publicMaterial);
    if (key.current) current.set(selected, trusted.get(id));
  }
  const strict = {}, lookup = {};
  const accepts = createHumanTokenSelector({ issuer, audiences });
  for (const purpose of ['data', 'management']) {
    const policy = { issuer, audience: audiences[purpose], purpose, maxLifetimeSeconds: purpose === 'management' ? 600 : 28800,
      now, resolveKey: (tenant, kid) => trusted.get(tenant + ':' + purpose + ':' + kid) };
    strict[purpose] = (mode === 'single' ? createSingleHumanVerifier : createVerifier)(policy);
    lookup[purpose] = (mode === 'single' ? createSingleHumanLookupVerifier : createHumanLookupVerifier)(policy);
  }
  function payload (token) {
    if (typeof token !== 'string' || token.length > 8192) throw fail('HUMAN_SESSION_REFUSED');
    try {
      const parts = token.split('.');
      if (parts.length !== 3) throw new Error();
      return { header: JSON.parse(Buffer.from(parts[0], 'base64url')), claims: JSON.parse(Buffer.from(parts[1], 'base64url')) };
    } catch { throw fail('HUMAN_SESSION_REFUSED'); }
  }
  return Object.freeze({
    issuer, audiences: Object.freeze({ ...audiences }),
    keyBindings: Object.freeze([...trusted.values()].map(({ tenant, kid, purpose }) => Object.freeze({ tenant, kid, purpose }))),
    accepts,
    keyId ({ tenant, purpose }) {
      const key = current.get(tenant + ':' + purpose);
      if (!key) throw fail('HUMAN_SESSION_UNAVAILABLE');
      return key.kid;
    },
    async issue ({ tenant, subject, session, purpose, credentialVersion, issuedAt, expiresAt }) {
      const key = current.get(tenant + ':' + purpose);
      if (!key) throw fail('HUMAN_SESSION_UNAVAILABLE');
      const claims = { iss: issuer, aud: audiences[purpose], tid: tenant, purpose,
        sub: subject, sid: session, cv: credentialVersion, iat: issuedAt, nbf: issuedAt, exp: expiresAt };
      const input = encode({ alg: 'EdDSA', typ: 'ns-access+jwt', kid: key.kid }) + '.' + encode(claims);
      let signature;
      try { signature = await key.sign(Buffer.from(input)); } catch { throw fail('HUMAN_SESSION_UNAVAILABLE'); }
      if (!Buffer.isBuffer(signature) || signature.length !== 64) throw fail('HUMAN_SESSION_UNAVAILABLE');
      const token = input + '.' + signature.toString('base64url');
      try { strict[purpose](token, tenant); } catch { throw fail('HUMAN_SESSION_UNAVAILABLE'); }
      return token;
    },
    verify ({ tenant, token, allowExpiredLookup = false }) {
      const { claims } = payload(token);
      if (!claims || !['data', 'management'].includes(claims.purpose)) throw fail('HUMAN_SESSION_REFUSED');
      try { return (allowExpiredLookup ? lookup : strict)[claims.purpose](token, tenant); }
      catch { throw fail('HUMAN_SESSION_REFUSED'); }
    }
  });
}

module.exports = { createHumanAccess, createHumanTokenSelector };
