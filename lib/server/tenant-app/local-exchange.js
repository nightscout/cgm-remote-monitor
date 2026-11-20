'use strict';

const authorityPrincipal = require('../../tenant-authorization/authority-principal');

// Exchanges use Node/PostgreSQL only: the credential is checked against local
// verifiers and the data JWT is signed with the tenant's derived data key
// (decision deployment-signing-secret). Nothing here calls Vault.
module.exports = function createLocalExchange ({ credentials, authority, verifierContext, store, codec, signing, audit, now = Date.now }) {
  if (typeof credentials?.verifyLegacyCredential !== 'function' || typeof authority?.subjectSnapshot !== 'function' ||
      typeof verifierContext !== 'function' || typeof store?.signingKey !== 'function' || typeof codec?.issue !== 'function' ||
      typeof signing?.matching !== 'function' || typeof audit !== 'function') throw new TypeError('Local exchange requires current credentials, issuance store, signing keys and durable audit');
  return async function exchange ({ tenant, credential }) {
    const context = await verifierContext(tenant);
    if (!context || context.tenant !== tenant) throw Object.assign(new Error('TENANT_EXCHANGE_VERIFIER_INVALID'), { code: 'TENANT_EXCHANGE_VERIFIER_INVALID' });
    const principal = await credentials.verifyLegacyCredential(context, { token: credential, apiSecret: credential });
    if (!principal || principal.kind !== 'subject') return null;
    const subject = await authority.subjectSnapshot({ tenant, principal: authorityPrincipal(principal) });
    if (!subject) return null;
    const receipt = operation => audit(Object.freeze({ tenant, principal: context.principal, consumer: context.consumer,
      operation, phase: 'authorized', time: now() }));
    await receipt('sign');
    // The stored signing row names the version (kid data-<n>); the key is
    // derived for it and must match the stored public key.
    const key = signing.matching(tenant, 'data', await store.signingKey(tenant));
    const issued = codec.issue(tenant, principal, key);
    await receipt('verify');
    const time = Math.floor(now() / 1000);
    if (issued.iat > time || issued.exp <= time) throw Object.assign(new Error('SECRETS_TOKEN_INVALID'), { code: 'SECRETS_TOKEN_INVALID' });
    return Object.freeze({ ...issued, sub: subject.sub, permissionGroups: subject.permissionGroups });
  };
};
