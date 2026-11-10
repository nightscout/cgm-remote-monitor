'use strict';

const { createPublicKey } = require('node:crypto');
const { createHumanAccess, createHumanTokenSelector } = require('./access');
const { privateSetting } = require('./private-setting');
const local = require('./local-signing');
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
// OIDC_ACCESS_CONFIG carries the JSON inline, or OIDC_ACCESS_CONFIG_FILE names a
// private file; never both. An OIDC_ACCESS_CONFIG value that is not a JSON
// object is the earlier form of the setting, a file path, and is still read.
function text (source) {
  return privateSetting(source, 'OIDC_ACCESS_CONFIG', { legacyPath: value => !value.trimStart().startsWith('{') });
}
function read (source) {
  const value = text(source);
  if (value === undefined) invalid();
  let config;
  try { config = JSON.parse(value); } catch { invalid(); }
  fields(config, ['version', 'issuer', 'audiences', 'vault', 'keys']);
  if (config.version !== 1) invalid();
  // This constructor validates only the public namespace; it performs no I/O.
  createHumanTokenSelector(config);
  return config;
}

// Single-site may sign locally instead: OIDC_ACCESS_SIGNING_KEY(_FILE) holds one
// Ed25519 private key, and issuer, audiences and key IDs derive from it and
// OIDC_ORIGIN. A site sets either the access file or the local key, not both.
function localSigning (source) {
  const configured = local.configured(source);
  if (configured && text(source) !== undefined) {
    throw new TypeError('Set the OIDC access configuration or the local OIDC signing key, not both');
  }
  return configured;
}

function humanRouting (source = process.env) {
  if (!(source.ENABLE || '').split(/\s+/).includes('oidc')) return () => false;
  if (localSigning(source)) return createHumanTokenSelector(local.namespace(source.OIDC_ORIGIN));
  return createHumanTokenSelector(read(source));
}

function loadHumanAccess ({ source = process.env, mode, tenants, legacyProfiles = [] }) {
  if (!['single', 'multi'].includes(mode) || !Array.isArray(tenants) || !tenants.length ||
      new Set(tenants).size !== tenants.length || mode === 'single' && (tenants.length !== 1 || tenants[0] !== 'single')) invalid();
  if (localSigning(source)) {
    // Multitenant signing stays behind Vault Transit.
    if (mode !== 'single') throw new TypeError('A local OIDC signing key is single-site only');
    return createHumanAccess({ ...local.load(source), mode });
  }
  const config = read(source);
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

module.exports = { loadHumanAccess, humanRouting, localSigning };
