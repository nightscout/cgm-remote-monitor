'use strict';

// Pool membership: one primitive for every partitioned worker kind (decisions
// evaluator-static-partition, pool-primitive-shared). A kind names a pool
// ("evaluator", "vcpool"); kinds share the table and the slice function and
// never see each other's rows. Realtime is not a pool of this kind.
//
//   const member = await membership.member(membership.config.fromEnvironment(kind, env));
//   (the member count is the operator's: membership.operator(...).setMembers(kind, n))
//   await member.register();                 // once, before the first cycle
//   await member.heartbeat();                // every lease/3 or so
//   const slice = await member.slice();      // before each cycle
//   if (slice.eligible) work(tenants.filter(slice.includes)); else stop this cycle (alert raised)
//   await member.inspect();                  // read-only operational view
//   await member.close();                    // removes this member's row
//
// Partition off: one member owns every tenant, nothing is read or written and
// inspection reports standalone mode without a lease.
const config = require('./config');
const slice = require('./slice');
const { assess } = require('./assess');
const postgres = require('./postgres');

const all = Object.freeze(() => true);

function standalone (kind) {
  config.checkKind(kind);
  const configured = Object.freeze({ mode: 'standalone', ordinal: 0, rule: null });
  let closed = false;
  return Object.freeze({
    kind, capability: 'member', configured,
    register: async () => ({ registered: !closed, memberId: null }),
    heartbeat: async () => (closed ? { renewed: false, reason: 'POOL_CLOSED' } : { renewed: true }),
    slice: async () => Object.freeze(closed ? { eligible: false, reason: 'POOL_CLOSED', conflicts: [] }
      : { eligible: true, includes: all, members: 1, ordinal: 0, rule: null, desiredMembers: null, revision: null, switching: false, outside: false, missingOrdinals: [] }),
    inspect: async () => Object.freeze({ kind, configured, observed: null }),
    close: async () => { closed = true; }
  });
}

// `selected` is the output of config.fromEnvironment (or an equivalent object).
async function member (selected, options = {}) {
  if (!selected || typeof selected !== 'object') throw new TypeError('Pool configuration required');
  if (!selected.partitioned) return standalone(selected.kind);
  const { kind, ordinal, leaseMs, connectionString, namespace } = selected;
  return postgres.create({ ...options, kind, ordinal, leaseMs, connectionString, namespace });
}

module.exports = { member, standalone, config, slice, assess, operator: options => require('./operator').create(options),
  grants: postgres.grants, catalogue: postgres.catalogue };
