'use strict';
const { createAuthentication, createVerifier } = require('../../tenant-authorization/access-token');

module.exports = function managementAuthentication ({ verification, snapshot, consumer }) {
  // This trusted consumer is deployment configuration, never a token/body claim.
  if (typeof consumer !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(consumer) ||
      !verification || verification.purpose !== 'management' || verification.maxLifetimeSeconds > 600) {
    throw new TypeError('Explicit bounded management verification and trusted consumer required');
  }
  const authenticate = createAuthentication({ verifyToken: createVerifier(verification), snapshot });
  return async function authenticateManagement ({ tenant, credential }) {
    try {
      const { claims } = await authenticate({ tenant, token: credential });
      return Object.freeze({ tenant, principal: claims.sub, consumer });
    } catch (error) {
      // Credential failures follow the existing management factory's null→401
      // contract. Store errors remain errors (sanitized 503); no fallback.
      if (error && (typeof error.code === 'string' && error.code.startsWith('TOKEN_') || error.code === 'AUTHORITY_FORBIDDEN')) return null;
      throw error;
    }
  };
};
