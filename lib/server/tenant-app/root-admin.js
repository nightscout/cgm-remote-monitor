'use strict';

const express = require('express');
const subjectUpdate = require('../../subject-admin/update');
const { permissionsValid } = require('../../subject-admin/owner-policy');
const unauthorized = require('./legacy-refusal');

// The single-site admin tools routes (lib/authorization/endpoints.js, called by
// lib/admin_plugins/subjects.js and roles.js) for a tenant's root secret on the
// DATA listener: the same paths, verbs and form or JSON payloads. Every write goes
// through the owner-aware writer on its root plane: current catalogue, operator
// ceiling and the last-owner guard. Root gets no owner or operator route here.
const NAME = /^[a-zA-Z0-9_-]{1,128}$/;
const HTTP_ERROR = Symbol('root admin HTTP error');
const STATUS = Object.freeze({
  SUBJECT_ADMIN_FORBIDDEN: 403,
  SUBJECT_ADMIN_CONFLICT: 409,
  SUBJECT_ADMIN_LAST_OWNER: 409,
  SUBJECT_ADMIN_UNSUPPORTED: 501,
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

function plain (body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw failure(400, 'REQUEST_INVALID');
  return body;
}

// Admin tools send x-www-form-urlencoded (jQuery omits an empty array) or JSON.
function list (value) {
  if (value === undefined || value === '') return [];
  if (!Array.isArray(value)) throw failure(400, 'REQUEST_INVALID');
  return value;
}

function subjectBody (body, withId) {
  const value = plain(body);
  if (Object.keys(value).some(key => !['_id', 'name', 'roles', 'notes', 'accessToken', 'created_at'].includes(key)) ||
      (withId ? typeof value._id !== 'string' || !NAME.test(value._id) : value._id !== undefined)) {
    throw failure(400, 'REQUEST_INVALID');
  }
  // accessToken is derived from the root secret and the stable id; it is never stored.
  try {
    return { subjectId: value._id, input: subjectUpdate({ name: value.name, roles: list(value.roles),
      ...(value.notes === undefined ? {} : { notes: value.notes }),
      ...(value.created_at === undefined ? {} : { created_at: value.created_at }) }) };
  } catch (error) {
    if (error instanceof TypeError) throw failure(400, 'REQUEST_INVALID');
    throw error;
  }
}

function roleBody (body) {
  const value = plain(body);
  const permissions = list(value.permissions);
  // Roles have no notes column; the admin tools always send the field.
  if (Object.keys(value).some(key => !['name', 'permissions', 'notes'].includes(key)) ||
      (value.notes !== undefined && typeof value.notes !== 'string') ||
      typeof value.name !== 'string' || !NAME.test(value.name) || !permissionsValid(permissions)) {
    throw failure(400, 'REQUEST_INVALID');
  }
  return { name: value.name, permissions: permissions.slice() };
}

function present (subject, tokens) {
  return { _id: subject.subjectId, name: subject.name, roles: subject.roles,
    ...(subject.notes === null || subject.notes === undefined ? {} : { notes: subject.notes }),
    ...(tokens && tokens.has(subject.subjectId) ? { accessToken: tokens.get(subject.subjectId) } : {}) };
}

function createRootAdminRouter ({ resolveTenant, authenticateRoot, subjectAdmin } = {}) {
  if (typeof resolveTenant !== 'function' || typeof authenticateRoot !== 'function' || !subjectAdmin ||
      ['list', 'listRoles', 'create', 'createRole', 'update', 'remove'].some(method => typeof subjectAdmin[method] !== 'function')) {
    throw new TypeError('Root admin routes require tenant resolution, root authentication and the owner-aware subject admin');
  }
  const router = express.Router();
  router.use(['/subjects', '/roles'], (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); },
    express.json({ limit: '64kb', strict: true }), express.urlencoded({ extended: true, limit: '64kb', parameterLimit: 600 }));
  const sessions = new WeakMap();
  const protect = route(async (req, res, next) => {
    const tenant = await resolveTenant(req);
    const session = await authenticateRoot({ tenant, request: req });
    if (!session || !session.actor || session.actor.tenant !== tenant || session.actor.principal !== 'root' ||
        typeof session.actor.consumer !== 'string' || !NAME.test(session.actor.consumer)) return unauthorized(res);
    sessions.set(req, Object.freeze({ actor: Object.freeze({ tenant, principal: 'root', consumer: session.actor.consumer }),
      tokens: session.tokens }));
    next();
  });
  const actor = req => sessions.get(req).actor;
  router.get('/subjects', protect, route(async (req, res) => {
    const subjects = await subjectAdmin.list(actor(req));
    const tokens = typeof sessions.get(req).tokens === 'function' ? await sessions.get(req).tokens() : null;
    res.json(subjects.map(subject => present(subject, tokens)));
  }));
  router.post('/subjects', protect, route(async (req, res) => {
    const { input } = subjectBody(req.body, false);
    const created = await subjectAdmin.create(actor(req), input);
    res.json(present(created));
  }));
  router.put('/subjects', protect, route(async (req, res) => {
    const { subjectId, input } = subjectBody(req.body, true);
    res.json(present(await subjectAdmin.update(actor(req), subjectId, input)));
  }));
  router.delete('/subjects/:_id', protect, route(async (req, res) => {
    if (!NAME.test(req.params._id)) throw failure(400, 'REQUEST_INVALID');
    await subjectAdmin.remove(actor(req), req.params._id);
    res.json({});
  }));
  router.get('/roles', protect, route(async (req, res) => {
    res.json((await subjectAdmin.listRoles(actor(req))).map(role => ({ _id: role.name, ...role })));
  }));
  router.post('/roles', protect, route(async (req, res) => {
    const created = await subjectAdmin.createRole(actor(req), roleBody(req.body));
    res.json({ _id: created.name, ...created });
  }));
  // Editing or deleting a role is not part of the owner-aware writer (no audit
  // operation, no role UPDATE/DELETE grant, links reference roles by name).
  router.put('/roles', protect, () => { throw failure(501, 'SUBJECT_ADMIN_UNSUPPORTED'); });
  router.delete('/roles/:_id', protect, () => { throw failure(501, 'SUBJECT_ADMIN_UNSUPPORTED'); });
  router.use(['/subjects', '/roles'], (error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error && error[HTTP_ERROR]) return res.status(error.status).json({ error: error.code });
    if (error && error.type === 'entity.parse.failed') return res.status(400).json({ error: 'REQUEST_INVALID' });
    if (error && error.type === 'entity.too.large') return res.status(413).json({ error: 'REQUEST_TOO_LARGE' });
    if (error instanceof TypeError && /^Invalid (subject update|role definition)/.test(error.message)) {
      return res.status(400).json({ error: 'REQUEST_INVALID' });
    }
    const status = error && Object.hasOwn(STATUS, error.code) ? STATUS[error.code] : undefined;
    if (status) return res.status(status).json({ error: error.code });
    return next(error);
  });
  return router;
}

// The presented API_SECRET is verified against the resolved tenant's own root
// reference only; another tenant's root, a subject token or a JWT is refused.
function createRootAuthentication ({ secrets, verifierContext, tenants } = {}) {
  if (!secrets || typeof secrets.verifyLegacyCredential !== 'function' ||
      typeof secrets.rootLegacyTokens !== 'function' || typeof verifierContext !== 'function' ||
      !Array.isArray(tenants) || !tenants.length) {
    throw new TypeError('Root authentication requires tenant secrets, the trusted verifier identity and bound tenants');
  }
  const bound = new Set(tenants);
  const extract = require('../../authorization/credential-extraction');
  return async function authenticateRoot ({ tenant, request }) {
    const credentials = extract(request, { version: 2 });
    if (!bound.has(tenant) || credentials.invalid || !credentials.apiSecret || credentials.token !== undefined) return null;
    const context = await verifierContext(tenant);
    if (!context || context.tenant !== tenant) return null;
    const principal = await secrets.verifyLegacyCredential(context, { apiSecret: credentials.apiSecret });
    if (!principal || principal.kind !== 'root') return null;
    return { actor: { tenant, principal: 'root', consumer: context.consumer },
      tokens: () => secrets.rootLegacyTokens(context, { apiSecret: credentials.apiSecret }) };
  };
}

module.exports = { createRootAdminRouter, createRootAuthentication };
