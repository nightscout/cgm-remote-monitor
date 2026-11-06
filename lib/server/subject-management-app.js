'use strict';

const express = require('express');
const subjectUpdate = require('../subject-admin/update');

const PATH = '/api/v2/authorization/subjects';
const NAME = /^[a-zA-Z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HTTP_ERROR = Symbol('subject management HTTP error');
const SELECTOR_REFUSALS = new Set(['TENANT_HEADERS_INVALID', 'TENANT_HOST_INVALID', 'TENANT_ID_INVALID',
  'TENANT_PROXY_UNTRUSTED', 'TENANT_SELECTOR_CONFLICT', 'TENANT_SELECTOR_DUPLICATE', 'TENANT_SELECTOR_INVALID']);
const STATUS = Object.freeze({
  SUBJECT_ADMIN_FORBIDDEN: 403,
  SUBJECT_ADMIN_NOT_FOUND: 404,
  SUBJECT_ADMIN_UNKNOWN_ROLE: 400,
  SUBJECT_ADMIN_METADATA_MISSING: 409,
  SUBJECT_ADMIN_STORE_UNAVAILABLE: 503,
  SUBJECT_ADMIN_STORE_UNSAFE: 503
});

function failure (status, code) {
  return Object.assign(new Error(code), { [HTTP_ERROR]: true, status, code });
}

function route (handler) {
  return (req, res, next) => Promise.resolve().then(() => handler(req, res, next)).catch(next);
}

function bearer (req) {
  const values = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === 'authorization') values.push(req.rawHeaders[i + 1]);
  }
  if (values.length !== 1 || !/^Bearer [^\s,]{1,8192}$/i.test(values[0])) {
    throw failure(401, 'CREDENTIAL_REFUSED');
  }
  return values[0].slice(7);
}

function update (body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => !['_id', 'name', 'roles', 'notes', 'created_at'].includes(key)) ||
      typeof body._id !== 'string' || !NAME.test(body._id)) {
    throw failure(400, 'REQUEST_INVALID');
  }
  const { _id, ...input } = body;
  try { return { subjectId: _id, input: subjectUpdate(input) }; }
  catch (error) {
    if (error instanceof TypeError) throw failure(400, 'REQUEST_INVALID');
    throw error;
  }
}

// Dormant factory only. Authentication is supplied by a separately reviewed
// management plane; the accepted service independently grants the whole action.
function createSubjectManagementApp ({ resolver, authenticateManagement, subjectAdmin } = {}) {
  if (!resolver || typeof resolver.resolve !== 'function' || typeof authenticateManagement !== 'function' ||
      !subjectAdmin || ['update', 'remove'].some(method => typeof subjectAdmin[method] !== 'function')) {
    throw new TypeError('Subject management HTTP requires tenant resolution, management authentication and subject administration');
  }
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.set('trust proxy', false);
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });
  const protect = route(async (req, res, next) => {
    let tenant;
    try { tenant = await resolver.resolve(req); }
    catch (error) {
      if (error && error.code === 'TENANT_HOST_UNKNOWN') throw failure(404, 'TENANT_REFUSED');
      if (error && SELECTOR_REFUSALS.has(error.code)) throw failure(400, 'TENANT_REFUSED');
      throw error;
    }
    if (typeof tenant !== 'string' || !UUID.test(tenant)) throw failure(503, 'AUTHORITY_UNAVAILABLE');
    const actor = await authenticateManagement({ tenant, credential: bearer(req), request: req });
    if (!actor || actor.tenant !== tenant ||
        ['principal', 'consumer'].some(key => typeof actor[key] !== 'string' || !NAME.test(actor[key]))) {
      throw failure(401, 'CREDENTIAL_REFUSED');
    }
    Object.defineProperty(req, 'subjectManagementContext', {
      value: Object.freeze({ tenant, principal: actor.principal, consumer: actor.consumer })
    });
    next();
  });
  const json = express.json({ limit: '64kb', strict: true, inflate: false });
  function jsonOnly (req, res, next) {
    if (!req.is('application/json')) return next(failure(415, 'REQUEST_MEDIA_TYPE'));
    return json(req, res, next);
  }
  app.put(PATH, protect, jsonOnly, route(async (req, res) => {
    const { subjectId, input } = update(req.body);
    res.json(await subjectAdmin.update(req.subjectManagementContext, subjectId, input));
  }));
  app.delete(PATH + '/:_id', protect, (req, res, next) => {
    if (req.headers['transfer-encoding'] || Number(req.headers['content-length']) > 0) {
      return jsonOnly(req, res, next);
    }
    return next();
  }, route(async (req, res) => {
    if (!NAME.test(req.params._id) || (req.body !== undefined &&
        (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length))) {
      throw failure(400, 'REQUEST_INVALID');
    }
    await subjectAdmin.remove(req.subjectManagementContext, req.params._id);
    res.json({});
  }));
  for (const [path, method] of [[PATH, 'PUT'], [PATH + '/:_id', 'DELETE']]) {
    app.all(path, (req, res) => res.set('Allow', method).status(405).json({ error: 'METHOD_REFUSED' }));
  }
  app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error && error[HTTP_ERROR]) return res.status(error.status).json({ error: error.code });
    const parser = { 'entity.parse.failed': [400, 'REQUEST_INVALID'], 'entity.too.large': [413, 'REQUEST_TOO_LARGE'],
      'encoding.unsupported': [415, 'REQUEST_MEDIA_TYPE'], 'charset.unsupported': [415, 'REQUEST_MEDIA_TYPE'] };
    if (error && Object.hasOwn(parser, error.type)) {
      const [status, code] = parser[error.type];
      return res.status(status).json({ error: code });
    }
    const status = error && Object.hasOwn(STATUS, error.code) ? STATUS[error.code] : undefined;
    return res.status(status || 503).json({ error: status ? error.code : 'AUTHORITY_UNAVAILABLE' });
  });
  return app;
}

module.exports = { createSubjectManagementApp };
