'use strict';

const fs = require('node:fs');
const { createPublicKey } = require('node:crypto');
const { createHumanAccess, createHumanTokenSelector } = require('./access');
const { createVaultAccessSigner } = require('../secrets/vault-access-signing');
const { tokenFilePath, tokenFileReader } = require('../secrets/vault-token-source');
const invalid = () => { throw new TypeError('Invalid explicit human access issuer configuration'); };
function fields (value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}
function reference (source, name) {
  if (typeof name !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(name) ||
      typeof source[name] !== 'string' || !source[name].trim()) invalid();
  return source[name];
}
function read (source) {
  const filename = reference(source, 'OIDC_ACCESS_CONFIG');
  // Private operator-selected file; no request value can select its path.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const stat = fs.statSync(filename);
  if (!stat.isFile() || stat.size > 1048576) invalid();
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const bytes = fs.readFileSync(filename);
  if (bytes.length > 1048576) invalid();
  const config = JSON.parse(bytes.toString('utf8'));
  fields(config, ['version', 'issuer', 'audiences', 'vault', 'keys']);
  if (config.version !== 1) invalid();
  // This constructor validates only the public namespace; it performs no I/O.
  createHumanTokenSelector(config);
  return config;
}

function humanRouting (source = process.env) {
  if (!(source.ENABLE || '').split(/\s+/).includes('oidc')) return () => false;
  return createHumanTokenSelector(read(source));
}

function loadHumanAccess ({ source = process.env, mode, tenants, legacyProfiles = [] }) {
  const config = read(source);
  if (!['single', 'multi'].includes(mode) || !Array.isArray(tenants) || !tenants.length ||
      new Set(tenants).size !== tenants.length || mode === 'single' && (tenants.length !== 1 || tenants[0] !== 'single')) invalid();
  if (legacyProfiles.some(profile => profile && profile.issuer === config.issuer &&
      [config.audiences.data, config.audiences.management].includes(profile.audience))) {
    throw new TypeError('Human and headless access verification namespaces must be disjoint');
  }
  fields(config.audiences, ['data', 'management']);
  fields(config.vault, ['addressEnv', 'mount'], ['tokenEnv', 'tokenFile', 'allowInsecureLoopback']);
  if (config.vault.allowInsecureLoopback !== undefined && config.vault.allowInsecureLoopback !== true) invalid();
  const address = reference(source, config.vault.addressEnv);
  // Exactly one credential source: an environment reference resolved at bootstrap, or a
  // Vault Agent sink file read at every signing call. Never both, never neither.
  if ((config.vault.tokenEnv === undefined) === (config.vault.tokenFile === undefined)) invalid();
  let getToken;
  if (config.vault.tokenEnv !== undefined) {
    reference(source, config.vault.tokenEnv);
    getToken = () => reference(source, config.vault.tokenEnv);
  } else {
    getToken = tokenFileReader(tokenFilePath(config.vault.tokenFile, invalid));
  }
  if (!Array.isArray(config.keys) || !config.keys.length || config.keys.length > 10000) invalid();
  const current = new Set();
  const keys = config.keys.map(key => {
    fields(key, ['tenant', 'purpose', 'kid', 'publicKey', 'current'], ['signingKey', 'signingVersion']);
    if (!tenants.includes(key.tenant) || !['data', 'management'].includes(key.purpose) ||
        typeof key.publicKey !== 'string' || typeof key.current !== 'boolean') invalid();
    const bytes = Buffer.from(key.publicKey, 'base64');
    if (bytes.length !== 32 || bytes.toString('base64') !== key.publicKey) invalid();
    let sign;
    if (key.current) {
      const selected = key.tenant + ':' + key.purpose;
      if (current.has(selected)) invalid(); current.add(selected);
      const signer = createVaultAccessSigner({ address, mount: config.vault.mount,
        signingKey: key.signingKey, signingVersion: key.signingVersion,
        allowInsecureLoopback: config.vault.allowInsecureLoopback === true, getToken });
      sign = signer.sign;
    }
    return { tenant: key.tenant, purpose: key.purpose, kid: key.kid, current: key.current,
      publicKey: createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: bytes.toString('base64url') } }), ...(sign ? { sign } : {}) };
  });
  for (const tenant of tenants) for (const purpose of ['data', 'management']) if (!current.has(tenant + ':' + purpose)) invalid();
  return createHumanAccess({ issuer: config.issuer, audiences: config.audiences, keys, mode });
}

module.exports = { loadHumanAccess, humanRouting };
