'use strict';

// New-format verifier shared by explicit multitenant composition and its lab.
const signatureProof = require('./signature-proof');
const NAME = /^[A-Za-z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const named = value => typeof value === 'string' && NAME.test(value);

function refuse (code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function decode (part) {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) refuse('TOKEN_FORMAT');
  const bytes = Buffer.from(part, 'base64url');
  if (bytes.toString('base64url') !== part) refuse('TOKEN_FORMAT');
  return bytes;
}

function verifier ({ issuer, audience, purpose, maxLifetimeSeconds, resolveKey,
  now = () => Math.floor(Date.now() / 1000) }, singleHuman, lookupOnly) {
  if (typeof issuer !== 'string' || !issuer || typeof audience !== 'string' || !audience ||
      !['data', 'management'].includes(purpose) || !Number.isSafeInteger(maxLifetimeSeconds) ||
      maxLifetimeSeconds < 1 || typeof resolveKey !== 'function') throw new TypeError('Explicit verification policy required');
  return function verifyToken (token, tenant) {
    if (!(singleHuman ? tenant === 'single' : UUID.test(tenant)) || typeof token !== 'string' || token.length > 8192) refuse('TOKEN_FORMAT');
    const parts = token.split('.');
    if (parts.length !== 3) refuse('TOKEN_FORMAT');
    let header, claims;
    try {
      header = JSON.parse(decode(parts[0]).toString('utf8'));
      claims = JSON.parse(decode(parts[1]).toString('utf8'));
    } catch { refuse('TOKEN_FORMAT'); }
    if (!header || header.alg !== 'EdDSA' || header.typ !== 'ns-access+jwt' || !named(header.kid) ||
        Object.keys(header).some(key => !['alg', 'typ', 'kid'].includes(key))) refuse('TOKEN_HEADER');
    // Only deployment-provisioned keys; never a request-selected URL or JWK.
    const key = resolveKey(tenant, header.kid);
    if (!key || key.tenant !== tenant || key.kid !== header.kid || key.issuer !== issuer ||
        key.purpose !== purpose || key.publicKey.asymmetricKeyType !== 'ed25519') refuse('TOKEN_KEY');
    const signature = decode(parts[2]);
    if (signature.length !== 64 || !signatureProof(Buffer.from(parts[0] + '.' + parts[1]), key.publicKey, signature)) {
      refuse('TOKEN_SIGNATURE');
    }
    const time = now();
    if (!claims || claims.iss !== issuer || claims.aud !== audience || claims.tid !== tenant ||
        claims.purpose !== purpose || !named(claims.sub) || !named(claims.sid) ||
        !Number.isSafeInteger(claims.cv) || claims.cv < 1 ||
        ![claims.iat, claims.nbf, claims.exp].every(Number.isSafeInteger) ||
        claims.iat < 0 || claims.nbf < claims.iat || claims.iat > time || claims.nbf > time ||
        (!lookupOnly && claims.exp <= time) || claims.exp <= claims.nbf || claims.exp - claims.iat > maxLifetimeSeconds ||
        Object.keys(claims).some(key => !['iss', 'aud', 'tid', 'purpose', 'sub', 'sid', 'cv', 'iat', 'nbf', 'exp'].includes(key))) {
      refuse('TOKEN_CLAIMS');
    }
    return Object.freeze({ ...claims, kid: header.kid, ...(lookupOnly ? { lookupOnly: true } : {}) });
  };
}

// Closed profiles. No request, environment value or general validator can turn
// an ordinary/multitenant access verifier into the private single human realm.
const createVerifier = options => verifier(options, false, false);
const createHumanLookupVerifier = options => verifier(options, false, true);
const createSingleHumanVerifier = options => verifier(options, true, false);
const createSingleHumanLookupVerifier = options => verifier(options, true, true);

function createAuthentication ({ verifyToken, snapshot, now = () => Math.floor(Date.now() / 1000) }) {
  if (typeof verifyToken !== 'function' || typeof snapshot !== 'function') throw new TypeError('Current authority required');
  return async function authenticate ({ token, tenant }) {
    const claims = verifyToken(token, tenant);
    if (claims.lookupOnly) refuse('TOKEN_CLAIMS');
    // One current snapshot per operation, including session/key/tenant state.
    const state = await snapshot(claims);
    if (!state || !state.active || !state.sessionActive || !state.keyActive ||
        state.credentialVersion !== claims.cv || state.sessionExpiresAt <= now() ||
        state.sessionExpiresAt < claims.exp) refuse('AUTHORITY_FORBIDDEN');
    return Object.freeze({ claims, state });
  };
}

function createAuthorizer (options) {
  const authenticate = createAuthentication(options);
  return async function authorize ({ token, tenant, permissions }) {
    if (!Array.isArray(permissions) || !permissions.length || permissions.some(p => typeof p !== 'string' || !p)) {
      refuse('AUTHORITY_REQUEST');
    }
    const { claims, state } = await authenticate({ token, tenant });
    if (permissions.some(permission => !state.allows(permission))) refuse('AUTHORITY_FORBIDDEN');
    return Object.freeze({ tenant, subject: claims.sub, name: state.name });
  };
}

function accepts (token) {
  if (typeof token !== 'string' || token.length > 8192) return false;
  try { return JSON.parse(Buffer.from(token.split('.')[0], 'base64url')).typ === 'ns-access+jwt'; } catch { return false; }
}

module.exports = { createVerifier, createHumanLookupVerifier, createSingleHumanVerifier,
  createSingleHumanLookupVerifier, createAuthentication, createAuthorizer, accepts };
