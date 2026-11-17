'use strict';
// Earliest-due lookups after clinical completions. Every completion may move
// its own tenant's due instant; the scheduler must still arm the earliest
// durable due instant, without one indexed lookup per completion under load.
const assert = require('node:assert/strict');
const scheduler = require('../lib/pgstream/activity-scheduler');

function lab ({ tenants, concurrency = 8, dueCoalesceMs = 250 }) {
  let now = 1000, dueAt = null, lookups = 0, id = 0;
  const timers = new Map(), release = new Map();
  const store = {
    async work () { return []; },
    async nextDue () { lookups++; return dueAt; },
    async deliveries () { return []; },
    async acknowledge () {}
  };
  const value = scheduler.start({ store, concurrency, dueCoalesceMs,
    scan: async () => {}, send: async () => {},
    run: tenant => new Promise(resolve => release.set(tenant, resolve)),
    setTimer: (fn, ms) => { const key = ++id; timers.set(key, { fn, at: now + ms }); return key; },
    clearTimer: key => timers.delete(key), now: () => now });
  async function settle () { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); }
  async function advance (ms) {
    const until = now + ms;
    for (;;) {
      const next = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]); now = Math.max(now, next[1].at); next[1].fn(); await settle();
    }
    now = until; await settle();
  }
  return { value, tenants, release, settle, advance, timers, setDue: at => { dueAt = at; },
    get lookups () { return lookups; }, get now () { return now; } };
}

const ids = Array.from({ length: 8 }, (_, i) => String(i + 1).repeat(8) + '-1111-4111-8111-111111111111');

describe('coalesced earliest-due refresh after clinical completions', function () {
  it('uses a bounded number of due lookups for a burst of completions and still arms the earliest due', async function () {
    const l = lab({ tenants: ids });
    for (const tenant of ids) l.value.wake(tenant);
    await l.advance(0);
    assert.equal(l.release.size, ids.length, 'every tenant is running');
    const before = l.lookups;
    let committed;
    // Completions arrive while neighbours still run; the last one commits a due instant.
    for (const [index, tenant] of ids.entries()) {
      if (index === ids.length - 1) { committed = l.now + 60000; l.setDue(committed); }
      l.release.get(tenant)(); await l.settle();
    }
    await l.advance(250);
    const used = l.lookups - before;
    assert(used <= 3, 'DUE_LOOKUP_PER_COMPLETION ' + used + ' lookups for ' + ids.length + ' completions');
    assert([...l.timers.values()].some(t => t.at === committed), 'EARLIEST_DUE_NOT_ARMED');
    await l.value.close();
  });

  it('looks up at once after the last completion when nothing else runs', async function () {
    const l = lab({ tenants: ids.slice(0, 1) });
    l.value.wake(ids[0]);
    await l.advance(0);
    const before = l.lookups;
    l.setDue(l.now + 5000);
    l.release.get(ids[0])(); await l.settle();
    assert(l.lookups > before, 'IDLE_COMPLETION_DUE_DEFERRED');
    await l.value.close();
  });
});
