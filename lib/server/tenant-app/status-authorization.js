'use strict';

const extract = require('../../authorization/credential-extraction');

module.exports = function statusAuthorization ({ tenant, exchange } = {}) {
  if (typeof tenant !== 'string' || typeof exchange !== 'function') {
    throw new TypeError('Status authorization requires a trusted tenant exchange');
  }
  return async req => {
    const credentials = extract(req, { version: 1 });
    if (credentials.token) {
      const issued = await exchange({ tenant, credential: credentials.token });
      if (issued) return issued;
    }
    // Shipping status issuance differs from permission authentication: after
    // token extraction it tries header secret before query secret, never the
    // consumed body secret.
    const credential = req.header('api-secret') || req.query.secret || '';
    return credential ? exchange({ tenant, credential }) : null;
  };
};
