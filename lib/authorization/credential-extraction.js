'use strict';

// Extraction only: the tenant verifier, never the process enclave, interprets
// the selected credential. Single-tenant authorization retains its own reader.
module.exports = function extract (req, { version } = {}) {
  if (![1, 2, 3].includes(version)) throw new TypeError('An API version is required');
  const query = req.query || {};
  const body = req.body;
  const first = Array.isArray(body) ? body[0] : body;
  const headers = {};
  let invalid = false;
  for (let i = 0; i < (req.rawHeaders || []).length; i += 2) {
    const name = req.rawHeaders[i].toLowerCase();
    if (!['authorization', 'api-secret'].includes(name)) continue;
    if (Object.hasOwn(headers, name)) invalid = true;
    headers[name] = req.rawHeaders[i + 1];
  }
  const header = name => Object.hasOwn(headers, name) ? headers[name]
    : typeof req.header === 'function' ? req.header(name) : undefined;
  const authorization = header('authorization');
  const secretHeader = header('api-secret');
  const has = (obj, key) => obj != null && Object.hasOwn(obj, key);
  const legacyPresented = ['token', 'secret'].some(key => has(query, key) || has(first, key));
  const presented = authorization !== undefined || secretHeader !== undefined || legacyPresented;
  let token;
  if (authorization) {
    const parts = authorization.split(' ');
    if (parts.length === 2 && (version === 3 ? parts[0].toLowerCase() === 'bearer' : parts[0] === 'Bearer')) {
      token = parts[1];
    } else invalid = true;
  }
  let apiSecret;
  if (version === 3) {
    if (legacyPresented) invalid = true;
    if (token && !/^[^\s,]+$/.test(token)) invalid = true;
    apiSecret = secretHeader;
  } else {
    apiSecret = req.api_secret || query.secret || secretHeader;
    if (!apiSecret && first && first.secret) {
      apiSecret = first.secret;
      delete first.secret;
    }
    token = req.auth_token || token;
    if (!token) {
      token = query.token;
      if (!token && first && first.token) {
        token = first.token;
        delete first.token;
      }
    }
  }
  if ([token, apiSecret].some(value => value !== undefined && (typeof value !== 'string' || !value))) invalid = true;
  if (presented && !token && !apiSecret) invalid = true;
  return Object.freeze({ token, apiSecret, presented, invalid });
};
