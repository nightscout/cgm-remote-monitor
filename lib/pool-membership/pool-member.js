'use strict';
// Source adapter for one applied placement. This does not scale, restart or
// discover processes. SQL owner/incarnation/lifecycle checks fence every effect.
const profiles = require('../pgstream/pool-intake-profile');
const windows = require('../tenant-lifecycle/operation-window');
const placement = require('./pool-candidate');
const { RULE, predicate } = require('./slice');
const refuse = code => Object.assign(new Error(code), { code });
async function create ({ config, profile, operationWindow, readOnly }) {
  profile = profiles.validate(profile);
  const b = profile.binding;
  if (!config || config.kind !== 'evaluator' || typeof config.partitioned !== 'boolean' || !windows.isWindow(operationWindow) || operationWindow.namespace !== b.lifecycleNamespace || operationWindow.intakeProfileDigest !== profile.digest || typeof readOnly !== 'function') throw new TypeError('POOL_V2_CONFIG');
  if (config.partitioned ? config.namespace !== b.membershipNamespace || Object.keys(config).some(key=>!['kind','partitioned','ordinal','leaseMs','connectionString','namespace'].includes(key)) : Object.keys(config).some(key => !['kind', 'partitioned'].includes(key))) throw new TypeError('POOL_V2_CONFIG');
  const liveWindow = () => { if (!windows.isWindow(operationWindow) || operationWindow.intakeProfileDigest !== profile.digest) throw refuse('POOL_V2_WINDOW_UNAVAILABLE'); };
  liveWindow();
  await placement.assertInstalled(readOnly, b.membershipNamespace);
  let backend;
  if (config.partitioned) {
    const postgres = require('./postgres');
    if (typeof postgres.createPoolMember !== 'function') throw refuse('POOL_V2_BACKEND_REQUIRED');
    backend = await postgres.createPoolMember({ kind: config.kind, ordinal: config.ordinal, leaseMs: config.leaseMs, connectionString: config.connectionString, namespace: config.namespace, poolProfile: profile, operationWindow });
    if (typeof backend.backends !== 'function' || typeof backend.current !== 'function') { await backend.close(); throw refuse('POOL_V2_BACKEND_IDENTITY_REQUIRED'); }
  }
  const configured = backend ? backend.configured : Object.freeze({ mode: 'standalone', ordinal: 0, memberId: null, rule: RULE, leaseMs: null });
  let closed = false, registered = false, current = null;
  const none = reason => Object.freeze({ eligible: false, reason, conflicts: [], members: null, revision: null });
  async function standalonePlacement () {
    liveWindow();
    const rows = (await readOnly('SELECT /* pool-applied-placement */ d.partitioned,d.members,d.previous_members AS "previousMembers",d.previous_partitioned AS "previousPartitioned",d.revision::text AS revision,d.slice_rule AS rule,(SELECT count(*)::integer FROM "' + b.membershipNamespace + '".pool_membership m WHERE m.pool_kind=d.pool_kind AND m.lease_expires_at>clock_timestamp()) AS "liveMembers" FROM "' + b.membershipNamespace + '".pool_desired d WHERE d.pool_kind=$1', ['evaluator'])).rows;
    if (rows.length !== 1) throw refuse('POOL_COUNT_UNSET');
    const seen = placement.placement(rows[0]);
    if (seen.partitioned || seen.members !== 1) throw refuse('POOL_MODE_CHANGED');
    if (rows[0].liveMembers !== 0) throw refuse('POOL_STANDALONE_LIVE_MEMBERS');
    return seen;
  }
  return Object.freeze({
    kind: 'evaluator', capability: 'member', configured, requiresAssignmentRefresh: true,
    backends: () => backend ? backend.backends() : Object.freeze([]),
    current () { if (closed || !current) throw refuse('POOL_PLACEMENT_UNAVAILABLE'); liveWindow(); return current; },
    async register () {
      if (closed) throw refuse('POOL_CLOSED'); liveWindow();
      if (backend) { const result = await backend.register(); registered = true; return result; }
      await standalonePlacement(); registered = true;
      return Object.freeze({ registered: true, memberId: null });
    },
    async heartbeat () {
      if (closed) return { renewed: false, reason: 'POOL_CLOSED' };
      if (!backend) return { renewed: false, reason: 'POOL_STANDALONE_NO_LEASE' };
      liveWindow(); return backend.heartbeat();
    },
    async slice () {
      current = null;
      if (closed || !registered) return none(closed ? 'POOL_CLOSED' : 'POOL_NOT_REGISTERED');
      try {
        liveWindow();
        if (backend) {
          const verdict = await backend.slice();
          if (!verdict.eligible) return verdict;
          const seen = placement.placement(backend.current());
          if (!seen.partitioned || seen.members !== verdict.members || seen.revision !== verdict.revision) return none('POOL_ASSIGNMENT_CHANGED');
          current = seen; return verdict;
        }
        current = await standalonePlacement();
        return Object.freeze({ eligible: true, reason: null, partitioned: false, members: 1, ordinal: 0, rule: RULE, revision: current.revision, desiredMembers: 1, previousMembers: current.previousMembers, switching: false, outside: false, missingOrdinals: [], conflicts: [], includes: predicate(1, 0) });
      } catch (error) { return none(error.code || 'POOL_UNAVAILABLE'); }
    },
    async inspect () {
      liveWindow(); if (backend) return backend.inspect();
      let observed;
      try { const seen = await standalonePlacement(); observed = { desired: seen, members: 1, switching: false, outside: false, liveOrdinals: [], missingOrdinals: [], conflicts: [], rows: [], eligible: registered && !closed, reason: closed ? 'POOL_CLOSED' : !registered ? 'POOL_NOT_REGISTERED' : null }; }
      catch (error) { observed = { unavailable: true, eligible: false, reason: error.code || 'POOL_UNAVAILABLE' }; }
      return Object.freeze({ kind: 'evaluator', configured, observed: Object.freeze(observed) });
    },
    async close () { if (closed) return; closed = true; current = null; await backend?.close(); }
  });
}
module.exports = { create };
