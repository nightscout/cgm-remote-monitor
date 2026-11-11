'use strict';

// Tenant provisioning as a versioned REST resource on the admin listener
// (decisions provisioning-split and operator-rest-api). Described by
// ./openapi.json. Core does not authenticate callers: the admin listener is the
// platform operator's private plane, and the deployment controls who reaches
// it (as with Ory's admin APIs).
//
//   POST /v1/tenants          one tenant; 201 created, 200 existing
//   POST /v1/tenants/batch    at most 100; 200 with one result per tenant
//   GET  /v1/tenants/{id}     the registry's view of one tenant
//   GET  /v1/openapi.json     this description
//
// The idempotency key is the tenant id. An `Idempotency-Key` header, when sent,
// must equal it. A retried request is answered from the registry ('existing').
// Errors are RFC 9457 problem documents with a stable `code`.
// A root secret appears in a response only on 'created' when the request set
// issueRootSecret, and is never logged.
const MAX_BATCH = require('./provision').MAX_BATCH;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATUS = Object.freeze({
  TENANT_PROVISION_INVALID: 422, TENANT_PROVISION_HOST_INVALID: 422, TENANT_PROVISION_IDEMPOTENCY_KEY_MISMATCH: 422,
  TENANT_PROVISION_BATCH_INVALID: 422, TENANT_PROVISION_BATCH_DUPLICATE: 422,
  TENANT_PROVISION_CONFLICT: 409, TENANT_PROVISION_REMOVED: 409, TENANT_PROVISION_LOCK_COLLISION: 409,
  TENANT_PROVISION_VAULT_KEY_MISMATCH: 409,
  TENANT_NOT_FOUND: 404, ROUTE_NOT_FOUND: 404, METHOD_NOT_ALLOWED: 405, UNSUPPORTED_MEDIA_TYPE: 415, PAYLOAD_TOO_LARGE: 413, BODY_INVALID: 400,
  TENANT_PROVISION_VAULT_REFUSED: 502, TENANT_PROVISION_VAULT_UNAVAILABLE: 503, TENANT_PROVISION_FAILED: 503, SERVICE_CLOSED: 503
});
const TITLES = Object.freeze({ 400: 'Bad Request', 404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict', 413: 'Content Too Large', 415: 'Unsupported Media Type',
  422: 'Unprocessable Content', 502: 'Bad Gateway', 503: 'Service Unavailable' });

function send (res, status, body, headers = {}) {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json', 'content-length': bytes.length,
    'cache-control': 'no-store', ...headers });
  res.end(bytes);
}
function problem (res, code, extra = {}) {
  const status = STATUS[code] || 503;
  send(res, status, { type: 'urn:nightscout:problem:' + code.toLowerCase().replace(/_/g, '-'), title: TITLES[status] || 'Error', status, code, ...extra },
    status === 503 ? { 'retry-after': '5' } : {});
}
const fail = code => Object.assign(new Error(code), { code });

async function body (req, maxBytes) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw fail('UNSUPPORTED_MEDIA_TYPE');
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > maxBytes) throw fail('PAYLOAD_TOO_LARGE'); chunks.push(chunk); }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw fail('BODY_INVALID'); }
}

// A per-tenant result as the API states it (code only on refused).
function result (row) {
  return { id: row.id, ...(row.ref ? { ref: row.ref } : {}), outcome: row.outcome, ...(row.code ? { code: row.code } : {}),
    ...(row.rootSecret ? { rootSecret: row.rootSecret } : {}) };
}

function createProvisioningApi ({ provisioning, maxBytes = 1048576, admitted = () => true, log = () => {} }) {
  if (!provisioning || typeof provisioning.provision !== 'function' || typeof provisioning.provisionBatch !== 'function' || typeof provisioning.get !== 'function') {
    throw new TypeError('Provisioning API requires the provisioning library');
  }
  const openapi = require('./openapi.json');
  async function handle (req, res) {
    const url = new URL(req.url, 'http://admin.invalid');
    const path = url.pathname;
    if (admitted(req) !== true) return problem(res, 'SERVICE_CLOSED');
    if (url.search) return problem(res, 'ROUTE_NOT_FOUND');
    if (path === '/v1/openapi.json') {
      if (req.method !== 'GET') return problem(res, 'METHOD_NOT_ALLOWED');
      return send(res, 200, openapi);
    }
    if (path === '/v1/tenants') {
      if (req.method !== 'POST') return problem(res, 'METHOD_NOT_ALLOWED');
      const input = await body(req, maxBytes);
      const key = req.headers['idempotency-key'];
      if (key !== undefined && key !== input.id) return problem(res, 'TENANT_PROVISION_IDEMPOTENCY_KEY_MISMATCH');
      const row = await provisioning.provision(input);
      log({ operation: 'provision', outcome: row.outcome, ...(row.code ? { code: row.code } : {}) });
      if (row.outcome === 'refused') return problem(res, row.code, { id: row.id, ...(row.ref ? { ref: row.ref } : {}) });
      return send(res, row.outcome === 'created' ? 201 : 200, result(row), { location: '/v1/tenants/' + row.id });
    }
    if (path === '/v1/tenants/batch') {
      if (req.method !== 'POST') return problem(res, 'METHOD_NOT_ALLOWED');
      const input = await body(req, maxBytes);
      if (Object.keys(input).length !== 1 || !Array.isArray(input.tenants) || !input.tenants.length || input.tenants.length > MAX_BATCH) {
        return problem(res, 'TENANT_PROVISION_BATCH_INVALID', { detail: 'tenants: 1..' + MAX_BATCH });
      }
      const rows = await provisioning.provisionBatch(input.tenants);
      const counts = {};
      for (const row of rows) counts[row.outcome] = (counts[row.outcome] || 0) + 1;
      log({ operation: 'provision-batch', ...counts });
      return send(res, 200, { results: rows.map(result) });
    }
    const match = /^\/v1\/tenants\/([^/]+)$/.exec(path);
    if (match) {
      if (req.method !== 'GET') return problem(res, 'METHOD_NOT_ALLOWED');
      if (!UUID.test(match[1])) return problem(res, 'TENANT_PROVISION_INVALID');
      const tenant = await provisioning.get(match[1]);
      if (!tenant) return problem(res, 'TENANT_NOT_FOUND');
      return send(res, 200, tenant);
    }
    return problem(res, 'ROUTE_NOT_FOUND');
  }
  return Object.assign(async (req, res) => {
    try { await handle(req, res); } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const code = typeof error?.code === 'string' && Object.hasOwn(STATUS, error.code) ? error.code : 'TENANT_PROVISION_FAILED';
      problem(res, code);
    }
  }, { prefix: '/v1/' });
}

module.exports = { createProvisioningApi, STATUS };
