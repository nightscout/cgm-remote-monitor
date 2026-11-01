'use strict';

const express = require('express');

const negotiate = require('./negotiate');
const instances = require('./instances');
const grammar = require('./grammar');

// The product resource (registration specification §5): <submit.href>/<vendor>/<product>.
//
//   PUT     create (If-None-Match: *) or update (If-Match: <etag>)
//   GET     the stored registration and its element results
//   DELETE  the controller retires it (If-Match)
//   POST    …/<action>, the owner's actions with API_SECRET (authority §4):
//           retire, block, unblock, release, transfer, free-namespaces
//
// and, when the capability document offers `instances` (§7-§10):
//
//   PUT     …/definitions/<definitionId>   add a definition (If-None-Match: *)
//   POST    …/transfer-role, …/pin-version, …/unpin-version   the owner's
//
// and, on one flat root for instances (§7, maintainer 2026-10-26), the
// router `instances` returns, mounted at INSTANCES_HREF:
//
//   PUT     /api/v4/instances/<instanceId> create, renew or change an
//                                          instance; the body names the
//                                          product (`product`)
//   DELETE  /api/v4/instances/<instanceId> release it and its roles (If-Match)
//   GET     /api/v4/instances              the owner's listing
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
  // The time leases are measured against; the conformance harness sets it.
  const clock = options.clock || Date.now;
  const store = ctx.registrations;
  const offersInstances = Boolean(caps.instances);
  const router = express.Router({ caseSensitive: true, strict: true });

  const bodyParser = express.json({ limit: Math.max(4 * ((caps.limits || {}).maxRegistrationBytes || 65536), 262144) });
  router.use(bodyParser);

  function send (res, outcome) {
    const body = outcome.response;
    if (outcome.after && outcome.after.etag && body.status < 300) {
      res.set('ETag', '"' + outcome.after.etag + '"');
    }
    res.status(body.status).json(body);
  }

  // What every decision reads: the stored state, and the product's view of it
  // (./negotiate.js `hub`).
  async function view (identity, body) {
    const state = await store.snapshot();
    const stored = identity ? instances.findProduct(state, identity) : null;
    const names = new Set(negotiate.declaredNamespaces(body));
    if (identity) { instances.productNamespaces(state, identity).forEach(function (ns) { names.add(ns); }); }
    const claims = await store.claims(Array.from(names));
    const hub = {
      stored: stored,
      claimedElsewhere: function (ns) { return store.claimedElsewhere(claims, identity, ns); },
      productNamespaces: function () { return instances.productNamespaces(state, identity); },
      productDefinitions: function () { return instances.productDefinitions(state, identity); }
    };
    return { state: state, hub: hub, now: instances.text(clock()) };
  }

  async function claimNamespaces (identity, hub, names) {
    const wanted = names.filter(function (ns) { return !hub.claimedElsewhere(ns); });
    try {
      return await store.claim(identity, wanted);
    } catch (err) {
      if (err.conflict) { return null; }
      throw err;
    }
  }

  // The device roles an instance document records as granted, by holder key.
  function heldKeys (stored) {
    const out = {};
    if (!stored) { return out; }
    instances.granted(stored).forEach(function (role) {
      if (role.provenance !== 'device') { return; }
      const record = stored.roles.find(function (r) {
        return r.result === 'granted' && r.channel === role.channel && negotiate.same(r.role, role.role) && r.provenance === 'device';
      });
      out[instances.holderKey(caps, role.channel, role.role, stored.identity)] = {
        channel: role.channel, role: role.role, grantedBy: record[instances.GRANTED_BY]
      };
    });
    return out;
  }

  // Instance writes: first every holder document an instance now holds
  // (taken, renewed or moved, each conditional on what was read), then the
  // releases, then the instance documents. A lost condition means another
  // request got there first: the whole request is decided again.
  async function applyInstances (state, writes) {
    for (const w of writes) {
      if (!w.after) { continue; }
      const held = heldKeys(w.after);
      for (const k of Object.keys(held)) {
        const seen = state.holders[k];
        const doc = { _id: k, instanceId: w.after.instanceId, identity: w.after.identity,
          channel: held[k].channel, role: held[k].role, binding: w.after.boundTo,
          leaseExpiresAt: w.after.leaseExpiresAt };
        if (held[k].grantedBy) { doc[instances.GRANTED_BY] = held[k].grantedBy; }
        if (!(await store.takeHolder(doc, seen))) { return false; }
      }
    }
    for (const w of writes) {
      if (!w.before) { continue; }
      const after = w.after ? heldKeys(w.after) : {};
      for (const k of Object.keys(heldKeys(w.before))) {
        if (!Object.prototype.hasOwnProperty.call(after, k)) { await store.releaseHolder(k, w.before.instanceId); }
      }
    }
    for (const w of writes) {
      if (!(await store.writeInstance(w.before, w.after))) { return false; }
    }
    return true;
  }

  // Applies a product decision: claims first, then the registration, so a
  // namespace is never shown accepted on a registration that does not hold
  // it; then the registration it replaced is kept as a definition (§7), and a
  // change of binding drops the command-sink roles it no longer covers.
  async function applyProduct (identity, v, outcome) {
    const before = v.hub.stored;
    const after = outcome.after;
    if (after === before) { return true; }
    let inserted = [];
    if (after && after.registration && after.state === 'active') {
      inserted = await claimNamespaces(identity, v.hub, negotiate.declaredNamespaces(after.registration)
        .filter(function (ns) { return (after.freedNamespaces || []).indexOf(ns) < 0; }));
      if (inserted === null) { return false; }
    }
    const written = await store.write(before, after);
    if (!written) { await store.unclaim(identity, inserted); return false; }
    const freed = ((after || {}).freedNamespaces || []).filter(function (ns) {
      return ((before || {}).freedNamespaces || []).indexOf(ns) < 0;
    });
    await store.free(identity, freed);
    if (before && before.registration && after && after.registration) {
      const old = require('./canonical').definitionId(before.registration);
      if (old !== require('./canonical').definitionId(after.registration)) {
        await store.addDefinition({ identity: { vendor: identity.vendor, product: identity.product },
          definitionId: old, definition: before.registration });
      }
    }
    if (offersInstances && after) {
      await dropOnRebind(identity, before ? before.boundTo : null);
    }
    return true;
  }

  // Each affected instance is rewritten conditionally; one that changed in
  // between is read again. A holder whose binding no longer matches is void
  // whatever happens here (./instances.js validHolder).
  async function dropOnRebind (identity, boundBefore) {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const state = await store.snapshot();
      const product = instances.findProduct(state, identity);
      const writes = instances.dropOnRebind(state, boundBefore, product);
      if (!writes.length || await applyInstances(state, writes)) { return; }
    }
  }

  async function applyWrites (v, outcome) {
    const w = outcome.writes || {};
    if (w.definition) {
      const inserted = await claimNamespaces(w.definition.identity, v.hub, w.claim || []);
      if (inserted === null) { return false; }
      await store.addDefinition(w.definition);
    }
    if (w.instances && w.instances.length && !(await applyInstances(v.state, w.instances))) { return false; }
    if (w.pins && !(await store.writePins(w.pins.before, w.pins.after))) { return false; }
    return true;
  }

  // A transfer names a subject this site has, by id, or the shared secret.
  function knownBinding (binding) {
    if (!binding || typeof binding !== 'object') { return false; }
    if (binding.kind === 'api-secret') { return Object.keys(binding).length === 1; }
    return binding.kind === 'subject' && typeof binding.subject === 'string' && Object.keys(binding).length === 2 &&
      (ctx.authorization.storage.subjects || []).some(function (s) { return String(s._id) === binding.subject; });
  }

  function identityOf (req) {
    return { vendor: req.params.vendor, product: req.params.product };
  }

  // On the flat instance root the product is the body's `product` (§7
  // amendment); one that is absent or not two strings is no product, which
  // putInstance refuses after the permission check.
  function bodyProduct (req) {
    const p = (req.body || {}).product;
    if (!p || typeof p !== 'object' || Array.isArray(p) ||
        typeof p.vendor !== 'string' || typeof p.product !== 'string' || !p.vendor || !p.product) { return null; }
    return { vendor: p.vendor, product: p.product };
  }

  function busy (res) {
    res.status(503).set('Retry-After', '1').json(negotiate.response(503, 'rejected', {
      reasons: [negotiate.reason('busy', null, 'the registration changed during the request; retry')]
    }));
  }

  // A product decision: `decide` returns { response, after }. `identify`
  // reads the product from the request; the path's by default.
  function handle (decide, identify) {
    return async function (req, res, next) {
      try {
        const identity = (identify || identityOf)(req);
        const submitter = await resolveSubmitter(ctx, req);
        for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
          const v = await view(identity, req.body);
          const outcome = decide(req, identity, submitter, v);
          if (outcome.writes ? await applyWrites(v, outcome) : await applyProduct(identity, v, outcome)) {
            return send(res, outcome);
          }
        }
        busy(res);
      } catch (err) {
        next(err);
      }
    };
  }

  router.put('/:vendor/:product', handle(function (req, identity, submitter, v) {
    const request = { action: 'submit', identity: identity, preconditions: preconditions(req) };
    return negotiate.controller(caps, v.hub, submitter, req.body, request, null, wellKnown);
  }));

  router.delete('/:vendor/:product', handle(function (req, identity, submitter, v) {
    const request = { action: 'retire', identity: identity, preconditions: preconditions(req) };
    return negotiate.controller(caps, v.hub, submitter, null, request, null, wellKnown);
  }));

  if (offersInstances) {
    router.put('/:vendor/:product/definitions/:definitionId', handle(function (req, identity, submitter, v) {
      const request = { action: 'put-definition', identity: identity, definitionId: req.params.definitionId,
        preconditions: preconditions(req) };
      return instances.putDefinition(caps, v.state, submitter, request, req.body, wellKnown, v.hub);
    }));
  }

  router.post('/:vendor/:product/:action', function (req, res, next) {
    const action = req.params.action;
    const isInstanceAction = ['transfer-role', 'pin-version', 'unpin-version'].indexOf(action) >= 0;
    if (negotiate.OWNER_ACTIONS.indexOf(action) < 0 && !(offersInstances && isInstanceAction)) { return next(); }
    return handle(function (req, identity, submitter, v) {
      const request = { action: action, identity: identity, preconditions: preconditions(req) };
      const isOwner = submitter.credentialKind === 'api-secret';
      const body = req.body || {};
      if (action === 'transfer-role') {
        request.transferRole = body.transferRole;
        return instances.transferRole(v.state, request, v.now, isOwner);
      }
      if (action === 'pin-version' || action === 'unpin-version') {
        request.element = body.element;
        request.version = body.version;
        return instances.pinVersion(v.state, request, isOwner);
      }
      if (action === 'transfer') {
        request.transferTo = body.transferTo;
        if (isOwner && !knownBinding(request.transferTo)) {
          return { response: negotiate.response(422, 'rejected', {
            reasons: [negotiate.reason('invalid-transfer', 'transferTo', 'name a stored subject, or api-secret')]
          }), after: v.hub.stored };
        }
      }
      return negotiate.owner(v.hub, request, isOwner);
    })(req, res, next);
  });

  router.get('/:vendor/:product', async function (req, res, next) {
    try {
      const identity = identityOf(req);
      const submitter = await resolveSubmitter(ctx, req);
      if (!submitter.permitted(negotiate.PERMISSION.submit)) {
        return send(res, { response: negotiate.response(403, 'rejected', {
          reasons: [negotiate.reason('not-authorised', null, 'needs ' + negotiate.PERMISSION.submit)]
        }) });
      }
      const v = await view(identity, null);
      send(res, negotiate.read(caps, v.hub, submitter, wellKnown));
    } catch (err) {
      next(err);
    }
  });

  // A body that is not JSON, or too large, answers in the response shape.
  function bodyError (err, req, res, next) {
    if (err && (err.type === 'entity.too.large' || err.type === 'entity.parse.failed')) {
      const status = err.type === 'entity.too.large' ? 413 : 422;
      const code = err.type === 'entity.too.large' ? 'limit-exceeded' : 'invalid-registration';
      return res.status(status).json(negotiate.response(status, 'rejected', { reasons: [negotiate.reason(code)] }));
    }
    next(err);
  }
  router.use(bodyError);

  // The flat instance root (§7 amendment): one path per running copy, under
  // the same credentials and decisions as before.
  const flat = express.Router({ caseSensitive: true, strict: true });
  if (offersInstances) {
    flat.use(bodyParser);

    flat.put('/:instanceId', handle(function (req, identity, submitter, v) {
      const request = { action: 'put-instance', identity: identity, instanceId: req.params.instanceId,
        preconditions: preconditions(req) };
      return instances.putInstance(caps, v.state, submitter, request, req.body, v.now, wellKnown, grammar.instanceError);
    }, bodyProduct));

    flat.delete('/:instanceId', handle(function (req, identity, submitter, v) {
      const request = { action: 'delete-instance', instanceId: req.params.instanceId,
        preconditions: preconditions(req) };
      return instances.deleteInstance(v.state, submitter, request);
    }, function () { return null; }));

    flat.get('/', async function (req, res, next) {
      try {
        const submitter = await resolveSubmitter(ctx, req);
        const v = await view(null, null);
        const request = { action: 'list-instances', includeWithheld: req.query.includeWithheld === 'true' };
        send(res, instances.listInstances(caps, v.state, request, v.now, wellKnown, submitter.credentialKind === 'api-secret'));
      } catch (err) {
        next(err);
      }
    });

    flat.use(bodyError);
  }

  return { products: router, instances: offersInstances ? flat : null };
}

module.exports = create;
module.exports.entityTag = entityTag;
