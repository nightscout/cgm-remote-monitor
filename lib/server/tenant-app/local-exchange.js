'use strict';

// New exchanges use Node/PostgreSQL only. The previous HS256 profile is accepted
// solely here for renewal; no DATA or socket verifier has that Vault capability.
module.exports = function createLocalExchange ({ credentials, secrets, authority, verifierContext, store, codec, audit, now = Date.now }) {
  if (typeof credentials?.verifyLegacyCredential !== 'function' || typeof credentials.currentSubject !== 'function' ||
      typeof secrets?.verifyLegacyCredential !== 'function' || typeof authority?.subjectSnapshot !== 'function' ||
      typeof verifierContext !== 'function' || typeof store?.signingKey !== 'function' || typeof codec?.issue !== 'function' ||
      typeof audit !== 'function') throw new TypeError('Local exchange requires current credentials, issuance store and durable audit');
  return async function exchange ({ tenant, credential, renewPrevious = true }) {
    const context = await verifierContext(tenant);
    if (!context || context.tenant !== tenant) throw Object.assign(new Error('TENANT_EXCHANGE_VERIFIER_INVALID'), { code: 'TENANT_EXCHANGE_VERIFIER_INVALID' });
    let principal;
    let oldProfile = false;
    if (typeof credential === 'string' && credential.length <= 8192) {
      try {
        const header = JSON.parse(Buffer.from(credential.split('.')[0], 'base64url'));
        oldProfile = header.alg === 'HS256' && header.typ === 'JWT';
      } catch { /* Plain legacy credentials use the local verifier. */ }
    }
    if (oldProfile && renewPrevious !== true) return null;
    if (oldProfile) {
      const previous = await secrets.verifyLegacyCredential(context, { token: credential, apiSecret: credential });
      principal = previous?.kind === 'subject' ? await credentials.currentSubject(tenant, previous.subjectId) : null;
    } else principal = await credentials.verifyLegacyCredential(context, { token: credential, apiSecret: credential });
    if (!principal || principal.kind !== 'subject') return null;
    const subject = await authority.subjectSnapshot({ tenant, principal });
    if (!subject) return null;
    const receipt = operation => audit(Object.freeze({ tenant, principal: context.principal, consumer: context.consumer,
      operation, phase: 'authorized', time: now() }));
    await receipt('sign');
    // Private signing material is read only at explicit issuance, never for DATA.
    const key = await store.signingKey(tenant);
    const issued = codec.issue(tenant, principal, key);
    await receipt('verify');
    const time = Math.floor(now() / 1000);
    if (issued.iat > time || issued.exp <= time) throw Object.assign(new Error('SECRETS_TOKEN_INVALID'), { code: 'SECRETS_TOKEN_INVALID' });
    return Object.freeze({ ...issued, sub: subject.sub, permissionGroups: subject.permissionGroups });
  };
};
