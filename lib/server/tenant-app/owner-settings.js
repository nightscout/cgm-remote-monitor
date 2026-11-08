'use strict';

const express = require('express');
const NAME = /^[A-Za-z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATUS = Object.freeze({ SETTINGS_FORBIDDEN: 403, SETTINGS_POLICY_REFUSED: 403,
  HUMAN_SESSION_REFUSED: 401, HUMAN_AUTHORITY_REFUSED: 403, HUMAN_REAUTH_REQUIRED: 403,
  HUMAN_CSRF_REFUSED: 403, HUMAN_ORIGIN_REFUSED: 403, HUMAN_COOKIE_REFUSED: 401,
  HUMAN_CREDENTIAL_AMBIGUOUS: 401, HUMAN_SESSION_UNAVAILABLE: 503,
  SETTINGS_NOT_FOUND: 404, SETTINGS_HISTORY_NOT_FOUND: 404, SETTINGS_UNSUPPORTED: 400,
  SETTINGS_VALUE: 400, SETTINGS_VERSION_CONFLICT: 409, POLICY_GENERATION_CONFLICT: 409 });
function failure (status, code) { return Object.assign(new Error(code), { status, publicCode: code }); }
const route = handler => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next);

// This router has only the existing owner-settings contract. Authentication is
// the unchanged bounded management verifier; the service grants configure from
// current explicit authority, separately from subject/data permissions.
module.exports = function ownerSettings ({ resolver, authenticateManagement, tenantSettings }) {
  if (!resolver || typeof resolver.resolve !== 'function' || typeof authenticateManagement !== 'function' ||
      !tenantSettings || ['read', 'replace', 'rollback'].some(name => typeof tenantSettings[name] !== 'function')) {
    throw new TypeError('Owner settings requires explicit tenant, management and settings services');
  }
  const app = express.Router();
  app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer'); next(); });
  // Retain the single credential/selector admission order used by subjects.
  app.use((req, res, next) => Promise.resolve().then(async () => {
    let tenant;
    try { tenant = await resolver.resolve(req); }
    catch (error) {
      if (error && typeof error.code === 'string' && error.code.startsWith('TENANT_')) {
        throw failure(error.code === 'TENANT_HOST_UNKNOWN' ? 404 : 400, 'TENANT_REFUSED');
      }
      throw error;
    }
    if (typeof tenant !== 'string' || !UUID.test(tenant)) throw failure(503, 'AUTHORITY_UNAVAILABLE');
    const selectedHuman = authenticateManagement.human && require('../../human-session/http').credential(req, { purpose: 'management' });
    const credentials = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (req.rawHeaders[i].toLowerCase() === 'authorization') credentials.push(req.rawHeaders[i + 1]);
    }
    if (!selectedHuman?.token.startsWith('nsh_') && (credentials.length !== 1 || !/^Bearer [^\s,]{1,8192}$/i.test(credentials[0]))) throw failure(401, 'CREDENTIAL_REFUSED');
    const actor = await authenticateManagement({ tenant, credential: selectedHuman?.token.startsWith('nsh_') ? selectedHuman.token : credentials[0].slice(7), request: req });
    if (!actor || actor.tenant !== tenant || ['principal', 'consumer'].some(key => typeof actor[key] !== 'string' || !NAME.test(actor[key]))) {
      throw failure(401, 'CREDENTIAL_REFUSED');
    }
    Object.defineProperty(req, 'ownerSettingsContext', { value: Object.freeze({ tenant, principal: actor.principal, consumer: actor.consumer }) });
  }).then(() => next(), next));
  const json = express.json({ limit: '64kb', strict: true, inflate: false });
  function body (req, keys) {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) ||
        Object.keys(req.body).length !== keys.length || keys.some(key => !Object.hasOwn(req.body, key))) throw failure(400, 'REQUEST_INVALID');
    for (const key of keys.filter(key => key !== 'values')) {
      if (!Number.isInteger(req.body[key]) || req.body[key] < 0 || req.body[key] >= 2147483647) throw failure(400, 'REQUEST_INVALID');
    }
    if (keys.includes('values') && (!req.body.values || typeof req.body.values !== 'object' || Array.isArray(req.body.values))) {
      throw failure(400, 'REQUEST_INVALID');
    }
    return req.body;
  }
  const jsonOnly = (req, res, next) => req.is('application/json') ? json(req, res, next) : next(failure(415, 'REQUEST_MEDIA_TYPE'));
  app.get('/settings', route(async (req, res) => {
    const result = await tenantSettings.read(req.ownerSettingsContext);
    if (authenticateManagement.activity) await authenticateManagement.activity(req);
    res.json(result);
  }));
  app.put('/settings', jsonOnly, route(async (req, res) => {
    const input = body(req, ['expectedVersion', 'values']);
    const result = await tenantSettings.replace(req.ownerSettingsContext, input.expectedVersion, input.values);
    if (authenticateManagement.activity) await authenticateManagement.activity(req);
    res.json(result);
  }));
  app.post('/settings/rollback', jsonOnly, route(async (req, res) => {
    const input = body(req, ['expectedVersion', 'restoredFrom']);
    if (!input.restoredFrom || input.restoredFrom > input.expectedVersion) throw failure(400, 'REQUEST_INVALID');
    const result = await tenantSettings.rollback(req.ownerSettingsContext, input.expectedVersion, input.restoredFrom);
    if (authenticateManagement.activity) await authenticateManagement.activity(req);
    res.json(result);
  }));
  for (const [path, method] of [['/settings', 'GET, PUT'], ['/settings/rollback', 'POST']]) {
    app.all(path, (req, res) => res.set('Allow', method).status(405).json({ error: 'METHOD_REFUSED' }));
  }
  app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error && error.publicCode) return res.status(error.status).json({ error: error.publicCode });
    if (error && error.type === 'entity.too.large') return res.status(413).json({ error: 'REQUEST_TOO_LARGE' });
    if (error && (error.type === 'entity.parse.failed' || error instanceof URIError && error.status === 400)) return res.status(400).json({ error: 'REQUEST_INVALID' });
    const status = error && Object.hasOwn(STATUS, error.code) ? STATUS[error.code] : undefined;
    return res.status(status || 503).json({ error: status ? error.code : 'AUTHORITY_UNAVAILABLE' });
  });
  return app;
};
