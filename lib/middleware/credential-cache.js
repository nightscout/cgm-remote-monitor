'use strict';

// Legacy clients authenticate in the query string; newer ones use headers.
// Check presence without consuming, rewriting or validating any credential.
module.exports = function credentialCache (req, res, next) {
  const query = req.query || {};
  const headers = req.headers || {};
  if (Object.prototype.hasOwnProperty.call(query, 'token') ||
      Object.prototype.hasOwnProperty.call(query, 'secret') ||
      headers.authorization !== undefined || headers['api-secret'] !== undefined ||
      /^\/api\/v2\/authorization\/request\//i.test(req.path)) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
};
