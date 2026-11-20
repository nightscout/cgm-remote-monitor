'use strict';

// Tenant token-signing keys derived in process (decision deployment-signing-secret).
//
//   seed = HKDF-SHA256(deployment signing secret, salt, tenant id / purpose / version)
//   key  = Ed25519(seed)
//
// Purposes: data (the legacy data JWT), management (headless management
// sessions), human-data and human-management (OIDC human sessions). The
// per-tenant version lives in PostgreSQL: it is encoded in each key row's kid
// (`<purpose>-<version>`), written by provisioning from registry signing_version.
// Distinct tenants, purposes and versions give distinct keys, so a token for
// tenant A fails signature verification on tenant B (decision D14).
//
// The secret is read once at boot from the file named by NS_SIGNING_SECRET_FILE.
// It never leaves this module; only public keys and signatures do. Verification
// stays with the public keys stored in PostgreSQL; an issuer refuses a stored
// public key that does not match its derivation (another deployment's secret,
// or a restore into a deployment with a different secret).
const fs = require('node:fs');
const { createPrivateKey, createPublicKey, hkdfSync, sign } = require('node:crypto');

const SETTING = 'NS_SIGNING_SECRET_FILE';
const MIN_BYTES = 32;
const MAX_BYTES = 4096;
const SALT = 'nightscout-tenant-signing-v1';
const PURPOSES = Object.freeze(['data', 'management', 'human-data', 'human-management']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const MAX_CACHED = 10000;

const refuse = message => { throw Object.assign(new TypeError(message), { code: 'SIGNING_SECRET_INVALID' }); };
const fail = code => Object.assign(new Error(code), { code });

function kid (purpose, version) {
  if (!PURPOSES.includes(purpose) || !Number.isSafeInteger(version) || version < 1 || version > 999999999) throw new TypeError('Invalid signing key purpose or version');
  return purpose + '-' + version;
}
// -> { purpose, version } or null for a kid that is not a derived key's.
function parseKid (value) {
  const match = typeof value === 'string' && /^(data|management|human-data|human-management)-([1-9][0-9]{0,8})$/.exec(value);
  return match ? Object.freeze({ purpose: match[1], version: Number(match[2]) }) : null;
}

function fromSecret (secret) {
  if (!Buffer.isBuffer(secret) || secret.length < MIN_BYTES || secret.length > MAX_BYTES) refuse('The deployment signing secret must be ' + MIN_BYTES + ' to ' + MAX_BYTES + ' bytes');
  const held = Buffer.from(secret);
  const cache = new Map();
  function key (tenant, purpose, version) {
    if (typeof tenant !== 'string' || !UUID.test(tenant)) throw new TypeError('Canonical tenant id required');
    const id = kid(purpose, version), name = tenant + '/' + id;
    let found = cache.get(name);
    if (found) { cache.delete(name); cache.set(name, found); return found; }
    const seed = Buffer.from(hkdfSync('sha256', held, SALT, tenant + '/' + purpose + '/' + version, 32));
    const der = Buffer.concat([PKCS8_ED25519, seed]);
    const privateKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    seed.fill(0); der.fill(0);
    const publicKey = createPublicKey(privateKey);
    const spki = publicKey.export({ format: 'der', type: 'spki' });
    found = Object.freeze({ tenant, purpose, version, kid: id, publicKey,
      // Raw 32-byte base64 (registry rows) and SPKI DER base64 (legacy_data_keys rows).
      raw: spki.subarray(SPKI_ED25519.length).toString('base64'), spki: spki.toString('base64'),
      sign: bytes => sign(null, bytes, privateKey) });
    cache.set(name, found);
    while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
    return found;
  }
  // The derived key for a stored row: refuses a row whose public key is not
  // this deployment's derivation, so no token is issued that verifiers reject
  // or that another deployment's key would have signed.
  function matching (tenant, purpose, row) {
    const parsed = parseKid(row?.kid);
    if (!parsed || parsed.purpose !== purpose) throw fail('SIGNING_KEY_MISMATCH');
    const derived = key(tenant, purpose, parsed.version);
    if (row.publicKey !== derived.raw && row.publicKey !== derived.spki) throw fail('SIGNING_KEY_MISMATCH');
    return derived;
  }
  return Object.freeze({ key, matching });
}

// The secret file named by NS_SIGNING_SECRET_FILE (or `file`). Refuses an
// absent, unreadable, too short or too long secret: a role that issues tokens
// does not start without it.
function load (source = process.env, { file } = {}) {
  const filename = file === undefined ? source?.[SETTING] : file;
  if (typeof filename !== 'string' || !filename.trim()) refuse(SETTING + ' must name the deployment signing secret file');
  let bytes;
  try {
    // An operator-selected path from the process environment; no request selects it.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const stat = fs.statSync(filename);
    if (!stat.isFile() || stat.size > MAX_BYTES + 64) throw new Error();
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    bytes = fs.readFileSync(filename);
  } catch { refuse(SETTING + ' must name a readable file'); }
  const text = bytes.toString('utf8').trim();
  bytes.fill(0);
  const secret = Buffer.from(text, 'utf8');
  try { return fromSecret(secret); } finally { secret.fill(0); }
}

module.exports = { load, fromSecret, kid, parseKid, PURPOSES, SETTING, MIN_BYTES, MAX_BYTES };
