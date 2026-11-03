'use strict';

const express = require('express');

const NAME = /^[a-zA-Z0-9_-]{1,128}$/;
const OWNER = '/api/v1/tenant';
const OPERATOR = '/api/v1/operator/tenants/:tenant/policy';
const HTTP_ERROR = Symbol('tenant HTTP error');
const SERVICE_STATUS = Object.freeze({
  SETTINGS_FORBIDDEN: 403,
  POLICY_FORBIDDEN: 403,
  OPERATOR_POLICY_FORBIDDEN: 403,
  SETTINGS_NOT_FOUND: 404,
  SETTINGS_HISTORY_NOT_FOUND: 404,
  POLICY_NOT_FOUND: 404,
  OPERATOR_POLICY_NOT_FOUND: 404,
  SETTINGS_UNSUPPORTED: 400,
  SETTINGS_VALUE: 400,
  SETTINGS_POLICY_REFUSED: 403,
  POLICY_FLOOR: 403,
  SETTINGS_VERSION_CONFLICT: 409,
  POLICY_VERSION_CONFLICT: 409,
  POLICY_GENERATION_CONFLICT: 409,
  OPERATOR_POLICY_GENERATION_CONFLICT: 409
});

function failure (status, code) {
  return Object.assign(new Error(code), { [HTTP_ERROR]: true, status, code });
}

function required (value, methods, label) {
  if (!value || methods.some(method => typeof value[method] !== 'function')) {
    throw new TypeError('Tenant HTTP composition requires ' + label);
  }
}

function route (handler) {
  return (req, res, next) => Promise.resolve().then(() => handler(req, res, next)).catch(next);
}

function identity (actor, tenant) {
  if (!actor || actor.tenant !== tenant ||
      ['tenant', 'principal', 'consumer'].some(key => typeof actor[key] !== 'string' || !NAME.test(actor[key]))) {
    throw failure(401, 'CREDENTIAL_REFUSED');
  }
  return Object.freeze({ tenant, principal: actor.principal, consumer: actor.consumer });
}

function bearer (req) {
  // Do not let Node's normalized headers conceal duplicate credentials.
  const headers = req.rawHeaders;
  const values = [];
  for (let i = 0; i < headers.length; i += 2) {
    if (headers[i].toLowerCase() === 'authorization') values.push(headers[i + 1]);
  }
  if (values.length !== 1 || !/^Bearer [^\s,]{1,8192}$/i.test(values[0])) {
    throw failure(401, 'CREDENTIAL_REFUSED');
  }
  return values[0].slice(7);
}

function body (req, fields) {
  const value = req.body;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) {
    throw failure(400, 'REQUEST_INVALID');
  }
  return value;
}

function version (value) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 2147483647) {
    throw failure(400, 'REQUEST_INVALID');
  }
  return value;
}

function base () {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.set('trust proxy', false);
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  return app;
}

function finish (app) {
  app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error && error[HTTP_ERROR]) return res.status(error.status).json({ error: error.code });
    if (error && error.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'REQUEST_INVALID' });
    }
    if (error && error.type === 'entity.too.large') {
      return res.status(413).json({ error: 'REQUEST_TOO_LARGE' });
    }
    const status = error && Object.hasOwn(SERVICE_STATUS, error.code) ? SERVICE_STATUS[error.code] : undefined;
    return res.status(status || 503).json({ error: status ? error.code : 'AUTHORITY_UNAVAILABLE' });
  });
  return app;
}

function createTenantApp ({ resolver, verifyCredential, authorizeRequest, tenantSettings, subjectPolicy, dataRouter } = {}) {
  required(resolver, ['resolve'], 'a tenant resolver');
  required(tenantSettings, ['read', 'replace', 'rollback'], 'tenant settings');
  required(subjectPolicy, ['read', 'replace'], 'subject policy');
  if ([verifyCredential, authorizeRequest, dataRouter].some(value => typeof value !== 'function')) {
    throw new TypeError('Tenant HTTP composition requires credential verification, current authorization and a data router');
  }
  const app = base();
  function protect (plane) {
    return route(async (req, res, next) => {
      let tenant;
      try {
        tenant = await resolver.resolve(req);
      } catch (error) {
        if (error && typeof error.code === 'string' && /^TENANT_/.test(error.code)) {
          throw failure(error.code === 'TENANT_HOST_UNKNOWN' ? 404 : 400, 'TENANT_REFUSED');
        }
        throw error;
      }
      if (typeof tenant !== 'string' || !NAME.test(tenant)) throw failure(503, 'AUTHORITY_UNAVAILABLE');
      const credential = bearer(req);
      const context = identity(await verifyCredential({ tenant, credential, plane }), tenant);
      const action = Object.freeze({ plane, method: req.method, path: req.path });
      if (await authorizeRequest(context, action) !== true) throw failure(403, 'REQUEST_FORBIDDEN');
      Object.defineProperty(req, 'tenantContext', { value: context, enumerable: true });
      next();
    });
  }

  // A data router never shares the owner router's mount or management services.
  app.use('/api/v3', protect('data'), dataRouter);
  const owner = express.Router();
  owner.use(protect('owner'));
  owner.use(express.json({ limit: '64kb', strict: true }));
  owner.get('/settings', route(async (req, res) => res.json(await tenantSettings.read(req.tenantContext))));
  owner.put('/settings', route(async (req, res) => {
    const input = body(req, ['expectedVersion', 'values']);
    res.json(await tenantSettings.replace(req.tenantContext, version(input.expectedVersion), input.values));
  }));
  owner.post('/settings/rollback', route(async (req, res) => {
    const input = body(req, ['expectedVersion', 'restoredFrom']);
    res.json(await tenantSettings.rollback(req.tenantContext, version(input.expectedVersion), version(input.restoredFrom)));
  }));
  owner.get('/subject-policy', route(async (req, res) => res.json(await subjectPolicy.read(req.tenantContext))));
  owner.put('/subject-policy', route(async (req, res) => {
    const input = body(req, ['expectedVersion', 'grants']);
    res.json(await subjectPolicy.replace(req.tenantContext, version(input.expectedVersion), input.grants));
  }));
  app.use(OWNER, owner);
  return finish(app);
}

function createOperatorApp ({ authenticateOperator, operatorPolicy } = {}) {
  required(operatorPolicy, ['read', 'replace'], 'operator policy');
  if (typeof authenticateOperator !== 'function') {
    throw new TypeError('Operator HTTP composition requires operator authentication');
  }
  const app = base();
  const operator = express.Router({ mergeParams: true });
  operator.use(route(async (req, res, next) => {
    const tenant = req.params.tenant;
    if (!NAME.test(tenant)) throw failure(400, 'REQUEST_INVALID');
    const actor = await authenticateOperator(req);
    if (!actor) throw failure(401, 'CREDENTIAL_REFUSED');
    // The target tenant is not authentication. operatorPolicy independently
    // authorizes management of this tenant using the authenticated actor.
    const context = identity({ tenant, principal: actor.principal, consumer: actor.consumer }, tenant);
    Object.defineProperty(req, 'operatorContext', { value: context, enumerable: true });
    next();
  }));
  operator.use(express.json({ limit: '64kb', strict: true }));
  operator.get('/', route(async (req, res) => res.json(await operatorPolicy.read(req.operatorContext))));
  operator.put('/', route(async (req, res) => {
    const input = body(req, ['expectedGeneration', 'policy']);
    res.json(await operatorPolicy.replace(req.operatorContext, version(input.expectedGeneration), input.policy));
  }));
  app.use(OPERATOR, operator);
  return finish(app);
}

module.exports = { createTenantApp, createOperatorApp };
