'use strict';

// Versioned operator source-definition resource. Only references and validated
// configuration are exchanged; endpoint/credential values remain tenant secrets.
const ROUTE = /^\/v1\/tenants\/([0-9a-f-]{36})\/connector-sources(?:\/([A-Za-z0-9_-]{1,128}))?$/;
const STATUS = Object.freeze({ CONNECTOR_DEFINITION_INVALID: 422, CONNECTOR_GENERATION_CONFLICT: 409, CONNECTOR_SECRET_REFERENCE_REFUSED: 422,
  CONNECTOR_TENANT_REFUSED: 404, CONNECTOR_SOURCE_NOT_FOUND: 404, LIFECYCLE_WINDOW_SUSPENDED: 423, CONNECTOR_DEFINITION_UNSAFE: 503 });
function reply (res, status, body, problem = false) {
  if (problem) body = { type: 'urn:nightscout:problem:' + body.code.toLowerCase().replaceAll('_', '-'), title: 'Connector source operation refused', status, ...body };
  res.writeHead(status, { 'content-type': problem ? 'application/problem+json' : 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body));
}
function create ({ store, maxBytes = 65536, admitted = () => true }) {
  return Object.freeze({ matches: url => url === '/v1/openapi.json' || typeof url === 'string' && /^\/v1\/tenants\/[^/]+\/connector-sources(?:\/|\?|$)/.test(url),
    async handle (req, res) {
      try {
        if (!admitted()) throw Object.assign(new Error(), { code: 'SERVICE_CLOSED' });
        if (req.url === '/v1/openapi.json' && req.method === 'GET') return reply(res, 200, require('../tenant-registry/openapi.json'));
        const url = new URL(req.url, 'http://operator.invalid'), match = ROUTE.exec(url.pathname);
        if (!match) return reply(res, 404, { code: 'ROUTE_NOT_FOUND' }, true);
        const [, tenant, source] = match;
        if (req.method === 'GET') {
          if (source) { const row = await store.get(tenant, source); if (!row) throw Object.assign(new Error(), { code: 'CONNECTOR_SOURCE_NOT_FOUND' }); return reply(res, 200, row); }
          if ([...url.searchParams.keys()].some(key => !['after', 'limit'].includes(key)) || [...url.searchParams.keys()].some(key => url.searchParams.getAll(key).length !== 1)) throw Object.assign(new Error(), { code: 'CONNECTOR_DEFINITION_INVALID' });
          return reply(res, 200, { sources: await store.list(tenant, { after: url.searchParams.get('after') || '', limit: Number(url.searchParams.get('limit') || 100) }) });
        }
        if (!source || url.search) return reply(res, 405, { code: 'METHOD_NOT_ALLOWED' }, true);
        if (req.method === 'PUT') {
          if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) return reply(res, 415, { code: 'UNSUPPORTED_MEDIA_TYPE' }, true);
          const chunks = []; let bytes = 0;
          for await (const chunk of req) { bytes += chunk.length; if (bytes > maxBytes) return reply(res, 413, { code: 'PAYLOAD_TOO_LARGE' }, true); chunks.push(chunk); }
          let input; try { input = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw Object.assign(new Error(), { code: 'CONNECTOR_DEFINITION_INVALID' }); }
          const result = await store.put(tenant, source, input); return reply(res, result.outcome === 'created' ? 201 : 200, result);
        }
        if (req.method === 'DELETE') {
          const value = req.headers['if-match'];
          if (typeof value !== 'string' || !/^"[1-9][0-9]{0,15}"$/.test(value)) throw Object.assign(new Error(), { code: 'CONNECTOR_DEFINITION_INVALID' });
          return reply(res, 200, await store.remove(tenant, source, Number(value.slice(1, -1))));
        }
        return reply(res, 405, { code: 'METHOD_NOT_ALLOWED' }, true);
      } catch (error) {
        if (res.headersSent) { res.destroy(); return; }
        const code = Object.hasOwn(STATUS, error.code) ? error.code : 'CONNECTOR_DEFINITION_UNAVAILABLE';
        const status = STATUS[code] || 503;
        reply(res, status, { type: 'urn:nightscout:problem:' + code.toLowerCase().replaceAll('_', '-'), title: 'Connector source operation refused', status, code }, true);
      }
    } });
}
module.exports = { create, STATUS };
