'use strict';

// Internal hint contracts, version 1 (spike S3, writer-driven transport).
//
// A hint tells the role process that owns a tenant that the tenant may have
// changed. It is never the guarantee: correctness comes from the pending mark
// written in the writer's own transaction, the owner's periodic sweep and a
// recompute from current state. A hint may be lost, duplicated, merged or
// reordered, and the receiver never applies its fields as data.
//
//   POST /internal/v1/tenants/{tenant}/changed         -> evaluator[slice(tenant)]
//   POST /internal/v1/tenants/{tenant}/storage-events  -> realtime[slice(tenant)]
//   POST /internal/v1/tenants/{tenant}/output-changed  -> realtime[slice(tenant)]
//
// Conventions, the same for every kind:
// - The major version is in the path. A v1 receiver ignores unknown fields; a
//   new field is additive and optional. A change that a v1 receiver would
//   misread is a new path (/internal/v2/...), served beside v1 until no sender
//   uses v1.
// - Every body field is optional and advisory. A known field with the wrong
//   shape is dropped, which only widens the hint (absent means "anything may
//   have changed"); widening is always safe for a level-triggered receiver.
// - 202 means "accepted for scheduling" and nothing more. The answer carries no
//   body. A sender treats every other outcome as "the sweep will catch it".
// - Hints for one tenant merge (merge()). Merging is commutative and
//   associative, so the order of arrival never matters.
const slice = require('../pool-membership/slice');

const VERSION = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PATH = /^\/internal\/v([1-9][0-9]{0,2})\/tenants\/([^/]{1,64})\/([a-z][a-z-]{0,31})$/;
const DECIMAL = /^(?:0|[1-9][0-9]{0,19})$/;
const NAME = /^[a-z][a-z0-9_-]{0,31}$/;

// Evaluator-read inputs a writer may name. Unknown names are ignored by the
// receiver (a newer sender may name a newer input); absent means all.
const DOMAINS = Object.freeze(['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity',
  'settings', 'operator_policy', 'activity_state', 'lifecycle']);
// /storage operations (lib/api3/storageSocket.js emits create, update, delete
// with {colName, doc}); 'changed' is the collapsed form with no document.
const OPS = Object.freeze(['create', 'update', 'delete', 'changed']);
const MAX_EVENTS = 256;

const KINDS = Object.freeze({
  changed: Object.freeze({ role: 'evaluator', maxBytes: 4096 }),
  'storage-events': Object.freeze({ role: 'realtime', maxBytes: 262144 }),
  'output-changed': Object.freeze({ role: 'realtime', maxBytes: 4096 })
});
const TIMEOUT_MS = 1000;

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const stamp = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const decimal = value => typeof value === 'string' && DECIMAL.test(value) ? value : undefined;
const higher = (a, b) => a === undefined ? b : b === undefined ? a : (BigInt(a) >= BigInt(b) ? a : b);
const later = (a, b) => a === undefined ? b : b === undefined ? a : Math.max(a, b);

function path (kind, tenant) {
  if (!Object.hasOwn(KINDS, kind)) throw new TypeError('Unknown hint kind');
  if (typeof tenant !== 'string' || !UUID.test(tenant)) throw new TypeError('Canonical tenant id required');
  return '/internal/v' + VERSION + '/tenants/' + tenant + '/' + kind;
}

// {version, tenant, kind} from a request path, or null when it is not a hint
// path at all. A hint path of another version or kind is returned as such, so
// the receiver can answer 404 (not served) apart from 400 (malformed).
function route (url) {
  if (typeof url !== 'string') return null;
  const match = PATH.exec(url);
  if (!match) return null;
  return { version: Number(match[1]), tenant: match[2], kind: match[3] };
}

// storage-events rows: {collection, op, doc} where doc is the stored document
// as the api's /storage emit would carry it (opaque to this contract; realtime
// forwards it under its own per-subscriber authorization). A row without a
// usable doc becomes {collection, op: 'changed', collapsed: true}.
function events (value) {
  if (!Array.isArray(value)) return undefined;
  const out = [];
  for (const row of value.slice(0, 4 * MAX_EVENTS)) {
    if (!object(row) || typeof row.collection !== 'string' || !NAME.test(row.collection)) continue;
    if (OPS.includes(row.op) && row.op !== 'changed' && object(row.doc)) out.push({ collection: row.collection, op: row.op, doc: row.doc });
    else out.push({ collection: row.collection, op: 'changed', collapsed: true });
  }
  // More events than the bound: the receiver cannot carry them all, so the
  // hint says "these collections changed" (clients re-sync over REST).
  return out.length > MAX_EVENTS ? collapse(out) : out;
}
function collapse (rows) {
  const names = [...new Set(rows.map(row => row.collection))].sort().slice(0, MAX_EVENTS);
  return names.map(collection => ({ collection, op: 'changed', collapsed: true }));
}
// The hint as it will be sent: a storage-events body over its byte bound
// loses its documents (collapsed per collection) rather than being refused.
function fit (kind, hint) {
  if (kind !== 'storage-events' || !hint.events) return hint;
  if (Buffer.byteLength(JSON.stringify(hint)) <= KINDS[kind].maxBytes) return hint;
  return { ...hint, events: collapse(hint.events) };
}

// The known fields of a body, normalized; unknown fields are dropped.
// Never throws for a body that is a JSON object.
function normalize (kind, body) {
  if (!Object.hasOwn(KINDS, kind)) throw new TypeError('Unknown hint kind');
  const value = object(body) ? body : {};
  const out = {};
  const g = decimal(value.generation);
  if (g !== undefined) out.generation = g;
  if (kind === 'changed') {
    const s = stamp(value.stamp);
    if (s !== undefined) out.stamp = s;
    if (Array.isArray(value.domains) && value.domains.length <= 64) {
      const named = value.domains.filter(name => DOMAINS.includes(name));
      // Every name unknown to this receiver: it cannot narrow, so it widens.
      if (named.length && named.length === value.domains.length) out.domains = [...new Set(named)].sort();
    }
    if (typeof value.source === 'string' && NAME.test(value.source)) out.source = value.source;
  } else if (kind === 'storage-events') {
    const s = stamp(value.stamp);
    if (s !== undefined) out.stamp = s;
    const e = events(value.events);
    if (e !== undefined) out.events = e;
  } else {
    const r = decimal(value.revision);
    if (r !== undefined) out.revision = r;
  }
  return out;
}

// Merge two normalized hints for one tenant and kind. Widening wins: a hint
// without domains (all) absorbs one with domains. Commutative and associative.
function merge (kind, a, b) {
  if (!a) return b; if (!b) return a;
  const out = {};
  const g = higher(a.generation, b.generation);
  if (g !== undefined) out.generation = g;
  if (kind === 'changed') {
    const s = later(a.stamp, b.stamp);
    if (s !== undefined) out.stamp = s;
    if (a.domains && b.domains) out.domains = [...new Set([...a.domains, ...b.domains])].sort();
    if (a.source && a.source === b.source) out.source = a.source;
  } else if (kind === 'storage-events') {
    const s = later(a.stamp, b.stamp);
    if (s !== undefined) out.stamp = s;
    if (a.events && b.events) {
      const joined = a.events.concat(b.events);
      out.events = joined.length > MAX_EVENTS ? collapse(joined) : joined;
    }
  } else {
    const r = higher(a.revision, b.revision);
    if (r !== undefined) out.revision = r;
  }
  return out;
}

// The owning ordinal: exactly slice.js sha256-modulo-v1.
function owner (tenant, count) { return slice.bucket(tenant, count); }

module.exports = { VERSION, RULE: slice.RULE, KINDS, DOMAINS, OPS, MAX_EVENTS, TIMEOUT_MS, UUID, path, route, normalize, merge, fit, owner };
