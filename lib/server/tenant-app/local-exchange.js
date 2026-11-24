'use strict';

const authorityPrincipal = require('../../tenant-authorization/authority-principal');
const requestReads = require('./request-reads');

// Exchanges use Node/PostgreSQL only: the credential is checked against local
// verifiers and the data JWT is signed with the tenant's derived data key
// (decision deployment-signing-secret). Nothing here calls Vault.
module.exports = function createLocalExchange ({ credentials, authority, verifierContext, store, codec, signing, audit, now = Date.now }) {
  if (typeof credentials?.verifyLegacyCredential !== 'function' || typeof authority?.subjectSnapshot !== 'function' ||
      typeof verifierContext !== 'function' || typeof store?.signingKey !== 'function' || typeof codec?.issue !== 'function' ||
      typeof signing?.matching !== 'function' || typeof audit !== 'function') throw new TypeError('Local exchange requires current credentials, issuance store, signing keys and durable audit');
  // request: the HTTP request this exchange serves, when it has one. A request
  // already authenticated with this credential reuses its verifier and subject
  // reads (decision credential-rotation-next-request); the checks run again.
  return async function exchange ({ tenant, credential, request }) {
    const context = await verifierContext(tenant);
    if (!context || context.tenant !== tenant) throw Object.assign(new Error('TENANT_EXCHANGE_VERIFIER_INVALID'), { code: 'TENANT_EXCHANGE_VERIFIER_INVALID' });
    const memo = requestReads.forRequest(request);
    const principal = await credentials.verifyLegacyCredential(context, { token: credential, apiSecret: credential }, undefined, memo);
    if (!principal || principal.kind !== 'subject') return null;
    const named = authorityPrincipal(principal);
    const subject = typeof authority.subjectAuthorizationSnapshot === 'function'
      ? (await requestReads.once(memo, 'subject:' + tenant + ':' + named.subjectId,
        () => authority.subjectAuthorizationSnapshot({ tenant, principal: named })))?.subject || null
      : await authority.subjectSnapshot({ tenant, principal: named });
    if (!subject) return null;
    // Both receipts are durable in one append before the key is derived or
    // anything is signed.
    const time = now();
    await Promise.all(['sign', 'verify'].map(operation => audit(Object.freeze({ tenant, principal: context.principal,
      consumer: context.consumer, operation, phase: 'authorized', time }))));
    // The stored signing row names the version (kid data-<n>); the key is
    // derived for it and must match the stored public key. The verifier read
    // already carries that row.
    const stored = typeof credentials.signingKey === 'function' ? credentials.signingKey(principal) : undefined;
    const key = signing.matching(tenant, 'data', stored || await store.signingKey(tenant));
    const issued = codec.issue(tenant, principal, key);
    const seconds = Math.floor(now() / 1000);
    if (issued.iat > seconds || issued.exp <= seconds) throw Object.assign(new Error('SECRETS_TOKEN_INVALID'), { code: 'SECRETS_TOKEN_INVALID' });
    return Object.freeze({ ...issued, sub: subject.sub, permissionGroups: subject.permissionGroups });
  };
};
