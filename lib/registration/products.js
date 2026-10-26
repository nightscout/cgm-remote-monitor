'use strict';

const express = require('express');

const negotiate = require('./negotiate');

// The product resource (registration specification §5): <submit.href>/<vendor>/<product>.
//
//   PUT     create (If-None-Match: *) or update (If-Match: <etag>)
//   GET     the stored registration and its element results
//   DELETE  the controller retires it (If-Match)
//
// The decision is ./negotiate.js; this module reads what it needs, resolves
// the credential, and applies the result with one conditional write per
// document (./store.js). A write that lost a race is decided again on what is
// stored now.

const ATTEMPTS = 3;

// HTTP entity tags are quoted; the specification writes etags bare. Both are
// read.
function entityTag (value) {
  if (typeof value !== 'string') { return undefined; }
  const trimmed = value.trim();
  const weak = trimmed.indexOf('W/') === 0 ? trimmed.slice(2) : trimmed;
  return weak.length > 1 && weak[0] === '"' && weak[weak.length - 1] === '"' ? weak.slice(1, -1) : weak;
}

function preconditions (req) {
  const out = {};
  const ifNoneMatch = req.get('If-None-Match');
  const ifMatch = req.get('If-Match');
  if (ifNoneMatch !== undefined) { out.ifNoneMatch = entityTag(ifNoneMatch); }
  if (ifMatch !== undefined) { out.ifMatch = entityTag(ifMatch); }
  return out;
}

// The credential (authority §3): a subject's token binds to the subject's
// id, API_SECRET to `api-secret`. A request with no credential, or one that
// does not resolve, has no binding and holds no permission here.
function resolveSubmitter (ctx, req) {
  return new Promise(function (resolve) {
    ctx.authorization.resolveWithRequest(req, function (err, result) {
      result = result || {};
      const shiros = result.shiros || [];
      const submitter = {
        credentialKind: null,
        permitted: function () { return false; },
        namespaceRoots: undefined
      };
      if (!err && result.subject) {
        submitter.credentialKind = 'subject';
        submitter.subject = String(result.subject._id);
      } else if (!err && !result.defaults && shiros.length) {
        submitter.credentialKind = 'api-secret';
      }
      if (submitter.credentialKind) {
        submitter.permitted = function (permission) {
          return ctx.authorization.checkMultiple(permission, shiros);
        };
      }
      resolve(submitter);
    });
  });
}

function create (env, ctx, options) {
  const caps = options.capabilities;
  const wellKnown = options.wellKnown;
  const store = ctx.registrations;
  const router = express.Router({ caseSensitive: true, strict: true });

  router.use(express.json({ limit: Math.max(4 * ((caps.limits || {}).maxRegistrationBytes || 65536), 262144) }));

  function send (res, outcome) {
    const body = outcome.response;
    if (outcome.after && outcome.after.etag && body.status < 300) {
      res.set('ETag', '"' + outcome.after.etag + '"');
    }
    res.status(body.status).json(body);
  }

  async function hubView (identity, registration) {
    const stored = await store.get(identity);
    const names = negotiate.declaredNamespaces(registration)
      .concat(negotiate.declaredNamespaces(stored && stored.registration));
    const claims = await store.claims(Array.from(new Set(names)));
    return {
      stored: stored,
      claimedElsewhere: function (ns) { return store.claimedElsewhere(claims, identity, ns); },
      productDefinitions: function () {
        const out = {};
        if (stored && stored.registration) {
          out[require('./canonical').definitionId(stored.registration)] = stored.registration;
        }
        return out;
      }
    };
  }

  // Applies a decision: claims first, then the registration, so a namespace
  // is never shown accepted on a registration that does not hold it.
  async function apply (identity, hub, outcome) {
    const before = hub.stored;
    const after = outcome.after;
    if (after === before) { return true; }
    let inserted = [];
    if (after && after.registration && after.state === 'active') {
      const wanted = negotiate.declaredNamespaces(after.registration).filter(function (ns) {
        return !hub.claimedElsewhere(ns) && (after.freedNamespaces || []).indexOf(ns) < 0;
      });
      try {
        inserted = await store.claim(identity, wanted);
      } catch (err) {
        if (err.conflict) { return false; }
        throw err;
      }
    }
    const written = await store.write(before, after);
    if (!written) { await store.unclaim(identity, inserted); }
    return written;
  }

  function identityOf (req) {
    return { vendor: req.params.vendor, product: req.params.product };
  }

  function handle (decide) {
    return async function (req, res, next) {
      try {
        const identity = identityOf(req);
        const submitter = await resolveSubmitter(ctx, req);
        for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
          const hub = await hubView(identity, req.body);
          const outcome = decide(req, identity, submitter, hub);
          if (await apply(identity, hub, outcome)) {
            return send(res, outcome);
          }
        }
        res.status(503).set('Retry-After', '1').json(negotiate.response(503, 'rejected', {
          reasons: [negotiate.reason('busy', null, 'the registration changed during the request; retry')]
        }));
      } catch (err) {
        next(err);
      }
    };
  }

  router.put('/:vendor/:product', handle(function (req, identity, submitter, hub) {
    const request = { action: 'submit', identity: identity, preconditions: preconditions(req) };
    return negotiate.controller(caps, hub, submitter, req.body, request, null, wellKnown);
  }));

  router.delete('/:vendor/:product', handle(function (req, identity, submitter, hub) {
    const request = { action: 'retire', identity: identity, preconditions: preconditions(req) };
    return negotiate.controller(caps, hub, submitter, null, request, null, wellKnown);
  }));

  router.get('/:vendor/:product', async function (req, res, next) {
    try {
      const identity = identityOf(req);
      const submitter = await resolveSubmitter(ctx, req);
      if (!submitter.permitted(negotiate.PERMISSION.submit)) {
        return send(res, { response: negotiate.response(403, 'rejected', {
          reasons: [negotiate.reason('not-authorised', null, 'needs ' + negotiate.PERMISSION.submit)]
        }) });
      }
      const hub = await hubView(identity, null);
      send(res, negotiate.read(caps, hub, submitter, wellKnown));
    } catch (err) {
      next(err);
    }
  });

  // A body that is not JSON, or too large, answers in the response shape.
  router.use(function (err, req, res, next) {
    if (err && (err.type === 'entity.too.large' || err.type === 'entity.parse.failed')) {
      const status = err.type === 'entity.too.large' ? 413 : 422;
      const code = err.type === 'entity.too.large' ? 'limit-exceeded' : 'invalid-registration';
      return res.status(status).json(negotiate.response(status, 'rejected', { reasons: [negotiate.reason(code)] }));
    }
    next(err);
  });

  return router;
}

module.exports = create;
module.exports.entityTag = entityTag;
