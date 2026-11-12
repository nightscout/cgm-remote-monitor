'use strict';

// Human session keys are tenant-scoped registry attributes, separate from the
// device access/management keys. Refresh follows the registry entry revision;
// no deployment-sized key list is loaded or scanned on a request.
const { createPublicKey } = require('node:crypto');
const { createHumanAccess, createHumanTokenSelector } = require('./access');
const accessConfig = require('./access-config');
const { createVaultAccessSigner } = require('../secrets/vault-access-signing');
const rules = require('../tenant-registry/rules');
const { HUMAN_KIDS } = require('../tenant-registry/provision');
const invalid = () => { throw new TypeError('Explicit registry-backed human access configuration required'); };

function createRegistryHumanAccess ({ source, registry, legacyProfiles = [], createSigner = createVaultAccessSigner }) {
  if (accessConfig.localSigning(source)) invalid();
  const config = accessConfig.read(source);
  if (config.registry !== true || typeof registry?.entry !== 'function' ||
      !Number.isSafeInteger(registry.maxTenants) || registry.maxTenants < 1 || registry.maxTenants > 100000) invalid();
  accessConfig.fields(config.audiences, ['data', 'management']);
  if (legacyProfiles.some(profile => profile && profile.issuer === config.issuer &&
      [config.audiences.data, config.audiences.management].includes(profile.audience))) {
    throw new TypeError('Human and headless access verification namespaces must be disjoint');
  }
  accessConfig.fields(config.vault, ['addressEnv', 'mount'], ['tokenEnv', 'tokenFile', 'allowInsecureLoopback']);
  const vault = require('../server/serve/registry-config').vault({
    address: accessConfig.reference(source, config.vault.addressEnv), mount: config.vault.mount,
    ...(config.vault.tokenEnv === undefined ? {} : { tokenEnv: config.vault.tokenEnv }),
    ...(config.vault.tokenFile === undefined ? {} : { tokenFile: config.vault.tokenFile }),
    ...(config.vault.allowInsecureLoopback === undefined ? {} : { allowInsecureLoopback: config.vault.allowInsecureLoopback })
  }, source, invalid);
  const cache = new Map();
  async function selected (tenant) {
    const entry = await registry.entry(tenant);
    if (!entry || entry.tenant !== tenant || entry.state !== 'active') throw Object.assign(new Error('HUMAN_SESSION_REFUSED'), { code: 'HUMAN_SESSION_REFUSED' });
    let hit = cache.get(tenant);
    if (!hit || hit.entry !== entry) {
      const keys = [];
      const headless = new Set(entry.keys.filter(key => ['access', 'management'].includes(key.purpose)).map(key => key.publicKey));
      for (const purpose of ['data', 'management']) {
        const supplied = entry.keys.filter(key => key.purpose === 'human-' + purpose);
        if (supplied.length !== 1 || supplied[0].kid !== HUMAN_KIDS[purpose] || headless.has(supplied[0].publicKey)) invalid();
        const key = supplied[0], bytes = Buffer.from(key.publicKey, 'base64');
        if (bytes.length !== 32 || bytes.toString('base64') !== key.publicKey) invalid();
        const signer = createSigner({ ...vault, signingKey: rules.vaultKey(tenant, 'human-' + purpose), signingVersion: 1 });
        keys.push({ tenant, purpose, kid: key.kid, current: true, sign: signer.sign,
          publicKey: createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: bytes.toString('base64url') } }) });
      }
      hit = { entry, access: createHumanAccess({ issuer: config.issuer, audiences: config.audiences, keys, mode: 'multi' }) };
    }
    cache.delete(tenant); cache.set(tenant, hit);
    while (cache.size > registry.maxTenants) cache.delete(cache.keys().next().value);
    return hit.access;
  }
  return Object.freeze({
    accepts: createHumanTokenSelector(config),
    async keyId (input) { return (await selected(input.tenant)).keyId(input); },
    async issue (input) { return (await selected(input.tenant)).issue(input); },
    async verify (input) { return (await selected(input.tenant)).verify(input); },
    stats: () => Object.freeze({ tenants: cache.size })
  });
}

module.exports = { createRegistryHumanAccess };
