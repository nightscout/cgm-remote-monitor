'use strict';

// Immutable process assignment. Registry admission supplies the canonical UUID;
// aliases and client headers never select an ordinal. K changes by restarting
// the processes with the new count (a StatefulSet rolling update). There is no
// publication, membership timer or owner move.
const slice = require('../pool-membership/slice');
const c = require('../server/realtime/contract');
const listener = require('../server/internal-api/listener-config');
const legacy = ['MULTITENANT_REALTIME_PLACEMENT', 'MULTITENANT_REALTIME_ROUTES',
  'REALTIME_WORKER_ID', 'REALTIME_WORKER_INCARNATION', 'NS_REALTIME_OWNERSHIP_CONTRACT'];
const fail = () => c.fail('REALTIME_STATIC_OWNERSHIP_REFUSED');
function refuseLegacy(source) { if (legacy.some(key => Object.hasOwn(source, key))) fail(); }
function parse(value) {
  if (!c.exact(value, ['count', 'ordinal'])) fail();
  // An ordinal at or above the count is a process no tenant hashes to: it owns nothing.
  if (!Number.isSafeInteger(value.ordinal) || value.ordinal < 0 || value.ordinal >= slice.MAX_MEMBERS) fail();
  try { slice.shape(value.count, 0); } catch { fail(); }
  return Object.freeze({count: value.count, ordinal: value.ordinal});
}
function json(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 131072) fail();
  try { return JSON.parse(text); } catch { fail(); }
}
function create(value) {
  const shape = parse(value), identity = c.identity([slice.RULE, shape]);
  return Object.freeze({ ...shape, rule: slice.RULE, identity,
    owns: tenant => slice.bucket(tenant, shape.count) === shape.ordinal,
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
  let shape; try { shape = slice.fromEnvironment(source); } catch { fail(); }
  if (shape.ordinal >= shape.count) console.warn('realtime slice ordinal', shape.ordinal, 'is not below count', shape.count, '- this process owns no tenants');
  return create({...shape});
}
function peers(source, internal = listener.observer(source), bounds) {
  refuseLegacy(source);
  if (source.NS_REALTIME_SLICE_PEERS === undefined) return null;
  const addresses = json(source.NS_REALTIME_SLICE_PEERS);
  if (!Array.isArray(addresses) || !addresses.length || addresses.length > slice.MAX_MEMBERS) fail();
  const endpoints = addresses.map(address => internal.instance(['realtime'], address, bounds));
  if (new Set(endpoints.map(listener.key)).size !== endpoints.length) fail();
  const frozen = Object.freeze(endpoints);
  const clients = new Map();
  function outputClient (endpoint) {
    if (!clients.has(endpoint)) clients.set(endpoint, require('../server/internal-api/clients').completedOutput(endpoint));
    return clients.get(endpoint);
  }
  return Object.freeze({count: frozen.length, endpoints: frozen,
    close () { for (const client of clients.values()) client.close?.(); clients.clear(); },
    route(tenant) { const ordinal = slice.bucket(tenant, frozen.length); return {count: frozen.length, ordinal, endpoint: frozen[ordinal]}; },
    // One bounded wake may span slices. All groups are attempted even if a peer
    // is absent; failed hints remain recoverable by the durable 30 s scan.
    async hint(body, clientFor = outputClient) {
      if (!c.exact(body, ['tenants']) || !Array.isArray(body.tenants) || body.tenants.length > 64 || new Set(body.tenants).size !== body.tenants.length) fail();
      const groups = new Map();
      for (const tenant of body.tenants) { const ordinal = slice.bucket(tenant, frozen.length); if (!groups.has(ordinal)) groups.set(ordinal, []); groups.get(ordinal).push(tenant); }
      const results = await Promise.allSettled([...groups].map(([ordinal, tenants]) => Promise.resolve().then(() => clientFor(frozen[ordinal]).hintCompletedOutput({tenants}))));
      if (results.some(row => row.status === 'rejected')) c.fail('REALTIME_OUTPUT_HINT_UNAVAILABLE');
    }
  });
}
module.exports = {parse, create, load, peers, refuseLegacy};
