'use strict';

// The evaluator's pool gate (MT-EVALUATOR-PARTITION): one membership read per
// scheduled evaluator pass, shared by the runtime and the notification
// consumers, so a refused member stops its own evaluation and delivery
// together. The read is lib/pool-membership `slice()`, which also raises the
// membership alert once per change of reason.
//
// Legacy standalone (flag off): the gate admits every configured tenant, reads and
// writes nothing, and inspection reports the configured tenants without a
// lease. Partitioned: the gate admits only this member's current slice, and
// nothing while membership is refused or not yet read. The slice follows the
// operator's member count, so tenants move in and out while the process runs.
// Selected v2 standalone also refreshes committed assignment, without a lease.
const { RULE, bucket } = require('../../pool-membership/slice');

function create ({ member, tenants, now = Date.now, schedule = setInterval, cancel = clearInterval }) {
  if (!member || typeof member.slice !== 'function' || !Array.isArray(tenants)) throw new TypeError('Evaluator pool member and tenants required');
  const partitioned = member.configured.mode === 'partitioned';
  const assignmentRefresh = member.requiresAssignmentRefresh === true;
  const requiresRefresh = partitioned || assignmentRefresh;
  let verdict = requiresRefresh ? Object.freeze({ eligible: false, reason: 'POOL_NOT_READ', conflicts: [] }) : null;
  let checkedAt = null, reads = 0, refusals = 0, changes = 0, running = null, timer = null, closed = false;
  const listeners = new Set();
  const heartbeats = { renewed: 0, failed: 0, lastReason: null };

  function admits (tenant) {
    if (closed) return false;
    if (!requiresRefresh) return true;
    return verdict.eligible === true && verdict.includes(tenant);
  }
  // Single flight: concurrent passes share one membership read.
  function refresh () {
    if (closed) return Promise.resolve(verdict);
    if (!requiresRefresh) return Promise.resolve(null);
    if (running) return running;
    running = (async () => {
      const before = tenants.filter(admits), previous = verdict;
      let next;
      try { next = await member.slice(); } catch { next = Object.freeze({ eligible: false, reason: 'POOL_UNAVAILABLE', conflicts: [] }); }
      reads++; checkedAt = now();
      if (!next.eligible) refusals++;
      verdict = next;
      const after = tenants.filter(admits);
      const assignmentChanged = assignmentRefresh && ['partitioned', 'members', 'revision'].some(key => previous[key] !== next[key]);
      if (assignmentChanged || before.length !== after.length || before.some((tenant, i) => tenant !== after[i])) {
        changes++;
        for (const listener of listeners) { try { listener(); } catch { /* a listener never fails the read */ } }
      }
      return verdict;
    })().finally(() => { running = null; });
    return running;
  }
  function start (leaseMs) {
    if (!partitioned || timer || closed) return;
    const every = Math.max(50, Math.floor(leaseMs / 3));
    timer = schedule(() => {
      member.heartbeat().then(result => {
        if (result.renewed) heartbeats.renewed++; else { heartbeats.failed++; heartbeats.lastReason = result.reason || null; }
      }, () => { heartbeats.failed++; heartbeats.lastReason = 'POOL_UNAVAILABLE'; });
    }, every);
    timer?.unref?.();
  }
  // Read-only operational view: configured values beside observed membership
  // and this member's view of each configured tenant. Never schedules work,
  // renews a lease or changes eligibility.
  async function inspect () {
    const pool = await member.inspect();
    const observed = pool.observed;
    const assigned = members => tenant => (members ? bucket(tenant, members) : null);
    const owner = assigned(requiresRefresh ? observed?.members : 1);
    return {
      kind: pool.kind,
      configured: { mode: pool.configured.mode, ordinal: pool.configured.ordinal, rule: pool.configured.rule || null,
        leaseMs: pool.configured.leaseMs || null, configuredTenants: tenants.length },
      observed: requiresRefresh ? {
        desiredMembers: observed?.desired?.members ?? null, previousMembers: observed?.desired?.previousMembers ?? null,
        revision: observed?.desired?.revision ?? null, effectiveMembers: observed?.members ?? null, switching: !!observed?.switching,
        liveOrdinals: Array.isArray(observed?.liveOrdinals) ? [...observed.liveOrdinals] : null,
        missingOrdinals: Array.isArray(observed?.missingOrdinals) ? [...observed.missingOrdinals] : null,
        conflicts: Array.isArray(observed?.conflicts) ? observed.conflicts.map(conflict => conflict.reason) : [],
        reason: observed?.reason || null,
        rows: Array.isArray(observed?.rows) ? observed.rows.map(row => ({ ordinal: row.ordinal, self: !!row.self, live: !!row.live,
          appliedMembers: row.appliedMembers ?? null,
          heartbeatAgeMs: row.heartbeatAgeMs, leaseRemainingMs: row.leaseRemainingMs })) : []
      } : null,
      gate: { eligible: requiresRefresh ? verdict.eligible === true : true, reason: requiresRefresh ? verdict.reason || null : null,
        members: requiresRefresh ? verdict.members ?? null : 1, reads, refusals, changes,
        checkedAgeMs: checkedAt === null ? null : Math.max(0, now() - checkedAt),
        heartbeats: partitioned ? { ...heartbeats } : null },
      owner, admits
    };
  }
  return Object.freeze({
    partitioned, admits, refresh, start, inspect,
    addTenant (tenant) { if (!tenants.includes(tenant)) tenants.push(tenant); },
    removeTenant (tenant) { const index=tenants.indexOf(tenant);if(index>=0)tenants.splice(index,1); },
    reason: () => (requiresRefresh ? verdict.reason || null : null),
    onChange (listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close () { closed = true; if (timer) cancel(timer); timer = null; }
  });
}

module.exports = { create, RULE };
