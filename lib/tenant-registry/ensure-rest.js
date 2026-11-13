'use strict';

const shape = require('./ensure-shape');
const openapi = require('./openapi.json');
const send = (res,status,value) => {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status,{'content-type':'application/json','content-length':body.length,'cache-control':'no-store'}); res.end(body);
};
function createEnsureApi ({ service, maxBytes = 65536, admitted = () => true, log = () => {}, fallback = (_req,res) => send(res,404,{code:'ROUTE_NOT_FOUND'}) }) {
  if (typeof service?.ensure !== 'function' || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1048576) throw new TypeError('Bounded ensure service required');
  return async (req,res) => {
    const url = new URL(req.url,'http://admin.invalid'), match = /^\/v1\/tenants\/([^/]+)\/ensure$/.exec(url.pathname);
    if (!match) {
      if (url.pathname === '/v1/openapi.json' && req.method === 'GET' && !url.search) return send(res,200,openapi);
      return fallback(req,res);
    }
    try {
      if (admitted() !== true) return send(res,503,{code:'SERVICE_CLOSED'});
      if (url.search) return send(res,404,{code:'ROUTE_NOT_FOUND'});
      if (req.method !== 'POST') return send(res,405,{code:'METHOD_NOT_ALLOWED'});
      if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') return send(res,415,{code:'UNSUPPORTED_MEDIA_TYPE'});
      let size = 0; const chunks = [];
      for await (const bytes of req) { size += bytes.length; if (size > maxBytes) return send(res,413,{code:'PAYLOAD_TOO_LARGE'}); chunks.push(bytes); }
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(res,400,{code:'BODY_INVALID'}); }
      if (!shape.request(input) || input.id !== match[1]) return send(res,422,{code:'TENANT_ENSURE_INVALID'});
      const result = await service.ensure(input);
      if (!shape.result(result) || result.id !== input.id || result.operationId !== input.operationId) throw Error('unexpected ensure result');
      log({operation:'ensure',outcome:result.outcome,code:result.code});
      return send(res,200,result);
    } catch (error) {
      if (error?.code === 'TENANT_ENSURE_INVALID') return send(res,422,{code:'TENANT_ENSURE_INVALID'});
      if (res.headersSent) { res.destroy(); return; }
      return send(res,503,{code:'TENANT_ENSURE_UNAVAILABLE'});
    }
  };
}
module.exports = { createEnsureApi };
