'use strict';

const { createPublicKey } = require('node:crypto');
const signatureProof = require('./signature-proof');
const NAME = /^[A-Za-z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const named = value => typeof value === 'string' && NAME.test(value);
const TYPE = 'ns-legacy-data+jwt';
const LIFETIME = 28800;
function invalid () { throw Object.assign(new Error('SECRETS_TOKEN_INVALID'), { code: 'SECRETS_TOKEN_INVALID' }); }
function create ({ issuer, audience, now = () => Math.floor(Date.now() / 1000) }) {
  if (![issuer, audience].every(v => typeof v === 'string' && v.length > 0 && v.length <= 256) || typeof now !== 'function') {
    throw new TypeError('Explicit data token realm required');
  }
  function decode (part) {
    if (typeof part !== 'string' || !/^[A-Za-z0-9_-]+$/.test(part)) invalid();
    const bytes = Buffer.from(part, 'base64url');
    if (bytes.toString('base64url') !== part) invalid();
    return bytes;
  }
  function verify (token, tenant, keys) {
    if (typeof tenant !== 'string' || !UUID.test(tenant) || typeof token !== 'string' || token.length > 8192 || !Array.isArray(keys)) invalid();
    const parts = token.split('.');
    if (parts.length !== 3) invalid();
    let header, claims;
    try { header = JSON.parse(decode(parts[0])); claims = JSON.parse(decode(parts[1])); } catch { invalid(); }
    if (!header || header.alg !== 'EdDSA' || header.typ !== TYPE || !named(header.kid) ||
        Object.keys(header).some(k => !['alg', 'typ', 'kid'].includes(k))) invalid();
    const key = keys.find(k => k.kid === header.kid && k.active === true);
    if (!key) invalid();
    let publicKey;
    try { publicKey = createPublicKey({ key: Buffer.from(key.publicKey, 'base64'), type: 'spki', format: 'der' }); } catch { invalid(); }
    const signature = decode(parts[2]);
    if (publicKey.asymmetricKeyType !== 'ed25519' || signature.length !== 64 ||
        !signatureProof(Buffer.from(parts[0] + '.' + parts[1]), publicKey, signature)) invalid();
    const time = now();
    if (!Number.isSafeInteger(time) || time < 0 || !claims || claims.iss !== issuer || claims.aud !== audience || claims.tid !== tenant || !named(claims.sub) ||
        ![claims.cv, claims.rv].every(v => Number.isSafeInteger(v) && v > 0) ||
        ![claims.iat, claims.exp].every(Number.isSafeInteger) || claims.iat < 0 || claims.iat > time ||
        claims.exp <= time || claims.exp - claims.iat !== LIFETIME ||
        Object.keys(claims).some(k => !['iss', 'aud', 'tid', 'sub', 'cv', 'rv', 'iat', 'exp'].includes(k))) invalid();
    return Object.freeze(claims);
  }
  // key: the tenant's derived data signing key (lib/secrets/derived-signing.js),
  // { kid, sign(bytes) }; the private key never leaves that module.
  function issue (tenant, principal, key) {
    const iat = now();
    if (!UUID.test(tenant) || principal.kind !== 'subject' || !named(principal.subjectId) ||
        ![principal.credentialVersion, principal.rootVersion].every(v => Number.isSafeInteger(v) && v > 0) ||
        !Number.isSafeInteger(iat) || iat < 0 || !Number.isSafeInteger(iat + LIFETIME) || !key || !named(key.kid) || typeof key.sign !== 'function') invalid();
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = encode({ alg: 'EdDSA', typ: TYPE, kid: key.kid }) + '.' + encode({
      iss: issuer, aud: audience, tid: tenant, sub: principal.subjectId,
      cv: principal.credentialVersion, rv: principal.rootVersion, iat, exp: iat + LIFETIME
    });
    const signature = key.sign(Buffer.from(input));
    if (!Buffer.isBuffer(signature) || signature.length !== 64) invalid();
    return Object.freeze({ token: input + '.' + signature.toString('base64url'), iat, exp: iat + LIFETIME });
  }
  return Object.freeze({ issue, verify });
}
module.exports = { create, TYPE, LIFETIME };
