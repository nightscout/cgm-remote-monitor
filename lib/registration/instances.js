'use strict';

// Definitions, instances, roles and leases (registration specification
// §7-§10), and the owner's instance actions (authority §4: transfer-role,
// pin-version, unpin-version, the listing). Pure: each decision reads a
// snapshot of what is stored (`state`, built by ./store.js) and returns the
// response and the documents to write; ./products.js applies them with
// conditional writes. The specification's reference is
// tools/nsschema/instances.py in the alignment repository.
//
// The holder of a role. Among live `device` instances of active products,
// each (scope, channel, role) has one holder (§9). It is recorded in a holder
// document keyed by (scope, channel, role) (./store.js), which is the
// authority on who holds a role; the instance documents carry each role's
// result for the instance's own view. A holder document counts only while it
// is valid:
//   - its lease has not lapsed (a lapsed lease holds no role, with no
//     housekeeping);
//   - its product is active (a block or retire voids its holders at once,
//     checked here when the role is next claimed or read, so a claim that
//     raced the block cannot keep the role);
//   - for a `command-sink`, the instance's binding still matches the
//     product's, unless the owner granted it by transfer-role (§9, authority
//     §6). A rebind also rewrites the affected instance documents
//     (dropOnRebind), as the specification shows them.

const canonical = require('./canonical');
const negotiate = require('./negotiate');
const grammar = require('./grammar');

const INSTANCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// A label key is <reverse-DNS namespace>/<name> (§10).
const LABEL_NAME = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function labelKey (k) {
  const parts = k.split('/');
  if (parts.length !== 2 || !LABEL_NAME.test(parts[1])) { return false; }
  const ns = parts[0].split('.');
  return ns.length >= 2 && /^[a-z][a-z0-9-]*$/.test(ns[0]) &&
    ns.slice(1).every(function (seg) { return /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(seg); });
}
const RESERVED_LABEL_PREFIX = 'dev.nightscout/';
const WELL_KNOWN_LABELS = {
  'dev.nightscout/purpose': ['therapy', 'development', 'lab', 'research'],
  'dev.nightscout/build': ['release', 'dev'],
  'dev.nightscout/migration-group': null
};
const PROVENANCE = ['device', 'simulated'];
const GRANTED_BY = 'grantedBy';
const TRANSFER_GRANT = 'transfer-role';

const reason = negotiate.reason;
const same = negotiate.same;

function has (node, key) {
  return node !== null && typeof node === 'object' && Object.prototype.hasOwnProperty.call(node, key);
}

function response (status, outcome, members) {
  const out = { apiVersion: grammar.apiVersion, kind: 'InstanceResponse', status: status, outcome: outcome };
  Object.keys(members || {}).forEach(function (k) {
    if (members[k] !== undefined && members[k] !== null) { out[k] = members[k]; }
  });
  return out;
}

function refused (status, code, path, detail, members) {
  return response(status, 'rejected', Object.assign({ reasons: [reason(code, path, detail)] }, members || {}));
}

// ── time ──────────────────────────────────────────────────────────────

// Leases are whole seconds in UTC, written as the specification writes them.
function text (ms) {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

function time (value) {
  return Date.parse(value);
}

function live (stored, now) {
  return time(stored.leaseExpiresAt) > time(now);
}

// ── state ─────────────────────────────────────────────────────────────

function ident (identity) {
  return identity.vendor + '/' + identity.product;
}

function sameIdentity (a, b) {
  return Boolean(a && b) && a.vendor === b.vendor && a.product === b.product;
}

function findProduct (state, identity) {
  return (state.registrations || []).find(function (r) { return sameIdentity(r.identity, identity); }) || null;
}

function productState (state, identity) {
  const stored = findProduct(state, identity);
  return stored && stored.registration ? stored.state : null;
}

function findInstance (state, instanceId) {
  return (state.instances || []).find(function (i) { return i.instanceId === instanceId; }) || null;
}

// Every definition stored for the product: those added at
// <product>/definitions/<id>, and the product's current registration.
function productDefinitions (state, identity) {
  const out = {};
  (state.definitions || []).forEach(function (d) {
    if (sameIdentity(d.identity, identity)) { out[d.definitionId] = d.definition; }
  });
  const stored = findProduct(state, identity);
  if (stored && stored.registration) {
    const id = canonical.definitionId(stored.registration);
    if (!has(out, id)) { out[id] = stored.registration; }
  }
  return out;
}

function productNamespaces (state, identity) {
  const found = [];
  Object.values(productDefinitions(state, identity)).forEach(function (definition) {
    negotiate.declaredNamespaces(definition).forEach(function (ns) {
      if (found.indexOf(ns) < 0) { found.push(ns); }
    });
  });
  return found;
}

function key (role) {
  return { channel: role.channel, role: role.role, provenance: role.provenance };
}

function granted (stored) {
  return ((stored && stored.roles) || []).filter(function (r) { return r.result === 'granted'; }).map(key);
}

function transferred (stored) {
  return ((stored && stored.roles) || []).filter(function (r) {
    return r.result === 'granted' && r[GRANTED_BY] === TRANSFER_GRANT;
  }).map(key);
}

function contains (list, item) {
  return list.some(function (x) { return same(x, item); });
}

function instanceEtag (body, boundTo, rolesGranted) {
  const sorted = rolesGranted.map(function (r) { return [canonical.canonicalJSON(r), r]; })
    .sort(function (a, b) { return a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0); })
    .map(function (pair) { return pair[1]; });
  return canonical.sha256({ instance: body, boundTo: boundTo, granted: sorted });
}

function storedInstance (identity, instanceId, body, boundTo, credentialKind, roles, lease, aliases) {
  const out = {
    identity: { vendor: identity.vendor, product: identity.product }, instanceId: instanceId,
    etag: instanceEtag(body, boundTo, roles.filter(function (r) { return r.result === 'granted'; }).map(key)),
    boundTo: boundTo, credentialKind: credentialKind, leaseExpiresAt: lease, roles: roles, instance: body
  };
  if (aliases && aliases.length) { out.observedAliases = aliases; }
  return out;
}

function restateInstance (stored, changes) {
  const m = Object.assign({ body: stored.instance, boundTo: stored.boundTo, credentialKind: stored.credentialKind,
    roles: stored.roles, lease: stored.leaseExpiresAt, aliases: stored.observedAliases }, changes || {});
  return storedInstance(stored.identity, stored.instanceId, m.body, m.boundTo, m.credentialKind, m.roles, m.lease, m.aliases);
}

function summary (stored, now) {
  return {
    vendor: stored.identity.vendor, product: stored.identity.product, instanceId: stored.instanceId,
    definitionId: stored.instance.definitionId, etag: stored.etag, leaseExpiresAt: stored.leaseExpiresAt,
    live: live(stored, now), boundTo: stored.boundTo, credentialKind: stored.credentialKind
  };
}

// ── channels (§9) ─────────────────────────────────────────────────────

function isShared (caps, channel) {
  return negotiate.sharedSlots(caps).indexOf(channel) >= 0;
}

// The products a channel's roles contend among: the site for a shared slot
// (null), else the one product.
function scopeOf (caps, channel, identity) {
  return isShared(caps, channel) ? null : { vendor: identity.vendor, product: identity.product };
}

// The holder document's key for (scope, channel, role).
function holderKey (caps, channel, role, identity) {
  const scope = scopeOf(caps, channel, identity);
  return canonical.canonicalJSON([scope ? ident(scope) : '*', channel, role]);
}

function slotChannel (caps, node, fallback) {
  const slot = node.slot;
  const sameAs = node.sameAs;
  if (sameAs === undefined || sameAs === null || !caps.grammar.interprets.some(function (e) {
    const n = 'spec.stateSpans.*.sameAs';
    return n === e || n.indexOf(e + '.') === 0;
  })) {
    return slot;
  }
  return negotiate.sharedSlots(caps).indexOf(sameAs) >= 0 ? sameAs : fallback;
}

function channels (caps, wellKnown, definition) {
  const meta = definition.metadata;
  const out = {};
  negotiate.elements(definition).forEach(function (el) {
    const source = el.kind === 'stateSpans'
      ? (isObject(el.node.wellKnownRef) ? (negotiate.resolveReference(caps, wellKnown, el.node) || {}) : el.node)
      : el.node;
    const slot = el.kind === 'stateSpans' ? source.slot : undefined;
    const elementChannel = meta.vendor + '/' + meta.product + '/' + el.id;
    const name = (typeof slot === 'string' && slot && slot.indexOf('/') < 0)
      ? slotChannel(caps, source, elementChannel) : elementChannel;
    if (!has(out, name)) { out[name] = { elements: [], commands: false, shared: isShared(caps, name) }; }
    out[name].elements.push(el.id);
    const accepts = ((source.acceptsFromHub || {}).channels) || [];
    if (el.kind === 'stateSpans' && accepts.indexOf('command') >= 0) { out[name].commands = true; }
  });
  return out;
}

function isObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ── the holder (§9) ───────────────────────────────────────────────────

function bindingMatches (state, identity, binding) {
  const stored = findProduct(state, identity);
  const bound = stored ? stored.boundTo : null;
  return bound !== null && bound !== undefined && same(bound, binding);
}

// Whether a holder document still holds its role (see the header).
function validHolder (state, doc, now) {
  if (!doc || time(doc.leaseExpiresAt) <= time(now)) { return false; }
  if (productState(state, doc.identity) !== 'active') { return false; }
  if (doc.role === 'command-sink' && doc[GRANTED_BY] !== TRANSFER_GRANT &&
      !bindingMatches(state, doc.identity, doc.binding)) { return false; }
  return true;
}

// The live `device` instance holding (channel, role) in the scope, or null.
function holder (caps, state, channel, role, identity, now, exclude) {
  const doc = (state.holders || {})[holderKey(caps, channel, role, identity)];
  if (!validHolder(state, doc, now) || doc.instanceId === exclude) { return null; }
  return doc.instanceId;
}

function commandSinkPermitted (state, identity, binding, storedBefore, claim) {
  if (claim.provenance === 'simulated') { return true; }
  if (bindingMatches(state, identity, binding)) { return true; }
  return contains(transferred(storedBefore), key(claim));
}

function evaluateRoles (caps, state, wellKnown, instanceId, body, definition, now, identity, binding, storedBefore) {
  const chans = channels(caps, wellKnown, definition);
  const supported = (caps.instances.roles || []).map(function (r) { return canonical.canonicalJSON(r); });
  const byTransfer = transferred(storedBefore);
  return (body.roles || []).map(function (claim, i) {
    const path = 'roles.' + i;
    const reasons = [];
    if (PROVENANCE.indexOf(claim.provenance) < 0) {
      reasons.push(reason('unknown-provenance', path + '.provenance', 'provenance is device or simulated'));
    }
    if (supported.indexOf(canonical.canonicalJSON(claim.role)) < 0) {
      reasons.push(reason('unsupported-role', path + '.role', 'the hub does not list this role'));
    }
    if (!has(chans, claim.channel)) {
      reasons.push(reason('unknown-channel', path + '.channel', 'the instance\'s definition derives no such channel'));
    } else if (claim.role === 'command-sink' && !chans[claim.channel].commands) {
      reasons.push(reason('not-a-command-channel', path + '.channel', 'no kind on this channel accepts hub commands'));
    }
    if (!reasons.length && claim.role === 'command-sink' &&
        !commandSinkPermitted(state, identity, binding, storedBefore, claim)) {
      reasons.push(reason('not-registration-owner', path,
        'a command-sink role goes to an instance of the product\'s bound subject, or by the owner\'s transfer'));
    }
    if (!reasons.length && claim.provenance === 'device' &&
        holder(caps, state, claim.channel, claim.role, identity, now, instanceId)) {
      reasons.push(reason('role-held', path, 'another live device instance holds this role'));
    }
    const result = { channel: claim.channel, role: claim.role, provenance: claim.provenance };
    if (reasons.length) {
      result.result = 'refused';
      result.reasons = reasons;
    } else {
      result.result = 'granted';
      if (contains(byTransfer, key(claim))) { result[GRANTED_BY] = TRANSFER_GRANT; }
    }
    return result;
  });
}

// ── content checks ────────────────────────────────────────────────────

function labelProblems (caps, labels) {
  const limits = ((caps.instances || {}).labels) || {};
  const problems = [];
  const keys = Object.keys(labels).sort();
  if (limits.maxLabels !== undefined && keys.length > limits.maxLabels) {
    problems.push(['labels', keys.length + ' labels exceed maxLabels']);
  }
  keys.forEach(function (k) {
    const value = labels[k];
    if (!labelKey(k)) {
      problems.push(['labels.' + k, 'a key is <reverse-DNS namespace>/<name>']);
    } else if (k.indexOf(RESERVED_LABEL_PREFIX) === 0 && !has(WELL_KNOWN_LABELS, k)) {
      problems.push(['labels.' + k, 'dev.nightscout/ is reserved for well-known keys']);
    }
    if (typeof value !== 'string') {
      problems.push(['labels.' + k, 'a label value is a string']);
    } else if (limits.maxValueLength !== undefined && value.length > limits.maxValueLength) {
      problems.push(['labels.' + k, 'value exceeds maxValueLength']);
    }
    if (limits.maxKeyLength !== undefined && k.length > limits.maxKeyLength) {
      problems.push(['labels.' + k, 'key exceeds maxKeyLength']);
    }
  });
  return problems;
}

// ── definitions: PUT <product>/definitions/<definitionId> ─────────────

function putDefinition (caps, state, submitter, request, body, wellKnown, hubView) {
  const identity = request.identity;
  const stored = findProduct(state, identity);
  const r = negotiate.rejecter(stored);
  const keep = { state: null };
  function out (result) { return { response: result.response, writes: keep }; }
  if (!submitter.permitted(negotiate.PERMISSION.submit)) {
    return out(r.reject(403, 'not-authorised', null, 'needs api:registrations:create'));
  }
  if (!negotiate.registered(stored)) {
    return { response: negotiate.response(404, 'not-found', { reasons: [reason('not-found')] }), writes: keep };
  }
  if (stored.boundTo === null || stored.boundTo === undefined || !same(stored.boundTo, negotiate.bindingOf(submitter))) {
    return out(r.reject(403, 'not-registration-owner', null, 'definitions are added by the credential the product is bound to'));
  }
  const pre = request.preconditions || {};
  if (!has(pre, 'ifNoneMatch')) {
    return out(r.failed(428, 'precondition-required', 'a definition is created with If-None-Match: *'));
  }
  if (stored.state === 'blocked') { return out(r.reject(403, 'blocked-by-owner')); }
  if (stored.state === 'retired') { return out(r.reject(409, 'product-retired', null, 'reactivate the product first')); }
  const did = canonical.definitionId(body);
  if (did !== request.definitionId) {
    return out(r.reject(422, 'definition-id-mismatch', null, 'the body\'s canonical hash is not the path\'s id'));
  }
  const refusal = negotiate.contentRefusal(caps, body, identity, r.reject);
  if (refusal) { return out(refusal); }
  const existing = productDefinitions(state, identity);
  const ev = negotiate.evaluate(caps, hubView, submitter, body, null, wellKnown);
  const outcome = ev.elements.some(function (e) { return e.result === 'rejected'; }) ? 'partial' : 'accepted';
  const isNew = !has(existing, did);
  return {
    response: negotiate.response(isNew ? 201 : 200, outcome, {
      noop: !isNew, definitionId: did, registration: negotiate.summary(stored), ignored: ev.ignored, elements: ev.elements
    }),
    writes: { definition: isNew ? { identity: { vendor: identity.vendor, product: identity.product }, definitionId: did, definition: body } : null,
      claim: isNew ? negotiate.declaredNamespaces(body) : [] }
  };
}

// ── instances: PUT / DELETE <product>/instances/<instanceId> ──────────

function putInstance (caps, state, submitter, request, body, now, wellKnown, validateInstance) {
  const identity = request.identity;
  const instanceId = request.instanceId;
  const product = findProduct(state, identity);
  const stored = findInstance(state, instanceId);
  const pre = request.preconditions || {};
  const none = { response: null, writes: {} };
  function current () {
    return stored ? { etag: stored.etag, leaseExpiresAt: stored.leaseExpiresAt } : null;
  }
  function answer (res) { return Object.assign({}, none, { response: res }); }

  // 1. Authorisation.
  if (!submitter.permitted(negotiate.PERMISSION.submit)) {
    return answer(refused(403, 'not-authorised', null, 'needs api:registrations:create'));
  }
  if (!negotiate.registered(product)) {
    return answer(response(404, 'not-found', { reasons: [reason('not-found')] }));
  }
  if (stored && (!sameIdentity(stored.identity, identity) || !same(stored.boundTo, negotiate.bindingOf(submitter)))) {
    return answer(refused(403, 'not-registration-owner', null, 'the instance is bound to another credential'));
  }
  // 2. Preconditions, then the product's state.
  if (!has(pre, 'ifMatch') && !has(pre, 'ifNoneMatch')) {
    return answer(response(428, 'precondition-failed', { reasons: [reason('precondition-required')] }));
  }
  if (has(pre, 'ifNoneMatch') && stored && !same(stored.instance, body)) {
    return answer(response(412, 'precondition-failed', { reasons: [reason('registration-exists')], current: current() }));
  }
  if (has(pre, 'ifMatch')) {
    if (!stored) { return answer(response(412, 'precondition-failed', { reasons: [reason('not-found')] })); }
    if (pre.ifMatch !== stored.etag) {
      return answer(response(412, 'precondition-failed', { reasons: [reason('stale-etag')], current: current() }));
    }
  }
  if (product.state === 'blocked') { return answer(refused(403, 'blocked-by-owner')); }
  if (product.state === 'retired') { return answer(refused(409, 'product-retired')); }
  // 3. The instance as a whole.
  if (!INSTANCE_ID.test(instanceId)) {
    return answer(refused(422, 'invalid-instance-id', null, 'an instance id is a random UUID version 4'));
  }
  if (isObject(body) && isObject(body.labels)) {
    const problems = labelProblems(caps, body.labels);
    if (problems.length) { return answer(refused(422, 'invalid-label', problems[0][0], problems[0][1])); }
  }
  const error = validateInstance(body);
  if (error) { return answer(refused(422, 'invalid-instance', error.path || null, error.message)); }
  const keys = (body.roles || []).map(function (r) { return r.channel + '\u0000' + canonical.canonicalJSON(r.role); });
  if (new Set(keys).size !== keys.length) {
    return answer(refused(422, 'invalid-instance', 'roles', 'a (channel, role) is claimed once'));
  }
  const definition = productDefinitions(state, identity)[body.definitionId];
  if (!definition) {
    return answer(refused(422, 'unknown-definition', 'definitionId', 'not a stored definition of this product'));
  }
  // 4. Roles: a renewal re-evaluates every claim; a lapsed or dropped role
  // goes to the claimant on its own next renewal, never automatically.
  const binding = negotiate.bindingOf(submitter);
  const roles = evaluateRoles(caps, state, wellKnown, instanceId, body, definition, now, identity, binding, stored);
  const lease = text(time(now) + caps.instances.leaseSeconds * 1000);
  const after = storedInstance(identity, instanceId, body, binding, submitter.credentialKind, roles, lease,
    (stored || {}).observedAliases);
  const outcome = roles.some(function (r) { return r.result === 'refused'; }) ? 'partial' : 'accepted';
  return {
    response: response(stored ? 200 : 201, outcome, {
      noop: Boolean(stored) && stored.etag === after.etag, instance: summary(after, now), roles: roles
    }),
    writes: { instances: [{ before: stored, after: after }] }
  };
}

function deleteInstance (state, submitter, request) {
  const stored = findInstance(state, request.instanceId);
  const pre = request.preconditions || {};
  const none = {};
  if (!submitter.permitted(negotiate.PERMISSION.retire)) {
    return { response: refused(403, 'not-authorised', null, 'needs api:registrations:delete'), writes: none };
  }
  if (!stored || !sameIdentity(stored.identity, request.identity)) {
    return { response: response(404, 'not-found', { reasons: [reason('not-found')] }), writes: none };
  }
  if (!same(stored.boundTo, negotiate.bindingOf(submitter))) {
    return { response: refused(403, 'not-registration-owner'), writes: none };
  }
  if (!has(pre, 'ifMatch')) {
    return { response: response(428, 'precondition-failed', { reasons: [reason('precondition-required')] }), writes: none };
  }
  if (pre.ifMatch !== stored.etag) {
    return { response: response(412, 'precondition-failed', { reasons: [reason('stale-etag')],
      current: { etag: stored.etag, leaseExpiresAt: stored.leaseExpiresAt } }), writes: none };
  }
  return { response: response(200, 'released', { noop: false }), writes: { instances: [{ before: stored, after: null }] } };
}

// ── rebind (§9; authority §6) ─────────────────────────────────────────

// When a product's binding changes, every device command-sink role held by
// an instance of it whose binding no longer matches is dropped, except one
// the owner granted by transfer-role. Returns the instance writes.
function dropOnRebind (stateBefore, boundBefore, productAfter) {
  const boundAfter = productAfter ? productAfter.boundTo : null;
  if (same(boundBefore === undefined ? null : boundBefore, boundAfter === undefined ? null : boundAfter)) { return []; }
  const writes = [];
  (stateBefore.instances || []).forEach(function (stored) {
    if (!sameIdentity(stored.identity, productAfter.identity)) { return; }
    if (boundAfter !== null && boundAfter !== undefined && same(boundAfter, stored.boundTo)) { return; }
    let dropped = false;
    const roles = stored.roles.map(function (r, i) {
      if (r.result === 'granted' && r.role === 'command-sink' && r.provenance === 'device' && r[GRANTED_BY] !== TRANSFER_GRANT) {
        dropped = true;
        return Object.assign(key(r), { result: 'refused', reasons: [reason('not-registration-owner', 'roles.' + i,
          'dropped: the product\'s binding changed')] });
      }
      return r;
    });
    if (dropped) { writes.push({ before: stored, after: restateInstance(stored, { roles: roles }) }); }
  });
  return writes;
}

// ── the owner ─────────────────────────────────────────────────────────

function ownerRefusal (isOwner) {
  return isOwner ? null : refused(403, 'not-authorised', null, 'owner actions need API_SECRET on a single-site server');
}

function transferRole (state, request, now, isOwner) {
  const refusal = ownerRefusal(isOwner);
  if (refusal) { return { response: refusal, writes: {} }; }
  const move = request.transferRole || {};
  const source = findInstance(state, move.from);
  const target = findInstance(state, move.to);
  const pre = request.preconditions || {};
  if (!source || !target) {
    return { response: response(404, 'not-found', { reasons: [reason('not-found')] }), writes: {} };
  }
  if (!has(pre, 'ifMatch')) {
    return { response: response(428, 'precondition-failed', { reasons: [reason('precondition-required')] }), writes: {} };
  }
  if (pre.ifMatch !== source.etag) {
    return { response: response(412, 'precondition-failed', { reasons: [reason('stale-etag')],
      current: { etag: source.etag, leaseExpiresAt: source.leaseExpiresAt } }), writes: {} };
  }
  const want = { channel: move.channel, role: move.role, provenance: 'device' };
  if (!contains(granted(source), want)) {
    return { response: refused(409, 'role-not-granted', null, 'the from instance was not granted this role'), writes: {} };
  }
  const claims = ((target.instance || {}).roles || []).filter(function (r) {
    return r.channel === move.channel && same(r.role, move.role) && r.provenance === 'device';
  });
  if (!claims.length) {
    return { response: refused(409, 'role-not-claimed', null, 'the to instance does not claim this role with device provenance'), writes: {} };
  }
  if (!live(target, now)) {
    return { response: refused(409, 'not-live', null, 'the to instance\'s lease has lapsed'), writes: {} };
  }
  function moved (stored, nowGranted) {
    const roles = stored.roles.map(function (r) {
      if (r.channel === move.channel && same(r.role, move.role) && r.provenance === 'device') {
        const k = key(r);
        if (nowGranted) {
          k.result = 'granted';
          k[GRANTED_BY] = TRANSFER_GRANT;
        } else {
          k.result = 'refused';
          k.reasons = [reason('role-held', null, 'transferred by the owner')];
        }
        return k;
      }
      return r;
    });
    return restateInstance(stored, { roles: roles });
  }
  const sourceAfter = moved(source, false);
  const targetAfter = moved(target, true);
  return {
    response: response(200, 'applied', { noop: false, instances: [summary(sourceAfter, now), summary(targetAfter, now)] }),
    writes: { instances: [{ before: source, after: sourceAfter }, { before: target, after: targetAfter }],
      transfer: { from: source, to: targetAfter, channel: move.channel, role: move.role } }
  };
}

function pinsEtag (pins) {
  return canonical.sha256({ pins: pins });
}

function findPins (state, identity) {
  return (state.pins || []).find(function (p) { return sameIdentity(p.identity, identity); }) || null;
}

function storedVersions (state, identity, element) {
  const out = [];
  Object.values(productDefinitions(state, identity)).forEach(function (definition) {
    negotiate.elements(definition).forEach(function (el) {
      if (el.id === element && (el.kind === 'stateSpans' || el.kind === 'extensions')) {
        const version = negotiate.storedVersion(el.node);
        if (version !== undefined && version !== null && out.indexOf(version) < 0) { out.push(version); }
      }
    });
  });
  return out;
}

function pinVersion (state, request, isOwner) {
  const refusal = ownerRefusal(isOwner);
  if (refusal) { return { response: refusal, writes: {} }; }
  const identity = request.identity;
  const entry = findPins(state, identity);
  const pre = request.preconditions || {};
  if (!has(pre, 'ifMatch') && !has(pre, 'ifNoneMatch')) {
    return { response: response(428, 'precondition-failed', { reasons: [reason('precondition-required')] }), writes: {} };
  }
  if (!entry && !has(pre, 'ifNoneMatch')) {
    return { response: response(412, 'precondition-failed', { reasons: [reason('not-found')] }), writes: {} };
  }
  if (entry && pre.ifMatch !== entry.etag) {
    return { response: response(412, 'precondition-failed', { reasons: [reason('stale-etag')], current: { etag: entry.etag } }), writes: {} };
  }
  const pins = Object.assign({}, (entry || {}).pins || {});
  const element = request.element;
  if (request.action === 'pin-version') {
    if (storedVersions(state, identity, element).indexOf(request.version) < 0) {
      return { response: refused(422, 'unknown-version', 'version', 'no stored definition of this product stores that version'), writes: {} };
    }
    pins[element] = request.version;
  } else {
    delete pins[element];
  }
  const after = { identity: { vendor: identity.vendor, product: identity.product }, etag: pinsEtag(pins), pins: pins };
  const noop = Boolean(entry) && same(entry.pins, pins);
  return {
    response: response(entry ? 200 : 201, 'applied', { noop: noop, pins: after }),
    writes: { pins: { before: entry, after: Object.keys(pins).length ? after : null } }
  };
}

function overlaps (caps, state, now) {
  const out = [];
  (state.instances || []).forEach(function (stored) {
    if (!live(stored, now)) { return; }
    (stored.roles || []).forEach(function (r) {
      if (r.result === 'refused' && r.provenance === 'device' &&
          (r.reasons || []).some(function (x) { return x.code === 'role-held'; })) {
        out.push({ channel: r.channel, role: r.role, claimant: stored.instanceId,
          holder: holder(caps, state, r.channel, r.role, stored.identity, now, stored.instanceId) });
      }
    });
  });
  return out.map(function (o) { return [canonical.canonicalJSON(o), o]; })
    .sort(function (a, b) { return a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0); }).map(function (p) { return p[1]; });
}

function declarations (state) {
  const pairs = (state.registrations || []).filter(function (r) { return r.registration; })
    .map(function (r) { return [r.identity, r.registration]; });
  return pairs.concat((state.definitions || []).map(function (d) { return [d.identity, d.definition]; }));
}

function slotNameObservations (caps, state, wellKnown) {
  const seen = {};
  declarations(state).forEach(function (pair) {
    const chans = channels(caps, wellKnown, pair[1]);
    Object.keys(chans).forEach(function (name) {
      if (name.indexOf('/') < 0 && !chans[name].shared) {
        seen[name] = seen[name] || {};
        seen[name][ident(pair[0])] = pair[0];
      }
    });
  });
  return Object.keys(seen).sort().filter(function (name) { return Object.keys(seen[name]).length > 1; })
    .map(function (name) {
      return { slot: name, products: Object.keys(seen[name]).sort().map(function (k) {
        return { vendor: seen[name][k].vendor, product: seen[name][k].product };
      }) };
    });
}

function listInstances (caps, state, request, now, wellKnown, isOwner) {
  const refusal = ownerRefusal(isOwner);
  if (refusal) { return { response: refusal, writes: {} }; }
  const listed = (state.instances || []).slice().sort(function (a, b) {
    return a.instanceId < b.instanceId ? -1 : (a.instanceId > b.instanceId ? 1 : 0);
  }).map(function (stored) {
    const entry = summary(stored, now);
    entry.roles = stored.roles;
    entry.labels = (stored.instance || {}).labels || {};
    if (request.includeWithheld && stored.observedAliases) { entry.observedAliases = stored.observedAliases; }
    return entry;
  });
  const registrations = (state.registrations || []).slice().sort(function (a, b) {
    return ident(a.identity) < ident(b.identity) ? -1 : (ident(a.identity) > ident(b.identity) ? 1 : 0);
  }).map(negotiate.summary);
  const observations = slotNameObservations(caps, state, wellKnown);
  return {
    response: response(200, 'listed', { registrations: registrations, instances: listed,
      overlaps: overlaps(caps, state, now), slotNameObservations: observations.length ? observations : null }),
    writes: {}
  };
}

module.exports = {
  INSTANCE_ID,
  GRANTED_BY,
  TRANSFER_GRANT,
  text,
  live,
  findProduct,
  findInstance,
  productDefinitions,
  productNamespaces,
  granted,
  holderKey,
  validHolder,
  holder,
  channels,
  evaluateRoles,
  labelProblems,
  instanceEtag,
  putDefinition,
  putInstance,
  deleteInstance,
  dropOnRebind,
  transferRole,
  pinVersion,
  pinsEtag,
  listInstances,
  overlaps,
  slotNameObservations
};
