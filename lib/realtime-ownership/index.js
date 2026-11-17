'use strict';

// Immutable process assignment. Registry admission supplies the canonical UUID;
// aliases and client headers never select an ordinal. Changing K requires every
// old process to stop. There is no publication, membership timer or owner move.
const slice = require('../pool-membership/slice');
const c = require('../server/realtime/contract');
const listener = require('../server/internal-api/listener-config');
const legacy = ['MULTITENANT_REALTIME_PLACEMENT', 'MULTITENANT_REALTIME_ROUTES',
  'REALTIME_WORKER_ID', 'REALTIME_WORKER_INCARNATION', 'NS_REALTIME_OWNERSHIP_CONTRACT'];
const fail = () => c.fail('REALTIME_STATIC_OWNERSHIP_REFUSED');
function refuseLegacy(source) { if (legacy.some(key => Object.hasOwn(source, key))) fail(); }
function parse(value) {
  if (!c.exact(value, ['count', 'ordinal'])) fail();
  try { slice.shape(value.count, value.ordinal); } catch { fail(); }
  return Object.freeze({count: value.count, ordinal: value.ordinal});
}
function json(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 131072) fail();
  try { return JSON.parse(text); } catch { fail(); }
}
function create(value) {
  const shape = parse(value), identity = c.identity([slice.RULE, shape]);
  return Object.freeze({ ...shape, rule: slice.RULE, identity,
    owns: slice.predicate(shape.count, shape.ordinal),
    assert(tenant, expected) {
      if (slice.bucket(tenant, shape.count) !== shape.ordinal || expected &&
          (!c.exact(expected, ['count', 'ordinal']) || expected.count !== shape.count || expected.ordinal !== shape.ordinal)) c.fail('REALTIME_WRONG_OWNER');
    },
    cached() { return {...shape, rule: slice.RULE}; },
    inspect() { return {...shape, rule: slice.RULE}; }
  });
}
function load(source = process.env) {
  refuseLegacy(source);
  return create(source.NS_REALTIME_SLICE === undefined ? {count: 1, ordinal: 0} : json(source.NS_REALTIME_SLICE));
}
function peers(source, internal = listener.observer(source), bounds) {
  refuseLegacy(source);
  if (source.NS_REALTIME_SLICE_PEERS === undefined) return null;
  const addresses = json(source.NS_REALTIME_SLICE_PEERS);
  if (!Array.isArray(addresses) || !addresses.length || addresses.length > slice.MAX_MEMBERS) fail();
  const endpoints = addresses.map(address => internal.instance(['realtime'], address, bounds));
  if (new Set(endpoints.map(listener.key)).size !== endpoints.length) fail();
  const frozen = Object.freeze(endpoints);
  return Object.freeze({count: frozen.length, endpoints: frozen,
    route(tenant) { const ordinal = slice.bucket(tenant, frozen.length); return {count: frozen.length, ordinal, endpoint: frozen[ordinal]}; },
    // One bounded wake may span slices. All groups are attempted even if a peer
    // is absent; failed hints remain recoverable by the durable 30 s scan.
    async hint(body, clientFor = require('../server/internal-api/clients').completedOutput) {
      if (!c.exact(body, ['tenants']) || !Array.isArray(body.tenants) || body.tenants.length > 64 || new Set(body.tenants).size !== body.tenants.length) fail();
      const groups = new Map();
      for (const tenant of body.tenants) { const ordinal = slice.bucket(tenant, frozen.length); if (!groups.has(ordinal)) groups.set(ordinal, []); groups.get(ordinal).push(tenant); }
      const results = await Promise.allSettled([...groups].map(([ordinal, tenants]) => Promise.resolve().then(() => clientFor(frozen[ordinal]).hintCompletedOutput({tenants}))));
      if (results.some(row => row.status === 'rejected')) c.fail('REALTIME_OUTPUT_HINT_UNAVAILABLE');
    }
  });
}
// Exact configured census, including an idle ordinal. Endpoint and process
// incarnation checks are still supplied by the existing participant protocol.
function census(participants) {
  const rows = participants.filter(row => row.roles.includes('realtime'));
  if (!rows.length) fail();
  const shapes = rows.map(row => parse(row.slice));
  const count = shapes[0].count;
  if (rows.length !== count || shapes.some(row => row.count !== count) || new Set(shapes.map(row => row.ordinal)).size !== count) fail();
  return Object.freeze({count, rule: slice.RULE});
}
module.exports = {parse, create, load, peers, census, refuseLegacy};
