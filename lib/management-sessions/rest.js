'use strict';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ROUTE = new RegExp('^/v1/tenants/(' + UUID + ')/management-sessions$');
const STATUS = Object.freeze({ MANAGEMENT_SESSION_INVALID: 422, MANAGEMENT_SESSION_CONFLICT: 409, MANAGEMENT_SESSION_EXPIRED: 409,
  MANAGEMENT_SESSION_REFUSED: 403, MANAGEMENT_SESSION_KEY_REFUSED: 409, MANAGEMENT_SESSION_UNAVAILABLE: 503,
  BODY_INVALID: 400, UNSUPPORTED_MEDIA_TYPE: 415, PAYLOAD_TOO_LARGE: 413, METHOD_NOT_ALLOWED: 405, ROUTE_NOT_FOUND: 404 });
const fail = code => Object.assign(new Error(code), { code });
function send (res, status, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json', 'cache-control': 'no-store', 'content-length': bytes.length }); res.end(bytes);
}
function createManagementApi ({ service, maxBytes = 16384, admitted = () => true, log = () => {}, includeOpenapi = true }) {
  if (!service || typeof service.issue !== 'function') throw new TypeError('Private management session issuance service required');
  const openapi = require('./openapi.json');
  const matches = value => {
    try { const path = new URL(value, 'http://admin.invalid').pathname; return ROUTE.test(path) || includeOpenapi && path === '/v1/openapi.json'; } catch { return false; }
  };
  return Object.assign(async (req, res) => {
    try {
      if (!admitted()) throw fail('MANAGEMENT_SESSION_UNAVAILABLE');
      const url = new URL(req.url, 'http://admin.invalid'), matched = ROUTE.exec(url.pathname);
      if (includeOpenapi && url.pathname === '/v1/openapi.json' && req.method === 'GET' && !url.search) return send(res, 200, openapi);
      if (!matched || url.search) throw fail('ROUTE_NOT_FOUND');
      if (req.method !== 'POST') throw fail('METHOD_NOT_ALLOWED');
      if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') throw fail('UNSUPPORTED_MEDIA_TYPE');
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > maxBytes) throw fail('PAYLOAD_TOO_LARGE'); chunks.push(chunk); }
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('BODY_INVALID'); }
      if (!input || typeof input !== 'object' || Array.isArray(input) || !['subjectId', 'requestId'].every(name => Object.hasOwn(input, name)) ||
          Object.keys(input).some(name => !['subjectId', 'requestId', 'lifetimeSeconds'].includes(name)) ||
          req.headers['idempotency-key'] !== undefined && req.headers['idempotency-key'] !== input.requestId) throw fail('MANAGEMENT_SESSION_INVALID');
      const result = await service.issue({ ...input, tenant: matched[1] });
      log({ operation: 'management-session-issue', outcome: result.outcome });
      send(res, result.outcome === 'created' ? 201 : 200, result);
    } catch (error) {
      const code = Object.hasOwn(STATUS, error.code) ? error.code : 'MANAGEMENT_SESSION_UNAVAILABLE';
      log({ operation: 'management-session-issue', outcome: 'refused', code });
      send(res, STATUS[code], { type: 'urn:nightscout:problem:' + code.toLowerCase().replaceAll('_', '-'), status: STATUS[code], code });
    }
  }, { matches, openapi });
}
module.exports = { createManagementApi };
