'use strict';

// Only for results already authenticated by a trusted credential verifier.
// Credential generations belong to token verification/issuance. The authority
// accepts identity alone and reads current permissions for this operation.
// Retain unknown fields so its strict principal validation still rejects them.
module.exports = function authorityPrincipal (verified) {
  if (!verified) return verified;
  const { credentialVersion, rootVersion, ...principal } = verified;
  void credentialVersion; void rootVersion;
  return Object.freeze(principal);
};
