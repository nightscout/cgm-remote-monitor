'use strict';

// Preserve the existing headless verifier. Human sessions are a distinct,
// explicitly provisioned actor, not a provider role or an implicit root exchange.
module.exports = function management ({ human, legacy }) {
  if (!human) return legacy;
  const authenticated = new WeakMap();
  async function authenticate (input) {
    if (!input.credential.startsWith('nsh_')) return legacy(input);
    const result = await human.authenticate({ ...input, purpose: 'management', activity: false,
      sensitive: input.sensitive === true });
    authenticated.set(input.request, { tenant: input.tenant, token: input.credential });
    return result.actor;
  }
  authenticate.activity = async request => {
    const selected = authenticated.get(request);
    if (!selected) return;
    await human.authenticate({ tenant: selected.tenant, credential: selected.token, request,
      purpose: 'management', activity: true });
  };
  authenticate.human = true;
  return authenticate;
};
