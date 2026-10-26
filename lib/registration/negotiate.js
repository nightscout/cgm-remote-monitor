'use strict';

// The decisions of the product resource (registration specification §5-§7):
// given the hub's capability document, what is stored for the product, the
// credential and the request, the response and what to store afterwards.
// Pure: it reads only the `hub` view it is given and writes nothing; the
// store applies `after` with a conditional write (./store.js).
//
// The specification's reference for the same decisions is
// tools/nsschema/negotiate.py in the alignment repository; the conformance
// cases under specs/sync/conformance/ check both.

const canonical = require('./canonical');
const grammar = require('./grammar');

const API_VERSION = grammar.apiVersion;
const PERMISSION = { submit: 'api:registrations:create', retire: 'api:registrations:delete' };
const CONTROLLER_ACTIONS = ['submit', 'retire'];
const ANNOTATIONS = ['description'];

// §7: the members that give an element its meaning.
const SPAN_MEANING = ['category', 'kind', 'slot', 'exclusiveWithinSlot', 'coexistsWith', 'overlay',
  'supersedes', 'states', 'endReasons', 'wire', 'dualWriteLink', 'requested', 'applied', 'initiators',
  'definitions', 'acceptsFromHub', 'horizon', 'sameAs'];
const EXTENSION_MEANING = ['carrier', 'dualWriteLink', 'horizon', 'fields'];
const FIELD_MEANING = ['name', 'type', 'typeRef', 'unit', 'range', 'horizon', 'sensitivity'];
const NOT_MEANING = ['description', 'evidence', 'writtenWhen'];
const MEANING_MAPS = ['vocabularies', 'properties'];
const REFERENCE_MEMBERS = ['category', 'kind', 'wellKnownRef', 'availability', 'description', 'evidence'];

function has (node, key) {
  return node !== null && typeof node === 'object' && Object.prototype.hasOwnProperty.call(node, key);
}

function isObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function same (a, b) {
  return canonical.canonicalJSON(a) === canonical.canonicalJSON(b);
}

function under (path, ancestor) {
  return path === ancestor || path.indexOf(ancestor + '.') === 0;
}

function reason (code, path, detail) {
  const out = { code: code };
  if (path !== undefined && path !== null) { out.path = path; }
  if (detail !== undefined && detail !== null) { out.detail = detail; }
  return out;
}

// ── meaning (§7) ──────────────────────────────────────────────────────

function carrierPath (item) {
  if (isObject(item)) {
    const keys = Object.keys(item).filter(function (k) { return NOT_MEANING.indexOf(k) < 0; });
    if (keys.length === 1 && keys[0] === 'path') { return item.path; }
  }
  return item;
}

function norm (value, isMap) {
  if (Array.isArray(value)) {
    const items = value.map(function (v) { return norm(v); });
    if (items.every(function (v) { return typeof v === 'string'; })) {
      return items.slice().sort(function (a, b) { return a < b ? -1 : (a > b ? 1 : 0); });
    }
    return items.map(function (v) { return [canonical.canonicalJSON(v), v]; })
      .sort(function (a, b) { return a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0); })
      .map(function (pair) { return pair[1]; });
  }
  if (isObject(value)) {
    const out = {};
    Object.keys(value).forEach(function (k) {
      if (!isMap && NOT_MEANING.indexOf(k) >= 0) { return; }
      let v = value[k];
      if (k === 'paths' && Array.isArray(v)) { v = v.map(carrierPath); }
      out[k] = norm(v, MEANING_MAPS.indexOf(k) >= 0);
    });
    return out;
  }
  return value;
}

function pick (node, keys) {
  const out = {};
  keys.forEach(function (k) { if (has(node, k)) { out[k] = node[k]; } });
  return out;
}

function meaning (kind, node) {
  if (kind === 'stateSpans') { return norm(pick(node, SPAN_MEANING)); }
  const picked = pick(node, EXTENSION_MEANING.filter(function (k) { return k !== 'fields'; }));
  const fields = {};
  (Array.isArray(node.fields) ? node.fields : []).forEach(function (field) {
    if (isObject(field) && has(field, 'name')) { fields[field.name] = pick(field, FIELD_MEANING); }
  });
  picked.fields = fields;
  return norm(picked);
}

function storedVersion (node) {
  if (isObject(node.wellKnownRef)) { return node.wellKnownRef.version; }
  if (isObject(node.versions)) { return node.versions.stored; }
  return node.version;
}

// ── the well-known catalogue ──────────────────────────────────────────

function catalogue (caps, wellKnown) {
  const out = {};
  (((caps || {}).wellKnown || {}).kinds || []).forEach(function (entry) {
    const reg = (wellKnown || {})[entry.href];
    if (reg && entry.id) { out[entry.id] = reg; }
  });
  return out;
}

function resolveReference (caps, wellKnown, node) {
  const ref = node.wellKnownRef;
  if (!isObject(ref)) { return null; }
  const reg = catalogue(caps, wellKnown)[ref.catalogue];
  if (!reg) { return null; }
  const spans = ((reg.spec || {}).stateSpans) || [];
  for (const span of spans) {
    if ((span.kind || span.category) !== ref.kind) { continue; }
    const version = storedVersion(span);
    if (version !== undefined && version !== null && version === ref.version) { return span; }
  }
  return null;
}

function resolved (caps, wellKnown, kind, node) {
  if (kind === 'stateSpans' && isObject(node.wellKnownRef)) {
    return resolveReference(caps, wellKnown, node);
  }
  return node;
}

// ── elements (§5.3) ───────────────────────────────────────────────────

function typed (field) {
  return isObject(field) && (has(field, 'type') || has(field, 'typeRef'));
}

function elements (registration) {
  const spec = (registration || {}).spec || {};
  const out = [];
  (Array.isArray(spec.stateSpans) ? spec.stateSpans : []).forEach(function (span, i) {
    const name = span.kind || span.category;
    const path = 'spec.stateSpans.' + i;
    const defining = [path + '.category'].concat(has(span, 'wellKnownRef') ? [path + '.wellKnownRef'] : []);
    out.push({ id: 'stateSpans/' + name, path: path, defining: defining, node: span, kind: 'stateSpans' });
  });
  Object.keys(isObject(spec.extensions) ? spec.extensions : {}).forEach(function (ns) {
    const ext = spec.extensions[ns];
    const path = 'spec.extensions.' + ns;
    let defining = [path + '.fields'];
    ['version', 'versions'].forEach(function (k) { if (has(ext, k)) { defining.push(path + '.' + k); } });
    (Array.isArray((ext || {}).fields) ? ext.fields : []).forEach(function (field, j) {
      if (isObject(field)) {
        ['name', 'type', 'typeRef'].forEach(function (k) {
          if (has(field, k)) { defining.push(path + '.fields.' + j + '.' + k); }
        });
      }
    });
    out.push({ id: 'extensions/' + ns, path: path, defining: defining, node: ext, kind: 'extensions' });
  });
  ((isObject(spec.settings) && Array.isArray(spec.settings.fields)) ? spec.settings.fields : []).forEach(function (field, i) {
    if (typed(field)) {
      const path = 'spec.settings.fields.' + i;
      const defining = ['name', 'type', 'typeRef'].filter(function (k) { return has(field, k); })
        .map(function (k) { return path + '.' + k; });
      out.push({ id: 'settings.fields/' + field.name, path: path, defining: defining, node: field, kind: 'settings' });
    }
  });
  (Array.isArray(spec.replayInputs) ? spec.replayInputs : []).forEach(function (row, i) {
    if (typed(row)) {
      const path = 'spec.replayInputs.' + i;
      const defining = ['input', 'type', 'typeRef'].filter(function (k) { return has(row, k); })
        .map(function (k) { return path + '.' + k; });
      out.push({ id: 'replayInputs/' + row.input, path: path, defining: defining, node: row, kind: 'replayInputs' });
    }
  });
  return out;
}

function declaredNamespaces (registration) {
  const ext = (((registration || {}).spec) || {}).extensions;
  return isObject(ext) ? Object.keys(ext) : [];
}

// §7: for each stateSpans kind and extension, a stored definition of the
// same product that declares it at the same version with another meaning.
function versionConflicts (caps, hub, wellKnown, definition) {
  const out = {};
  const stored = hub.productDefinitions();
  const mine = canonical.definitionId(definition);
  elements(definition).forEach(function (el) {
    if (el.kind !== 'stateSpans' && el.kind !== 'extensions') { return; }
    const node = resolved(caps, wellKnown, el.kind, el.node);
    if (!node) { return; }
    const version = storedVersion(el.node);
    const wanted = canonical.canonicalJSON(meaning(el.kind, node));
    Object.keys(stored).sort().forEach(function (did) {
      if (did === mine || has(out, el.id)) { return; }
      elements(stored[did]).forEach(function (other) {
        if (other.id !== el.id || storedVersion(other.node) !== version || has(out, el.id)) { return; }
        const otherNode = resolved(caps, wellKnown, other.kind, other.node);
        if (otherNode && canonical.canonicalJSON(meaning(other.kind, otherNode)) !== wanted) {
          out[el.id] = did;
        }
      });
    });
  });
  return out;
}

// ── the capability document (§4) ──────────────────────────────────────

function isMapPath (n) {
  return n === 'spec.extensions' || /\.vocabularies$/.test(n);
}

function interpreted (caps, n) {
  return caps.grammar.interprets.some(function (e) { return n === e || n.indexOf(e + '.') === 0; });
}

function ancestorOfEntry (caps, n) {
  return caps.grammar.interprets.some(function (e) { return e.indexOf(n + '.') === 0; });
}

function uncovered (caps, node, path, n, out) {
  Object.keys(node).forEach(function (key) {
    const value = node[key];
    const p = path ? path + '.' + key : key;
    const m = n ? n + '.' + (isMapPath(n) ? '*' : key) : key;
    if (interpreted(caps, m)) { return; }
    if (!ancestorOfEntry(caps, m)) { out.add(p); return; }
    if (isObject(value)) {
      uncovered(caps, value, p, m, out);
    } else if (Array.isArray(value)) {
      value.forEach(function (item, i) {
        if (isObject(item)) { uncovered(caps, item, p + '.' + i, m + '.*', out); }
      });
    }
  });
}

// Rule G1: members the grammar does not define (over `unknownIn`) and
// members the hub does not interpret; a path under one already listed is not
// listed again.
function ignoredMembers (caps, registration, unknownIn) {
  const found = new Set(grammar.unknownMembers(unknownIn || registration));
  uncovered(caps, registration, '', '', found);
  const all = Array.from(found);
  return all.filter(function (p) {
    return !all.some(function (q) { return q !== p && under(p, q); });
  }).sort();
}

function horizonClasses (caps) {
  return ((caps.horizons || {}).classes) || [];
}

function availability (caps) {
  return ((caps.horizons || {}).availability) || ['released'];
}

function fragmentOf (field) {
  if (has(field, 'type')) { return field.type; }
  return grammar.resolveTypeRef(field.typeRef);
}

function keywordProblems (caps, fragment, path) {
  const tf = caps.typeFragment || {};
  const subset = tf.keywords || ['type'];
  const formats = tf.formats;
  let problems = [];
  Object.keys(fragment).forEach(function (key) {
    if (ANNOTATIONS.indexOf(key) >= 0) { return; }
    if (subset.indexOf(key) < 0) {
      problems.push([path + '.' + key, 'keyword ' + JSON.stringify(key) + ' is outside the hub\'s subset']);
    } else if (key === 'format' && formats !== undefined && formats.indexOf(fragment[key]) < 0) {
      problems.push([path + '.format', 'format ' + JSON.stringify(fragment[key]) + ' is outside the hub\'s subset']);
    }
  });
  if (isObject(fragment.items)) {
    problems = problems.concat(keywordProblems(caps, fragment.items, path + '.items'));
  }
  Object.keys(isObject(fragment.properties) ? fragment.properties : {}).forEach(function (name) {
    const sub = fragment.properties[name];
    if (isObject(sub)) { problems = problems.concat(keywordProblems(caps, sub, path + '.properties.' + name)); }
  });
  return problems;
}

function typeDepth (fragment) {
  if (isObject(fragment.items)) { return 1 + typeDepth(fragment.items); }
  const props = Object.values(isObject(fragment.properties) ? fragment.properties : {}).filter(isObject);
  return 1 + (props.length ? Math.max.apply(null, props.map(typeDepth)) : 0);
}

function fieldChecks (caps, field, path) {
  const fragment = fragmentOf(field);
  if (fragment === undefined) {
    return [reason('invalid-element', path + '.typeRef', 'typeRef does not resolve')];
  }
  const where = path + '.' + (has(field, 'type') ? 'type' : 'typeRef');
  const out = keywordProblems(caps, fragment, where).map(function (p) {
    return reason('unsupported-type-keyword', p[0], p[1]);
  });
  const limit = (caps.limits || {}).maxTypeDepth;
  if (limit !== undefined && typeDepth(fragment) > limit) {
    out.push(reason('limit-exceeded', path, 'type depth ' + typeDepth(fragment) + ' exceeds maxTypeDepth ' + limit));
  }
  return out;
}

function declaredChecks (caps, node, path, ignored) {
  const out = [];
  function live (member) {
    return has(node, member) && !ignored.some(function (q) { return under(path + '.' + member, q); });
  }
  if (live('availability') && availability(caps).indexOf(node.availability) < 0) {
    out.push(reason('unsupported-availability', path + '.availability',
      'availability ' + JSON.stringify(node.availability) + ' is not supported'));
  }
  if (live('horizon') && isObject(node.horizon) && horizonClasses(caps).indexOf(node.horizon.class) < 0) {
    out.push(reason('unsupported-horizon', path + '.horizon',
      'horizon class ' + JSON.stringify(node.horizon.class) + ' is not supported'));
  }
  return out;
}

function hasCarrierMapping (caps, wellKnown, kind, node) {
  if (kind === 'stateSpans') {
    const r = resolved(caps, wellKnown, kind, node);
    return Boolean(r && r.wire);
  }
  if (kind === 'extensions') { return Boolean(node.carrier); }
  return false;
}

function referenceChecks (caps, wellKnown, node, path) {
  const target = resolveReference(caps, wellKnown, node);
  if (!target) {
    return [reason('unknown-well-known-kind', path + '.wellKnownRef', 'the hub\'s catalogue has no such kind at that version')];
  }
  const extra = Object.keys(node).filter(function (k) { return REFERENCE_MEMBERS.indexOf(k) < 0; }).sort();
  if (extra.length) {
    return [reason('invalid-element', path + '.' + extra[0], 'a reference does not restate the referenced kind')];
  }
  const kindOf = has(node, 'kind') ? node.kind : target.kind;
  if (node.category !== target.category || kindOf !== target.kind) {
    return [reason('invalid-element', path, 'category and kind must be the referenced kind\'s')];
  }
  return [];
}

function sharedSlots (caps) {
  return (((caps || {}).wellKnown || {}).slots || []).filter(function (s) { return isObject(s) && s.name; })
    .map(function (s) { return s.name; });
}

function sameAsChecks (caps, registration, node, path) {
  const sameAs = node.sameAs;
  const slot = node.slot;
  if (typeof slot !== 'string' || !slot || slot.indexOf('/') >= 0) {
    return [reason('invalid-element', path + '.sameAs', 'sameAs names the shared slot that this entry\'s slot means')];
  }
  const listed = sharedSlots(caps);
  if (listed.indexOf(slot) >= 0 && slot !== sameAs) {
    return [reason('invalid-element', path + '.sameAs', 'a slot whose own name is a shared slot means only itself')];
  }
  const others = (((registration.spec || {}).stateSpans) || []);
  for (const other of others) {
    if (other !== node && other.slot === slot && other.sameAs !== sameAs) {
      return [reason('invalid-element', path + '.sameAs', 'entries naming one slot must agree on its sameAs')];
    }
  }
  if (listed.indexOf(sameAs) < 0) {
    return [reason('unknown-shared-slot', path + '.sameAs', 'the hub\'s shared slot list has no such slot')];
  }
  return [];
}

// Rule G4: a declared version plan is well formed.
function versionPlanError (entry) {
  if (!has(entry, 'versions')) { return null; }
  const versions = entry.versions;
  if (!isObject(versions) || !has(versions, 'stored') || !Array.isArray(versions.served)) {
    return 'versions needs served and stored';
  }
  if (versions.served.indexOf(versions.stored) < 0) {
    return 'stored version ' + JSON.stringify(versions.stored) + ' is not served';
  }
  const mappings = versions.mappings === undefined || versions.mappings === null ? [] : versions.mappings;
  if (!Array.isArray(mappings)) { return 'mappings is not a list'; }
  for (const m of mappings) {
    if (isObject(m) && m.lossless === true && (!has(m, 'from') || !has(m, 'to'))) {
      return 'a mapping needs from and to';
    }
  }
  return null;
}

function owns (roots, namespace) {
  return roots.some(function (r) { return r === '*' || namespace === r || namespace.indexOf(r + '.') === 0; });
}

// The per-element results and the registration-level ignored members.
function evaluate (caps, hub, submitter, registration, views, wellKnown) {
  const conflicts = versionConflicts(caps, hub, wellKnown, registration);
  const roots = submitter.namespaceRoots;
  const limits = caps.limits || {};

  const pre = {};
  elements(registration).forEach(function (el) {
    let reasons = [];
    const node = el.node;
    if (el.kind === 'extensions') {
      const ns = el.id.slice('extensions/'.length);
      if (Array.isArray(roots) && !owns(roots, ns)) {
        reasons.push(reason('namespace-not-owned', el.path, 'the submitting credential holds no root covering this namespace'));
      }
      const holder = hub.claimedElsewhere(ns);
      if (holder) {
        reasons.push(reason('namespace-claimed', el.path, 'claimed on this tenant by ' + holder));
      }
      const fields = isObject(node) && Array.isArray(node.fields) ? node.fields : [];
      fields.forEach(function (field, j) {
        if (!typed(field)) {
          reasons.push(reason('untyped-extension', el.path + '.fields.' + j, 'an extension field without type or typeRef'));
        }
      });
      fields.forEach(function (field, j) {
        if (typed(field)) { reasons = reasons.concat(fieldChecks(caps, field, el.path + '.fields.' + j)); }
      });
      if (limits.maxFieldsPerExtension !== undefined && fields.length > limits.maxFieldsPerExtension) {
        reasons.push(reason('limit-exceeded', el.path + '.fields',
          fields.length + ' fields exceed maxFieldsPerExtension ' + limits.maxFieldsPerExtension));
      }
      if (!reasons.length) {
        const error = grammar.namespaceError(ns) || grammar.extensionError(node);
        if (error) { reasons.push(reason('invalid-element', el.path, error.message)); }
      }
    } else if (el.kind === 'settings' || el.kind === 'replayInputs') {
      reasons = reasons.concat(fieldChecks(caps, node, el.path));
    } else if (el.kind === 'stateSpans' && has(node, 'wellKnownRef')) {
      reasons = reasons.concat(referenceChecks(caps, wellKnown, node, el.path));
    } else if (el.kind === 'stateSpans' && has(node, 'sameAs')) {
      reasons = reasons.concat(sameAsChecks(caps, registration, node, el.path));
    }
    if (!reasons.length && (el.kind === 'stateSpans' || el.kind === 'extensions')) {
      const planError = versionPlanError(node);
      if (planError) { reasons.push(reason('version-plan-invalid', el.path, planError)); }
    }
    if (!reasons.length && has(conflicts, el.id)) {
      reasons.push(reason('version-conflict', el.path, 'typed differently at this version by ' + conflicts[el.id]));
    }
    pre[el.id] = reasons;
  });

  // Unknown members are found with the extensions that failed above removed,
  // so an invalid extension does not report its own members as unknown.
  const clean = JSON.parse(JSON.stringify(registration));
  Object.keys(pre).forEach(function (eid) {
    if (pre[eid].length && eid.indexOf('extensions/') === 0) {
      delete clean.spec.extensions[eid.slice('extensions/'.length)];
    }
  });
  const ignored = ignoredMembers(caps, registration, clean);

  const results = [];
  const prefixes = [];
  elements(registration).forEach(function (el) {
    prefixes.push(el.path);
    const notInterpreted = Array.from(new Set(ignored.filter(function (q) {
      return el.defining.some(function (d) { return under(d, q); });
    }))).sort();
    if (notInterpreted.length) {
      results.push({ element: el.id, result: 'rejected', reasons: notInterpreted.map(function (q) {
        return reason('not-interpreted', q, 'the hub does not interpret this member');
      }) });
      return;
    }
    let reasons = pre[el.id];
    if (!reasons.length) {
      reasons = declaredChecks(caps, el.node, el.path, ignored);
      if (el.kind === 'extensions') {
        (Array.isArray(el.node.fields) ? el.node.fields : []).forEach(function (field, j) {
          if (isObject(field)) { reasons = reasons.concat(declaredChecks(caps, field, el.path + '.fields.' + j, ignored)); }
        });
      }
    }
    if (reasons.length) {
      results.push({ element: el.id, result: 'rejected', reasons: reasons });
      return;
    }
    const inside = ignored.filter(function (q) { return q.indexOf(el.path + '.') === 0; });
    const result = inside.length
      ? { element: el.id, result: 'accepted-with-ignored-members', ignored: inside }
      : { element: el.id, result: 'accepted' };
    if (views && has(views, el.id)) {
      let view = views[el.id];
      if (view === 'served' && !hasCarrierMapping(caps, wellKnown, el.kind, el.node)) { view = 'not-served'; }
      result.carrierView = view;
    }
    results.push(result);
  });
  const top = ignored.filter(function (q) {
    return !prefixes.some(function (p) { return q.indexOf(p + '.') === 0; });
  });
  return { ignored: top, elements: results };
}

// ── the request (§5.2) ────────────────────────────────────────────────

function bindingOf (submitter) {
  if (submitter.credentialKind === 'api-secret') { return { kind: 'api-secret' }; }
  return { kind: submitter.credentialKind, subject: submitter.subject };
}

function boundTo (stored, submitter) {
  const bound = stored.boundTo;
  return bound === null || bound === undefined || same(bound, bindingOf(submitter));
}

function response (status, outcome, members) {
  const out = { apiVersion: API_VERSION, kind: 'RegistrationResponse', status: status, outcome: outcome };
  Object.keys(members || {}).forEach(function (k) {
    if (members[k] !== undefined && members[k] !== null) { out[k] = members[k]; }
  });
  return out;
}

function summary (stored) {
  const out = { vendor: stored.identity.vendor, product: stored.identity.product };
  const meta = ((stored.registration || {}).metadata) || {};
  if (has(meta, 'versionRange')) { out.versionRange = meta.versionRange; }
  out.state = stored.state;
  out.etag = stored.etag;
  ['blockedFrom', 'boundTo', 'credentialKind', 'bindingEvent'].forEach(function (k) {
    if (has(stored, k)) { out[k] = stored[k]; }
  });
  if (stored.freedNamespaces && stored.freedNamespaces.length) { out.freedNamespaces = stored.freedNamespaces; }
  return out;
}

function current (stored) {
  return { state: stored.state, etag: stored.etag };
}

function registered (stored) {
  return stored !== null && stored !== undefined && stored.registration !== null && stored.registration !== undefined;
}

// A stored registration, members in a fixed order; the etag covers the
// binding, and not the credential kind, the binding event or freed namespaces.
function storedRecord (identity, registration, state, members) {
  members = members || {};
  const bound = registration !== null ? (members.boundTo === undefined ? null : members.boundTo) : null;
  const out = { identity: { vendor: identity.vendor, product: identity.product }, state: state,
    etag: canonical.etag(registration, state, bound) };
  if (state === 'blocked' && members.blockedFrom !== undefined && members.blockedFrom !== null) {
    out.blockedFrom = members.blockedFrom;
  }
  if (registration !== null) {
    out.boundTo = bound;
    out.credentialKind = members.credentialKind === undefined ? null : members.credentialKind;
    if (members.bindingEvent !== undefined && members.bindingEvent !== null && bound !== null) {
      out.bindingEvent = members.bindingEvent;
    }
  }
  if (members.freedNamespaces && members.freedNamespaces.length) {
    out.freedNamespaces = members.freedNamespaces.slice();
  }
  out.registration = registration;
  return out;
}

function restate (stored, state, changes) {
  const members = pick(stored, ['boundTo', 'credentialKind', 'blockedFrom', 'freedNamespaces', 'bindingEvent']);
  Object.keys(changes || {}).forEach(function (k) { members[k] = changes[k]; });
  return storedRecord(stored.identity, stored.registration, state || stored.state, members);
}

function rejecter (stored) {
  return {
    reject: function (status, code, path, detail) {
      return { response: response(status, 'rejected', { reasons: [reason(code, path, detail)] }), after: stored };
    },
    failed: function (status, code, detail) {
      return { response: response(status, 'precondition-failed', {
        reasons: [reason(code, null, detail)], current: stored ? current(stored) : null
      }), after: stored };
    }
  };
}

function accepted (caps, hub, submitter, registration, after, status, noop, views, wellKnown) {
  const ev = evaluate(caps, hub, submitter, registration, views, wellKnown);
  const outcome = ev.elements.some(function (r) { return r.result === 'rejected'; }) ? 'partial' : 'accepted';
  return {
    response: response(status, outcome, {
      noop: noop, definitionId: canonical.definitionId(registration), registration: summary(after),
      ignored: ev.ignored, elements: ev.elements
    }),
    after: after
  };
}

// Step 3: the registration as a whole. Null when it passes.
function contentRefusal (caps, registration, identity, reject) {
  const api = (registration || {}).apiVersion;
  const versions = caps.grammar.versions.map(function (v) { return v.apiVersion; });
  if (versions.indexOf(api) < 0) {
    return reject(422, 'unsupported-grammar-major', 'apiVersion', JSON.stringify(api) + ' is not among the hub\'s grammar versions');
  }
  if (registration.kind !== 'ControllerStateModel') {
    return reject(422, 'invalid-registration', 'kind');
  }
  const meta = isObject(registration.metadata) ? registration.metadata : {};
  if (meta.vendor !== identity.vendor || meta.product !== identity.product) {
    return reject(422, 'identity-mismatch', 'metadata', 'metadata.vendor/product differ from the resource identity');
  }
  if (meta.tier !== 'controller-owned') {
    return reject(422, 'wrong-tier', 'metadata.tier', 'only a controller-owned registration may be submitted');
  }
  const limits = caps.limits || {};
  const size = canonical.byteLength(registration);
  if (limits.maxRegistrationBytes !== undefined && size > limits.maxRegistrationBytes) {
    return reject(413, 'limit-exceeded', null, size + ' bytes exceed maxRegistrationBytes ' + limits.maxRegistrationBytes);
  }
  const count = declaredNamespaces(registration).length;
  if (limits.maxExtensions !== undefined && count > limits.maxExtensions) {
    return reject(422, 'limit-exceeded', 'spec.extensions', count + ' extensions exceed maxExtensions ' + limits.maxExtensions);
  }
  const core = JSON.parse(JSON.stringify(registration));
  if (isObject(core.spec)) { delete core.spec.extensions; }
  const error = grammar.grammarError(core);
  if (error) {
    return reject(422, 'invalid-registration', error.path || null, error.message);
  }
  const ids = elements(registration).map(function (el) { return el.id; });
  if (new Set(ids).size !== ids.length) {
    return reject(422, 'invalid-registration', 'spec', 'two elements share an id (stateSpans kind, setting or input name)');
  }
  return null;
}

function retire (stored) {
  if (stored.state === 'retired') {
    return { response: response(200, 'retired', { noop: true, registration: summary(stored), elements: [] }), after: stored };
  }
  const after = restate(stored, 'retired');
  return { response: response(200, 'retired', { noop: false, registration: summary(after), elements: [] }), after: after };
}

// A controller's request: submit (PUT) or retire (DELETE). `hub` is the view
// of stored state: { stored, claimedElsewhere(ns), productDefinitions() }.
// `submitter`: { credentialKind, subject, permitted(permission), namespaceRoots }.
// `request`: { action, identity, preconditions: { ifMatch | ifNoneMatch } }.
function controller (caps, hub, submitter, registration, request, views, wellKnown) {
  const action = request.action;
  const pre = request.preconditions || {};
  const stored = hub.stored;
  const r = rejecter(stored);
  const isRegistered = registered(stored);
  const identity = request.identity;

  // 1. Authorisation: the permission, then the binding.
  if (CONTROLLER_ACTIONS.indexOf(action) < 0) {
    return r.reject(403, 'not-authorised', null, 'only the owner may ' + action);
  }
  if (!submitter.permitted(PERMISSION[action])) {
    return r.reject(403, 'not-authorised', null, 'needs ' + PERMISSION[action]);
  }
  if (isRegistered && !boundTo(stored, submitter)) {
    return r.reject(403, 'not-registration-owner', null, 'the registration is bound to another credential');
  }

  // 2. Preconditions.
  if (!has(pre, 'ifMatch') && !has(pre, 'ifNoneMatch')) {
    return r.failed(428, 'precondition-required', 'send If-None-Match: * or If-Match');
  }
  if (action === 'retire') {
    if (!isRegistered) {
      return { response: response(404, 'not-found', { reasons: [reason('not-found')] }), after: stored };
    }
    if (!has(pre, 'ifMatch')) { return r.failed(412, 'registration-exists', 'retire needs If-Match'); }
    if (pre.ifMatch !== stored.etag) { return r.failed(412, 'stale-etag'); }
    if (stored.state === 'blocked') { return r.reject(403, 'blocked-by-owner'); }
    return retire(stored);
  }

  const unchanged = isRegistered && stored.state === 'active' && same(stored.registration, registration);
  if (has(pre, 'ifNoneMatch') && isRegistered && !unchanged) {
    return r.failed(412, 'registration-exists');
  }
  if (has(pre, 'ifMatch')) {
    if (!isRegistered) { return r.failed(412, 'not-found'); }
    if (pre.ifMatch !== stored.etag && !unchanged) { return r.failed(412, 'stale-etag'); }
  }
  // The owner's block, after the preconditions.
  if (stored && stored.state === 'blocked') {
    return r.reject(403, 'blocked-by-owner');
  }

  // 3. The registration as a whole.
  const refusal = contentRefusal(caps, registration, identity, r.reject);
  if (refusal) { return refusal; }

  // 4. Elements. A write binds an unbound registration to the writer.
  if (unchanged && stored.boundTo !== null && stored.boundTo !== undefined) {
    return accepted(caps, hub, submitter, registration, stored, 200, true, views, wellKnown);
  }
  const declared = declaredNamespaces(registration);
  const freed = ((stored || {}).freedNamespaces || []).filter(function (ns) {
    return declared.indexOf(ns) >= 0 && hub.claimedElsewhere(ns);
  });
  let event = null;
  if (isRegistered && (stored.boundTo === null || stored.boundTo === undefined)) {
    event = 'next-writer';
  } else if (isRegistered) {
    event = stored.bindingEvent || null;
  }
  const after = storedRecord(identity, registration, 'active', {
    boundTo: bindingOf(submitter), credentialKind: submitter.credentialKind, freedNamespaces: freed, bindingEvent: event
  });
  return accepted(caps, hub, submitter, registration, after, isRegistered ? 200 : 201, false, views, wellKnown);
}

// GET: the stored registration with its element results under the current
// capabilities (§5.4).
function read (caps, hub, submitter, wellKnown) {
  const stored = hub.stored;
  if (!registered(stored)) {
    return { response: response(404, 'not-found', { reasons: [reason('not-found')] }), after: stored };
  }
  const ev = evaluate(caps, hub, submitter, stored.registration, null, wellKnown);
  const outcome = stored.state === 'retired' ? 'retired'
    : (ev.elements.some(function (e) { return e.result === 'rejected'; }) ? 'partial' : 'accepted');
  return {
    response: response(200, outcome, {
      definitionId: canonical.definitionId(stored.registration), registration: summary(stored),
      ignored: ev.ignored, elements: ev.elements
    }),
    after: stored
  };
}

module.exports = {
  PERMISSION,
  elements,
  declaredNamespaces,
  meaning,
  storedVersion,
  versionConflicts,
  evaluate,
  contentRefusal,
  controller,
  read,
  storedRecord,
  restate,
  summary,
  response,
  reason,
  rejecter,
  registered,
  bindingOf,
  sharedSlots,
  resolveReference,
  hasCarrierMapping,
  same
};
