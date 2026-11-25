'use strict';
// Best-effort completed-output wake from the evaluator to realtime.
// The committed completed-output revision is what realtime converges to
// (lib/server/realtime/runtime.js). This sender keeps no durable state, writes
// no ACK and never retries: a lost or refused wake is covered by realtime's
// level pass over its watched tenants. One RPC is in flight at a time; wakes arriving
// during it coalesce into the next batch of at most PAGE distinct tenants.
const PAGE = 64;
function create ({ send, bind = fn => fn, setTimer = setTimeout, clearTimer = clearTimeout, admits = () => true, maxTenants = 10000 }) {
  if (typeof send !== 'function' || typeof bind !== 'function' || typeof admits !== 'function' || !Number.isSafeInteger(maxTenants) || maxTenants < 1) throw new TypeError('Explicit completed-output wake sender required');
  const pending = new Set();
  const counters = { wakes: 0, batches: 0, tenants: 0, failures: 0, dropped: 0 };
  let closed = false, timer = null, flight = null;
  function arm () {
    if (closed || timer || flight) return;
    timer = setTimer(bind(() => { timer = null; flush(); }), 0); timer?.unref?.();
  }
  function flush () {
    if (closed || flight || !pending.size) return flight;
    flight = (async () => {
      while (!closed && pending.size) {
        const tenants = [...pending].slice(0, PAGE);
        for (const tenant of tenants) pending.delete(tenant);
        counters.batches++; counters.tenants += tenants.length;
        try { await send({ tenants }); } catch { counters.failures++; }
      }
    })().finally(() => { flight = null; if (pending.size) arm(); });
    return flight;
  }
  return Object.freeze({
    wake (tenant) {
      if (closed || !admits(tenant)) return;
      counters.wakes++;
      // RAM is bounded; an overflowed wake is covered by realtime's level pass.
      if (!pending.has(tenant) && pending.size >= maxTenants) { counters.dropped++; return; }
      pending.add(tenant); arm();
    },
    flush,
    stats: () => Object.freeze({ ...counters, pending: pending.size }),
    async close () { closed = true; if (timer) clearTimer(timer); timer = null; pending.clear(); await Promise.allSettled([flight]); }
  });
}
module.exports = { create, PAGE };
