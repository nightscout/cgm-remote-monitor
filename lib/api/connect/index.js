'use strict';

const express = require('express');
const ConnectError = require('../../connect/errors');

module.exports = function routes(env, ctx) {
  const api = express.Router();
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, private'); res.set('Pragma', 'no-cache');
    res.set('X-Content-Type-Options', 'nosniff'); res.set('Referrer-Policy', 'no-referrer');
    if (!ctx.nativeConnect) return res.status(503).json({ error: 'worker_unavailable' });
    const origin = req.get('origin');
    if ((origin && origin !== req.protocol + '://' + req.get('host')) || req.get('sec-fetch-site') === 'cross-site') {
      return res.status(403).json({ error: 'forbidden_origin' });
    }
    if (!['GET', 'POST', 'DELETE'].includes(req.method)) return res.status(405).end();
    const secret = req.get('api-secret');
    const bearer = req.get('authorization');
    // Never authenticate this private channel via a URL, cookie, body field,
    // or anonymous/default roles (even AUTH_DEFAULT_ROLES=admin).
    if ((!secret && !bearer) || req.query.token || req.query.secret) return res.status(401).json({ error: 'unauthorized' });
    if (secret && env.enclave.isApiKey(secret)) { req.connectOwner = 'api-secret'; return next(); }
    const jwt = bearer && /^Bearer (.+)$/.exec(bearer);
    const decoded = jwt && env.enclave.verifyJWT(jwt[1]);
    const token = decoded?.accessToken || secret;
    const resolved = token && ctx.authorization.storage.resolveSubjectAndPermissions(token);
    if (!resolved?.subject || !ctx.authorization.checkMultiple('connect:manage', resolved.shiros)) {
      return res.status(403).json({ error: 'unauthorized' });
    }
    req.connectOwner = 'subject:' + resolved.subject._id;
    next();
  });
  api.use(express.json({ limit: '16kb', strict: true }));
  api.use((req, res, next) => {
    // SECURE_CSP can install a larger JSON parser above this router.
    if (req.body && Buffer.byteLength(JSON.stringify(req.body)) > 16384) return res.status(413).json({ error: 'invalid_request' });
    next();
  });
  const handle = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  api.get('/carelink', handle((req, res) => res.json(ctx.nativeConnect.status(req.connectOwner))));
  api.get('/carelink/countries', handle(async (req, res) => res.json(await ctx.nativeConnect.auth.countries())));
  api.post('/carelink/sessions', handle(async (req, res) => {
    if (!req.is('application/json')) throw new ConnectError('invalid_request', 415);
    res.status(201).json(await ctx.nativeConnect.start(req.connectOwner, req.body));
  }));
  api.get('/carelink/sessions/:id', handle((req, res) => res.json(ctx.nativeConnect.sessionStatus(ctx.nativeConnect.own(req.params.id, req.connectOwner)))));
  api.delete('/carelink/sessions/:id', handle(async (req, res) => { await ctx.nativeConnect.cancel(req.params.id, req.connectOwner); res.status(204).end(); }));
  api.post('/carelink/sessions/:id/patient', handle(async (req, res) => {
    res.json(await ctx.nativeConnect.select(req.params.id, req.connectOwner, req.body.patient));
  }));
  api.post('/carelink/sessions/:id/input', handle(async (req, res) => {
    const s = ctx.nativeConnect.own(req.params.id, req.connectOwner);
    const now = Date.now();
    if (!s.rate || now - s.rate.at > 1000) s.rate = { at: now, count: 0 };
    if (++s.rate.count > 40) throw new ConnectError('input_rate_limit', 429);
    res.json(await ctx.nativeConnect.input(req.params.id, req.connectOwner, req.body));
  }));
  api.get('/carelink/sessions/:id/frame', handle((req, res) => {
    const s = ctx.nativeConnect.own(req.params.id, req.connectOwner);
    if (s.streamOpen) throw new ConnectError('stream_busy', 409);
    s.streamOpen = true;
    let timer;
    function finish() {
      clearTimeout(timer); s.streamOpen = false; s.events.removeListener('frame', finish);
      if (!res.destroyed && !res.writableEnded) res.json({ seq: s.seq, image: s.frame,
        state: s.machine.state.value });
    }
    res.on('close', () => { clearTimeout(timer); s.streamOpen = false; s.events.removeListener('frame', finish); });
    if (s.seq !== Number(req.query.after) || !s.machine.state.matches('waiting')) return finish();
    s.events.once('frame', finish); timer = setTimeout(finish, 15000);
  }));
  api.delete('/carelink', handle(async (req, res) => { await ctx.nativeConnect.disconnect(); res.status(204).end(); }));
  api.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (res.headersSent) return res.end();
    const status = err instanceof ConnectError ? err.status : (err.type === 'entity.too.large' ? 413 : 500);
    res.status(status).json({ error: err instanceof ConnectError ? err.code : 'connection_failed' });
  });
  return api;
};
