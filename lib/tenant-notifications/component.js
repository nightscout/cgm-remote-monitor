'use strict';

// Explicit composition only: no default serving role, provider, timer or network.
const scope = require('../storage/tenant-scope');
const c = require('./contract');

module.exports = function durableNotifications ({ store, adapter, selectCycle, isCurrent, allows,
  now, maxRows, maxPayloadBytes, maxInflight, attemptTimeoutMs, retryDelayMs } = {}) {
  if (!store || ['enqueue', 'due', 'begin', 'finish', 'receipts'].some(name => typeof store[name] !== 'function') ||
      !adapter || typeof adapter.id !== 'string' || !c.NAME.test(adapter.id) || typeof adapter.send !== 'function' ||
      [selectCycle, isCurrent, allows, now].some(fn => typeof fn !== 'function')) throw new TypeError('Explicit notification store/adapter/current eligibility capabilities required');
  for (const [name, value] of Object.entries({ maxRows, maxPayloadBytes, maxInflight, attemptTimeoutMs, retryDelayMs })) c.integer(value, name);
  let closed = false, inflight = 0;
  const tasks = new Set(), tenants = new Set(), aborts = new Set();
  function check () { if (closed) throw new Error('NOTIFICATIONS_CLOSED'); }
  function selected (value, tenant) {
    if (!value || value.eligible !== true || !value.result || !Array.isArray(value.result.emitted) ||
        value.result.emitted.length > maxRows || typeof value.identity !== 'string' ||
        typeof value.runtimeId !== 'string' || !Number.isSafeInteger(value.outputRevision) || value.outputRevision < 1 ||
        (value.tenant !== undefined && value.tenant !== tenant)) throw new Error('NOTIFICATION_CYCLE_UNAVAILABLE');
    return value;
  }
  async function eligible (tenant, identity, payload) {
    check();
    if (await isCurrent(tenant, identity) !== true) return false;
    check();
    const cycle = selected(await selectCycle(tenant), tenant);
    check();
    if (cycle.identity !== identity || !cycle.result.emitted.some(row => c.sameEffect(c.notification(row, maxPayloadBytes), payload))) return false;
    if (await allows({ tenant, notification: payload, at: c.instant(now()) }) !== true) return false;
    check();
    // A config/allowlist change while the suppression read was pending cannot admit old work.
    const current = selected(await selectCycle(tenant), tenant);
    return !closed && current.identity === identity && current.runtimeId === cycle.runtimeId &&
      current.outputRevision === cycle.outputRevision && current.result === cycle.result &&
      current.result.emitted.some(row => c.sameEffect(c.notification(row, maxPayloadBytes), payload)) &&
      await isCurrent(tenant, identity) === true;
  }
  function callAdapter (row, receipts) {
    return new Promise(resolve => {
      const controller = new AbortController();
      let done = false, timer;
      const finish = outcome => {
        if (done) return;
        done = true; clearTimeout(timer); aborts.delete(abort); resolve(outcome);
      };
      const abort = () => { controller.abort(); finish({ accepted: false, reason: 'closed' }); };
      aborts.add(abort);
      timer = setTimeout(() => { controller.abort(); finish({ accepted: false, reason: 'timeout' }); }, attemptTimeoutMs);
      try {
        // request/attempt state has COMMITTED before this line; no adapter call inside SQL.
        adapter.send(Object.freeze({ tenant: row.tenant_id, id: row.request_id, attempt: row.attempt,
          notification: structuredClone(row.payload), receipts: structuredClone(receipts), signal: controller.signal }),
        (error, result) => {
          if (done || closed) return;
          if (error || !result || result.accepted !== true) finish({ accepted: false, reason: 'uncertain' });
          else finish({ accepted: true, receipt: result.receipt ?? null, cleared: result.clearedRequestIds || [] });
        });
      } catch { finish({ accepted: false, reason: 'uncertain' }); }
    });
  }
  async function attempt (tenant, row) {
    check();
    if (row.tenant_id !== tenant || row.consumer !== adapter.id) throw new Error('NOTIFICATION_TENANT_MISMATCH');
    if (row.state === 'accepted' || row.state === 'cancelled') return { id: row.request_id, state: row.state };
    if (inflight >= maxInflight) return { id: row.request_id, state: 'deferred' };
    const at = c.instant(now());
    inflight++;
    try {
      const pending = await store.begin({ tenant, id: row.request_id, at, until: at + attemptTimeoutMs });
      check();
      if (!pending) return { id: row.request_id, state: 'deferred' };
      const identity = pending.config_identity;
      if (!await eligible(tenant, identity, pending.payload)) {
        check();
        await store.finish({ tenant, id: pending.request_id, token: pending.attempt_token,
          state: 'cancelled', at: c.instant(now()), nextAt: c.instant(now()), receipt: null, cleared: [] });
        return { id: pending.request_id, state: 'cancelled' };
      }
      const receipts = pending.payload.clear ? await store.receipts({ tenant, consumer: adapter.id }) : [];
      check();
      // Receipt acquisition is asynchronous too: recheck all gates before effects.
      if (!await eligible(tenant, identity, pending.payload)) return { id: pending.request_id, state: 'deferred' };
      check();
      const outcome = await callAdapter(pending, receipts);
      if (closed) return { id: pending.request_id, state: 'attempting' }; // restart recovers after persisted deadline.
      const finishedAt = c.instant(now());
      const state = outcome.accepted ? 'accepted' : 'uncertain';
      const updated = await store.finish({ tenant, id: pending.request_id, token: pending.attempt_token, state,
        at: finishedAt, nextAt: finishedAt + Math.max(retryDelayMs, pending.payload.clear ? 0 : c.SHORT),
        receipt: outcome.receipt ?? null, cleared: outcome.cleared || [] });
      check();
      return { id: pending.request_id, state: updated ? state : 'superseded' };
    } finally { inflight--; }
  }
  function job (tenant, fn) {
    c.tenant(tenant); check();
    if (tenants.has(tenant)) return Promise.resolve({ state: 'busy' });
    tenants.add(tenant);
    const task = scope.withTenant(tenant, fn).finally(() => { tenants.delete(tenant); tasks.delete(task); });
    tasks.add(task); return task;
  }
  return Object.freeze({
    run (tenant) {
      return job(tenant, async () => {
        const cycle = selected(await selectCycle(tenant), tenant); check();
        const results = [];
        for (const [index, input] of cycle.result.emitted.entries()) {
          const payload = c.notification(input, maxPayloadBytes);
          if (!await eligible(tenant, cycle.identity, payload)) { results.push({ state: 'ineligible' }); continue; }
          check();
          const row = await store.enqueue({ tenant, consumer: adapter.id, key: c.digest(cycle.identity) + ':' + c.key(payload),
            origin: c.digest(JSON.stringify([cycle.identity, cycle.runtimeId, cycle.outputRevision, index])),
            configIdentity: cycle.identity, payload, at: c.instant(now()) });
          check(); results.push(await attempt(tenant, row));
        }
        return { state: 'complete', results };
      });
    },
    retry (tenant) {
      return job(tenant, async () => {
        const rows = await store.due({ tenant, consumer: adapter.id, at: c.instant(now()) }); check();
        if (!Array.isArray(rows) || rows.length > maxRows) throw new Error('NOTIFICATION_READ_BOUND');
        const results = [];
        for (const row of rows) {
          if (row.tenant_id !== tenant || row.consumer !== adapter.id) throw new Error('NOTIFICATION_TENANT_MISMATCH');
          results.push(await attempt(tenant, row));
        }
        return { state: 'complete', results };
      });
    },
    async close () {
      if (closed) return;
      closed = true;
      for (const abort of [...aborts]) abort();
      await Promise.allSettled([...tasks]);
    }
  });
};
