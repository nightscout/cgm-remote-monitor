'use strict';

const express = require('express');
const { randomBytes, createCipheriv, createDecipheriv, createHmac, timingSafeEqual } = require('node:crypto');
const COOKIE = '__Host-ns-human-data';
const MANAGEMENT_COOKIE = '__Host-ns-human-management';
const FLOW = '__Host-ns-oidc-flow';
const PREFIX = '/api/v2/oidc';
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const fail = (code, status = 401) => Object.assign(new Error(code), { code, status });
const wrap = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(next);

function cookies (req) {
  const result = Object.create(null);
  const raw = req.headers.cookie;
  if (!raw) return result;
  if (typeof raw !== 'string' || raw.length > 16384) throw fail('HUMAN_COOKIE_REFUSED');
  for (const entry of raw.split(';')) {
    const i = entry.indexOf('=');
    const key = entry.slice(0, i).trim();
    if (i < 1 || ![COOKIE, MANAGEMENT_COOKIE].includes(key) && !new RegExp('^' + FLOW + '-[A-Za-z0-9_-]{43}$').test(key)) continue;
    if (Object.hasOwn(result, key)) throw fail('HUMAN_COOKIE_REFUSED');
    result[key] = entry.slice(i + 1).trim();
  }
  return result;
}

// Cookie and bearer credentials never mix. A malformed supplied credential is
// an error, so an invalid human credential cannot become anonymous or legacy.
function credential (req, { purpose = 'data' } = {}) {
  const name = purpose === 'management' ? MANAGEMENT_COOKIE : COOKIE;
  const parsed = cookies(req), found = parsed[name];
  if (Object.hasOwn(parsed, name) && !/^nsh_[A-Za-z0-9_-]{43}$/.test(found)) throw fail('HUMAN_COOKIE_REFUSED');
  const headers = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === 'authorization') headers.push(req.rawHeaders[i + 1]);
  }
  if (headers.length > 1 || headers.length && found) throw fail('HUMAN_CREDENTIAL_AMBIGUOUS');
  if (headers.length) {
    if (!/^Bearer [^\s,]{1,8192}$/i.test(headers[0])) throw fail('HUMAN_CREDENTIAL_REFUSED');
    return { token: headers[0].slice(7), cookie: false };
  }
  return found ? { token: found, cookie: true } : null;
}

function createHumanHTTP ({ engine, provider, resolver, originFor, cookieKey, now = () => Math.floor(Date.now() / 1000) }) {
  if (!engine || !provider || !resolver || typeof resolver.resolve !== 'function' || typeof originFor !== 'function' ||
      !Buffer.isBuffer(cookieKey) || cookieKey.length !== 32) throw new TypeError('Explicit human session HTTP configuration required');
  const router = express.Router();
  const seal = value => {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', cookieKey, iv);
    cipher.setAAD(Buffer.from(FLOW));
    const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64url');
  };
  const unseal = value => {
    try {
      if (typeof value !== 'string' || value.length > 12000 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
      const bytes = Buffer.from(value, 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', cookieKey, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(FLOW)); decipher.setAuthTag(bytes.subarray(12, 28));
      return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
    } catch { throw fail('HUMAN_FLOW_REFUSED'); }
  };
  const csrf = token => createHmac('sha256', cookieKey).update('csrf\0' + token).digest('base64url');
  function origin (tenant) {
    const configured = originFor(tenant);
    const url = new URL(configured);
    if (url.origin !== configured || url.protocol !== 'https:' || url.username || url.password) throw fail('HUMAN_ORIGIN_UNAVAILABLE', 503);
    return configured;
  }
  function sameOrigin (req, tenant, required = true) {
    const expected = origin(tenant);
    if (req.headers.origin !== expected && (required || req.headers.origin !== undefined) ||
        req.headers['sec-fetch-site'] === 'cross-site') throw fail('HUMAN_ORIGIN_REFUSED', 403);
  }
  function checkTransport (req, tenant, supplied) {
    sameOrigin(req, tenant, supplied.cookie && !SAFE.has(req.method));
    if (supplied.cookie && !SAFE.has(req.method)) {
      const provided = req.headers['x-ns-csrf'];
      const expected = csrf(supplied.token);
      if (typeof provided !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(provided) || provided.length !== expected.length ||
          !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) throw fail('HUMAN_CSRF_REFUSED', 403);
    }
  }
  const options = { httpOnly: true, secure: true, sameSite: 'strict', path: '/' };
  const cookieName = purpose => purpose === 'management' ? MANAGEMENT_COOKIE : COOKIE;
  const clear = (res, purpose) => res.clearCookie(cookieName(purpose), options);
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer'); next();
  });
  router.post('/backchannel-logout', express.urlencoded({ limit: '12kb', extended: false, inflate: false }), wrap(async (req, res) => {
    const tenant = await resolver.resolve(req);
    if (!provider.verifyLogout || !engine.logoutProvider) throw fail('OIDC_LOGOUT_UNSUPPORTED', 501);
    if (!req.body || Object.keys(req.body).length !== 1 || typeof req.body.logout_token !== 'string') throw fail('HUMAN_REQUEST_INVALID', 400);
    const event = await provider.verifyLogout(req.body.logout_token);
    await engine.logoutProvider({ tenant, event });
    res.json({ local: 'revoked' });
  }));
  router.use(express.json({ limit: '8kb', strict: true, inflate: false }));
  async function start (req, res, renewal) {
    const tenant = await resolver.resolve(req);
    sameOrigin(req, tenant);
    const purpose = req.body?.purpose || 'data', transport = req.body?.transport || 'cookie';
    if (!['data', 'management'].includes(purpose) || !['cookie', 'bearer'].includes(transport) ||
        !req.body || Object.keys(req.body).some(key => !['purpose', 'transport'].includes(key))) throw fail('HUMAN_REQUEST_INVALID', 400);
    let selected;
    if (renewal) {
      selected = credential(req, { purpose });
      if (!selected) throw fail('HUMAN_SESSION_REFUSED');
      checkTransport(req, tenant, selected);
      // The proof callback rechecks the current durable session under its fence.
      // No authentication/touch is performed here: expired access may select a
      // still-live session for provider-backed renewal, but never authorize data.
    }
    const proof = { state: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url'),
      codeVerifier: randomBytes(32).toString('base64url') };
    const flow = { ...proof, tenant, purpose, transport, renewal, token: selected?.token,
      expiresAt: now() + 300, origin: origin(tenant) };
    const location = await provider.begin({ ...proof, renewal });
    // Each concurrent flow owns its cookie. A shared pending-flow cookie loses
    // one tab's state when another starts provider-backed renewal.
    res.cookie(FLOW + '-' + proof.state, seal(flow), { ...options, sameSite: 'lax', maxAge: 300000 });
    res.json({ location: String(location) });
  }
  router.post('/login', wrap((req, res) => start(req, res, false)));
  router.post('/renew', wrap((req, res) => start(req, res, true)));
  router.get('/callback', wrap(async (req, res) => {
    const tenant = await resolver.resolve(req);
    const query = new URL(req.originalUrl, origin(tenant)).searchParams;
    const state = query.get('state');
    if (query.getAll('state').length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(state || '')) throw fail('HUMAN_FLOW_REFUSED');
    const name = FLOW + '-' + state;
    const flow = unseal(cookies(req)[name]);
    res.clearCookie(name, { ...options, sameSite: 'lax' });
    if (flow.state !== state) throw fail('HUMAN_FLOW_REFUSED');
    if (flow.tenant !== tenant || flow.origin !== origin(tenant) || !Number.isSafeInteger(flow.expiresAt) || flow.expiresAt <= now()) {
      throw fail('HUMAN_FLOW_REFUSED');
    }
    const url = new URL(req.originalUrl, flow.origin);
    // Exact callback path and query are verified by the provider library. No
    // Host/Forwarded supplied origin ever selects discovery or redirect URLs.
    const identity = await provider.finish({ url, state: flow.state, nonce: flow.nonce,
      codeVerifier: flow.codeVerifier, renewal: flow.renewal });
    const result = flow.renewal ? await engine.renew({ tenant, token: flow.token, identity })
      : await engine.login({ tenant, identity, purpose: flow.purpose });
    if (flow.transport === 'cookie') {
      // Retain the selector after access expiry for a new provider-backed code
      // flow. Its presence never extends access: the engine checks token expiry.
      const absolute = result.session.absoluteExpiresAt;
      res.cookie(cookieName(result.session.purpose), result.token, { ...options, ...(absolute === null ? {} : { maxAge: Math.max(0, absolute - now()) * 1000 }) });
      res.redirect(303, '/');
    } else {
      // Direct tokens never enter a URL, fragment, log, or shared cache.
      res.json({ token: result.token, expiresAt: result.expiresAt, session: result.session });
    }
  }));
  router.get('/session', wrap(async (req, res) => {
    const purpose = req.query.purpose || 'data';
    if (!['data', 'management'].includes(purpose)) throw fail('HUMAN_REQUEST_INVALID', 400);
    const tenant = await resolver.resolve(req), supplied = credential(req, { purpose });
    if (!supplied) throw fail('HUMAN_SESSION_REFUSED');
    checkTransport(req, tenant, supplied);
    const result = await engine.authenticate({ tenant, token: supplied.token, purpose });
    res.json({ session: result.session, csrf: supplied.cookie ? csrf(supplied.token) : undefined,
      provider: provider.capabilities });
  }));
  router.post('/logout', wrap(async (req, res) => {
    const purpose = req.body?.purpose || 'data';
    if (!['data', 'management'].includes(purpose)) throw fail('HUMAN_REQUEST_INVALID', 400);
    const tenant = await resolver.resolve(req), supplied = credential(req, { purpose });
    if (!supplied) { clear(res, purpose); return res.json({ local: 'absent' }); }
    checkTransport(req, tenant, supplied);
    try { await engine.logout({ tenant, token: supplied.token }); }
    catch (error) {
      clear(res, purpose);
      if (error.code === 'HUMAN_SESSION_UNAVAILABLE') return res.status(503).json({ error: 'LOCAL_REVOCATION_UNCONFIRMED' });
      throw error;
    }
    clear(res, purpose);
    // Provider redirection follows durable local invalidation and cookie clear.
    res.json({ local: 'revoked', providerLogout: provider.logoutURL ? String(provider.logoutURL() || '') || undefined : undefined });
  }));
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const code = error?.code;
    const status = error.status || (code === 'HUMAN_SESSION_UNAVAILABLE' || code === 'OIDC_PROVIDER_UNAVAILABLE' ? 503
      : code === 'HUMAN_AUTHORITY_REFUSED' || code === 'HUMAN_REAUTH_REQUIRED' ? 403 : 401);
    res.status(status).json({ error: /^(HUMAN_|OIDC_)/.test(code || '') ? code : 'HUMAN_REQUEST_REFUSED' });
  });
  return { router, credential, checkTransport,
    async authenticate ({ tenant, credential: token, request, purpose = 'management', activity = false, sensitive = false }) {
      const supplied = credential(request, { purpose });
      if (!supplied || supplied.token !== token) throw fail('HUMAN_CREDENTIAL_REFUSED');
      checkTransport(request, tenant, supplied);
      return engine.authenticate({ tenant, token, purpose, activity, sensitive });
    } };
}

module.exports = { createHumanHTTP, credential, PREFIX, COOKIE, MANAGEMENT_COOKIE, FLOW };
