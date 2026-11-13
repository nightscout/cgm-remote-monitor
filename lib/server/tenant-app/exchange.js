'use strict';

module.exports = function createExchange ({ secrets, authority, verifierContext }) {
  if (!secrets || typeof secrets.exchangeLegacyCredential !== 'function' ||
      !authority || typeof authority.subjectSnapshot !== 'function' || typeof verifierContext !== 'function') {
    throw new TypeError('Exchange requires secrets, current subject authority and trusted verifier identity');
  }
  return async function exchange ({ tenant, credential }) {
    const context = await verifierContext(tenant);
    if (!context || context.tenant !== tenant) {
      throw Object.assign(new Error('TENANT_EXCHANGE_VERIFIER_INVALID'), { code: 'TENANT_EXCHANGE_VERIFIER_INVALID' });
    }
    let subject;
    const issued = await secrets.exchangeLegacyCredential(context, credential, async principal => {
      subject = await authority.subjectSnapshot({ tenant, principal });
      return subject !== null;
    });
    return issued ? Object.freeze({ ...issued, sub: subject.sub, permissionGroups: subject.permissionGroups }) : null;
  };
};
