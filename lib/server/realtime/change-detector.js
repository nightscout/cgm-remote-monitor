'use strict';

// Realtime change detection (decision cost-proportional-to-activity, D6).
// One process asks once per interval, for all of its tenants together:
//   stamps    the tenant write clock: one statement through the
//             change-stamp function (lib/change-stamps), or one round trip of
//             per-tenant statements without it;
//   activity  pause/suspend state, when activity is configured (one round trip);
//   identity  the effective configuration identity (one configuration file read).
// The result is a hint. The runtime compares the stamp with the checkpoint of
// the refresh it last published; that refresh, under the operation window, is
// what is served. Nothing here is per socket.
//
// Shared shape with the evaluator's per-member change query (peer lane): both
// need `stamps(tenants) -> Map<tenant, stamp>` over the clock table; the
// evaluator compares with its own checkpoint. A later NOTIFY or slot reader
// replaces the interval as the trigger and calls the runtime's wake(tenant).
const c = require('./contract');
const quote = name => '"' + name + '"';
// One statement per member per interval through the change-stamp function
// (lib/change-stamps) when its namespace is configured; otherwise one round
// trip with one statement per tenant (postgres-connection scanTenants).
function stampReader ({ connection, clockNamespace, changeStampsNamespace }) {
  if (changeStampsNamespace !== undefined) {
    const reader = require('../../change-stamps/postgres').create({ connection, namespace: changeStampsNamespace, clockNamespace });
    return Object.assign(tenants => reader.stamps(tenants), { stats: reader.stats });
  }
  if (typeof connection?.scanTenants !== 'function' || !/^[a-z][a-z0-9_]{0,62}$/.test(clockNamespace || '')) throw new TypeError('Realtime stamp reader requires a scanning connection and clock namespace');
  const text = 'SELECT last_stamp::text AS stamp FROM ' + quote(clockNamespace) +
    ".tenant_write_clock WHERE tenant_id = nullif(current_setting('app.current_tenant_id', true), '')::uuid";
  return async tenants => new Map([...await connection.scanTenants([...tenants], text)].map(([tenant, rows]) => [tenant, rows.length === 1 ? rows[0].stamp : null]));
}
function create ({ readStamps, readActivity, readIdentities, onPoll } = {}) {
  if ([readStamps, readIdentities].some(fn => typeof fn !== 'function') || (readActivity !== undefined && typeof readActivity !== 'function') ||
      (onPoll !== undefined && typeof onPoll !== 'function')) throw new TypeError('Realtime change detection requires stamp and identity readers');
  const counters = { polls: 0, failures: 0 };
  async function poll (tenants) {
    if (!Array.isArray(tenants) || tenants.some(tenant => !c.uuid(tenant))) throw new TypeError('Realtime change detection requires UUID tenants');
    counters.polls++;
    try {
      const [stamps, activity, identities] = await Promise.all([readStamps(tenants), readActivity ? readActivity(tenants) : null, readIdentities(tenants)]);
      const result = new Map();
      for (const tenant of tenants) {
        result.set(tenant, Object.freeze({ stamp: stamps.get(tenant) ?? null, identity: identities.get(tenant)?.identity ?? null,
          ...(activity ? { activity: activity.get(tenant) ?? null } : {}) }));
      }
      if (onPoll) await onPoll(result);
      return result;
    } catch (error) { counters.failures++; throw error; }
  }
  return Object.freeze({ poll, stats: () => Object.freeze({ ...counters }) });
}
// A tenant removed from admission (identity null) or not eligible to be read
// (paused, suspended, unprovisioned, unreadable) has its sockets disconnected.
function invalidateIneligible (seen, { activity, invalidate }) {
  const eligible = require('../../tenant-activity/policy').eligible;
  for (const [tenant, row] of seen) {
    if (row.identity === null || (activity && !eligible('read', row.activity?.state))) invalidate(tenant);
  }
}
module.exports = { create, stampReader, invalidateIneligible };
