'use strict';

// Fixed-roster placement is trusted deployment configuration. A stopped record
// is a platform assertion, never proof obtained from a route, lease or timeout.
// The deployment must stop/fence the named old process before publication.
const { createHash } = require('node:crypto');
const c = require('../server/realtime/contract');
const ipc = require('../server/internal-api/listener-config');
const RULE = 'sha256-u32be-v1';
const NAME = /^[a-z][a-z0-9_-]{0,62}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
function incarnation (row) {
  return c.exact(row, ['worker', 'incarnation']) && typeof row.worker === 'string' && NAME.test(row.worker) && c.uuid(row.incarnation);
}
function sameOwner (a, b) { return a === null && b === null || a && b && a.worker === b.worker && a.incarnation === b.incarnation; }
function parse (value, { internal, self, maxBytes = 1048576, timeoutMs = 5000 } = {}) {
  if (!c.exact(value, ['version', 'rule', 'shardCount', 'generation', 'workers', 'owners'], ['transition']) ||
      value.version !== 1 || value.rule !== RULE || !c.integer(value.shardCount, 65536) || !c.integer(value.generation) ||
      !Array.isArray(value.workers) || !value.workers.length || value.workers.length > 1024 ||
      !Array.isArray(value.owners) || value.owners.length !== value.shardCount || !internal) fail('REALTIME_PLACEMENT_REFUSED');
  if (self && !incarnation(self)) fail('REALTIME_PLACEMENT_SELF_REFUSED');
  const workers = new Map(), endpoints = new Set(), origins = new Set();
  for (const row of value.workers) {
    if (!c.exact(row, ['id', 'incarnation', 'address', 'consumerOrigin']) || (typeof row.id !== 'string' || !NAME.test(row.id)) || !c.uuid(row.incarnation) || workers.has(row.id)) fail('REALTIME_PLACEMENT_REFUSED');
    const endpoint = internal.instance(['realtime'], row.address, { maxBytes, timeoutMs }, { self: self?.worker === row.id });
    let origin;
    try { if (typeof row.consumerOrigin !== 'string') throw new Error(); origin = new URL(row.consumerOrigin); } catch { fail('REALTIME_PLACEMENT_REFUSED'); }
    if (!['http:', 'https:'].includes(origin.protocol) || !origin.hostname || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) fail('REALTIME_PLACEMENT_REFUSED');
    const key = ipc.key(endpoint);
    if (endpoints.has(key) || origins.has(origin.origin)) fail('REALTIME_PLACEMENT_REFUSED');
    endpoints.add(key); origins.add(origin.origin);
    workers.set(row.id, Object.freeze({ id: row.id, incarnation: row.incarnation, endpoint, consumerOrigin: origin.origin }));
  }
  if (self && workers.get(self.worker)?.incarnation !== self.incarnation) fail('REALTIME_PLACEMENT_SELF_REFUSED');
  const owners = value.owners.map(id => {
    if (id === null) return null;
    const worker = workers.get(id);
    if (!worker) fail('REALTIME_PLACEMENT_REFUSED');
    return Object.freeze({ worker: id, incarnation: worker.incarnation });
  });
  let previous = null, stoppedOwners = Object.freeze([]);
  if (value.generation === 1) {
    if (value.transition !== undefined) fail('REALTIME_PLACEMENT_TRANSITION_REFUSED');
  } else {
    const t = value.transition;
    if (!c.exact(t, ['previousGeneration', 'previousOwners', 'stopped']) || t.previousGeneration !== value.generation - 1 ||
        !Array.isArray(t.previousOwners) || t.previousOwners.length !== value.shardCount || t.previousOwners.some(row => row !== null && !incarnation(row)) ||
        !Array.isArray(t.stopped) || t.stopped.length > 1024 || t.stopped.some(row => !incarnation(row))) fail('REALTIME_PLACEMENT_TRANSITION_REFUSED');
    const stopped = new Set(t.stopped.map(row => row.worker + '/' + row.incarnation));
    if (stopped.size !== t.stopped.length) fail('REALTIME_PLACEMENT_TRANSITION_REFUSED');
    for (const worker of workers.values()) if (stopped.has(worker.id + '/' + worker.incarnation)) fail('REALTIME_PLACEMENT_STOPPED_OWNER');
    for (let shard = 0; shard < owners.length; shard++) {
      const before = t.previousOwners[shard], after = owners[shard];
      if (before && !sameOwner(before, after) && !stopped.has(before.worker + '/' + before.incarnation)) fail('REALTIME_PLACEMENT_OLD_OWNER_UNCONFIRMED');
      if (after && stopped.has(after.worker + '/' + after.incarnation)) fail('REALTIME_PLACEMENT_STOPPED_OWNER');
    }
    stoppedOwners = Object.freeze(t.stopped.map(row => Object.freeze({ ...row })));
    previous = Object.freeze(t.previousOwners.map(row => row && Object.freeze({ ...row })));
  }
  const digest = c.identity(value);
  return Object.freeze({ rule: RULE, shardCount: value.shardCount, generation: value.generation, digest,
    workers, owners: Object.freeze(owners), previous, stopped: stoppedOwners });
}
function shard (tenant, count) {
  if (!c.uuid(tenant) || tenant === '00000000-0000-0000-0000-000000000000' || !c.integer(count, 65536)) fail('REALTIME_PLACEMENT_TENANT_REFUSED');
  return createHash('sha256').update(tenant, 'ascii').digest().readUInt32BE(0) % count;
}
function create ({ read, self, continuous = false }) {
  if (typeof read !== 'function' || self && !incarnation(self)) throw new TypeError('Placement reader and actual self incarnation required');
  let admitted;
  function current () {
    const next = read();
    if (admitted && next !== admitted) {
      if (next.rule !== admitted.rule || next.shardCount !== admitted.shardCount || next.generation < admitted.generation ||
          next.generation === admitted.generation && next.digest !== admitted.digest) fail('REALTIME_PLACEMENT_REVISION_REFUSED');
      if (next.generation > admitted.generation && (continuous || next.generation === admitted.generation + 1)) {
        if (next.generation !== admitted.generation + 1 || next.previous.some((row, index) => !sameOwner(row, admitted.owners[index]))) fail('REALTIME_PLACEMENT_REVISION_REFUSED');
        for (const worker of admitted.workers.values()) {
          if (next.workers.get(worker.id)?.incarnation !== worker.incarnation && !next.stopped.some(row => row.worker === worker.id && row.incarnation === worker.incarnation)) fail('REALTIME_PLACEMENT_OLD_OWNER_UNCONFIRMED');
        }
      }
      // Readers may miss intermediate trusted publications; they still reject
      // rollback, same-generation mutation, repartition and wrong self. Only
      // the fenced publisher must prove the complete consecutive transition.
    }
    admitted = next; return next;
  }
  function route (tenant) {
    const map = current(), logicalShard = shard(tenant, map.shardCount), owner = map.owners[logicalShard];
    if (!owner) fail('REALTIME_PLACEMENT_UNAVAILABLE');
    const worker = map.workers.get(owner.worker);
    return Object.freeze({ generation: map.generation, shard: logicalShard, worker: owner.worker, incarnation: owner.incarnation,
      endpoint: worker.endpoint, consumerOrigin: worker.consumerOrigin });
  }
  return Object.freeze({ current, route,
    inspect () {
      try { const map = current(); return { generation: map.generation, rule: map.rule, shardCount: map.shardCount, worker: self?.worker || null, incarnation: self?.incarnation || null, configured: true, reason: null }; }
      catch (error) { return { generation: admitted?.generation || null, worker: self?.worker || null, incarnation: self?.incarnation || null, configured: false, reason: error.code || 'REALTIME_PLACEMENT_UNAVAILABLE' }; }
    }, self: self && Object.freeze({ ...self }),
    owns (tenant) { const map = current(), owner = map.owners[shard(tenant, map.shardCount)]; return !!self && !!owner && owner.worker === self.worker && owner.incarnation === self.incarnation; },
    assert (tenant, expected) {
      const owner = route(tenant);
      if (!self || owner.worker !== self.worker || owner.incarnation !== self.incarnation || expected &&
          (owner.generation !== expected.generation || owner.worker !== expected.worker || owner.incarnation !== expected.incarnation || owner.shard !== expected.shard)) fail('REALTIME_PLACEMENT_WRONG_OWNER');
      return owner;
    } });
}
function load (source = process.env, { internal, self = false, maxBytes, timeoutMs } = {}) {
  const file = source.MULTITENANT_REALTIME_PLACEMENT;
  if (file === undefined) {
    if (source.REALTIME_WORKER_ID !== undefined || source.REALTIME_WORKER_INCARNATION !== undefined) fail('REALTIME_PLACEMENT_SELF_REFUSED');
    return null;
  }
  const identity = self ? { worker: source.REALTIME_WORKER_ID, incarnation: source.REALTIME_WORKER_INCARNATION } : undefined;
  const read = c.parsedFile(file, value => parse(value, { internal, self: identity, maxBytes, timeoutMs }),
    { label: 'MULTITENANT_REALTIME_PLACEMENT', source });
  const placement = create({ read, self: identity });
  placement.current();
  return placement;
}
function loadRoutes (source = process.env, options = {}) {
  if (source.MULTITENANT_REALTIME_ROUTES === undefined) return load(source, options);
  return load({ ...source, MULTITENANT_REALTIME_PLACEMENT: source.MULTITENANT_REALTIME_ROUTES }, { ...options, self: false });
}
module.exports = { RULE, parse, shard, create, load, loadRoutes };
