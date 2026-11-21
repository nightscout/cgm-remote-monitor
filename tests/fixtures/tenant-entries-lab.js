'use strict';

const express = require('express');
const { EventEmitter } = require('node:events');
const shiro = require('shiro-trie');
const scope = require('../../lib/storage/tenant-scope');
const readEntries = require('../../lib/storage/postgres-entries-read');
const entriesIntent = require('../../lib/storage/postgres-entries-intent');
const readOperation = require('../../lib/api3/generic/read/operation');
const createValidate = require('../../lib/api3/generic/create/validate');
const patchValidate = require('../../lib/api3/generic/patch/validate');
const security = require('../../lib/api3/security');
const opTools = require('../../lib/api3/shared/operationTools');
const purifier = require('../../lib/server/purifier')();

// Test-only adapter: real API3 GET, shared validators and M1's commit-owning
// write step. No legacy global context, cache, sockets or production listener.
module.exports = function entriesLab ({ connection, table, checkReady }) {
  const router = express.Router();
  const reader = readEntries({ connection, table });
  router.use(async (req, res, next) => {
    try {
      if (await checkReady() !== true) throw new Error('entries schema unavailable');
      scope.withTenant(req.tenantContext.tenant, next);
    } catch (error) { next(error); }
  });
  router.use(express.json({ limit: '64kb', strict: true }));
  router.use((req, res, next) => {
    const app = express();
    app.set('API3_SECURITY_ENABLE', true);
    const permissions = shiro.new();
    permissions.add('api:entries:*');
    const actor = req.tenantContext;
    const ctx = {
      bus: new EventEmitter(),
      purifier,
      authorization: {
        // The outer M2 middleware has already verified the credential and
        // current permission for this method/path. Never consult global auth.
        resolve (input, done) {
          done(null, { subject: { name: actor.principal }, shiros: [permissions] });
        }
      }
    };
    const env = { writeValidation: 'reject' };
    const col = {
      colName: 'entries',
      storage: reader,
      resolveDates: doc => typeof doc.srvModified === 'number' ? new Date(doc.srvModified) : undefined
    };
    req.entriesLab = { app, ctx, env, col, req, res };
    next();
  });
  router.get('/entries/:identifier', (req, res) => {
    const { ctx, env, app, col } = req.entriesLab;
    return readOperation(ctx, env, app, col)(req, res);
  });

  function write (op) {
    return async (req, res, next) => {
      try {
        const opCtx = req.entriesLab;
        const { ctx, env } = opCtx;
        opCtx.auth = await security.authenticate(opCtx);
        await security.demandPermission(opCtx, 'api:entries:' + (op === 'create' ? 'create' : 'update'));
        const doc = req.body;
        if (!doc || Array.isArray(doc) || typeof doc !== 'object' || !Object.keys(doc).length ||
            ['tenant', 'tenant_id', 'principal', 'consumer'].some(key => Object.hasOwn(doc, key))) {
          return res.status(400).json({ error: 'REQUEST_INVALID' });
        }
        if (opTools.refuseClientId(doc, res)) return;
        ctx.purifier.purifyObject(doc);
        const step = entriesIntent({ connection, table, env, bus: ctx.bus });
        let target;
        if (op === 'create') {
          if (step.identifiers([doc]).length) return res.status(400).json({ error: 'IDENTIFIER_INVALID' });
          opTools.resolveIdentifier(doc);
          if (createValidate(opCtx, doc) !== true) return;
          // Deliberately narrower than legacy POST: duplicate uploads are not
          // routed through legacy acknowledge/dedup/replace response handling.
          if (await step.match({ op, docs: [doc], computedIdentifier: false })) {
            return res.status(409).json({ error: 'ENTRY_EXISTS' });
          }
        } else {
          const identifier = req.params.identifier;
          const stored = await step.match({ op, docs: [doc], target: { identifier } });
          if (!stored) return res.status(404).json({ error: 'NOT_FOUND' });
          if (stored.isValid === false) return res.sendStatus(410);
          if (patchValidate(opCtx, doc, stored) !== true) return;
          target = { identifier, stored };
        }
        const result = await step.write({
          op, docs: [doc], ...(target ? { target } : {}),
          by: req.tenantContext.principal, canUpdate: true, computedIdentifier: false
        });
        res.status(op === 'create' ? 201 : 200).json({
          status: op === 'create' ? 201 : 200,
          identifier: result.items[0].identifier,
          outcome: result.items[0].outcome
        });
      } catch (error) { next(error); }
    };
  }
  router.post('/entries', write('create'));
  router.patch('/entries/:identifier', write('patch'));
  return router;
};
