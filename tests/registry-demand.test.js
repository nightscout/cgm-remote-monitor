'use strict';

// covers: lib/server/serve/registry-demand.js, lib/server/serve/registry-tenant-set.js
const assert = require('node:assert/strict');
const demand = require('../lib/server/serve/registry-demand');

function tenant (i) { return '10000000-0000-4000-8000-' + i.toString(16).padStart(12, '0'); }
async function registry (count, options = {}) {
  const rows = new Set(Array.from({ length: count }, (_, i) => tenant(i + 1)));
  const calls = { revisions: 0, pages: 0, builds: 0 };
  let revision = 1;
  const store = {
    async revision () { calls.revisions++; return String(revision); },
    async page (cursor, limit) {
      calls.pages++;
      return { revision: String(revision), tenants: [...rows].sort().filter(id => id > cursor).slice(0, limit) };
    },
    async lookup () {}, async entry () {}
  };
  const set = await demand({ store, settings: { refreshMs: 250, maxTenants: 10 }, maxTenants: 2,
    build: id => { calls.builds++; return { id }; }, schedule: () => null, ...options });
  return { set, calls, remove (id) { rows.delete(id); revision++; }, add (id) { rows.add(id); revision++; } };
}

describe('demand-driven registry membership', function () {
  for (const count of [10, 1000]) {
    it('opens on one revision read with ' + count + ' provisioned tenants and picks up a live add', async function () {
      const { set, calls, add } = await registry(count);
      try {
        assert.deepEqual(calls, { revisions: 1, pages: 0, builds: 0 });
        const added = tenant(count + 1);
        add(added);
        await set.poll();
        assert.equal(calls.pages, 0);
        const first = await Promise.all([set.lookup(added), set.lookup(added)]);
        assert.equal(first[0], first[1]);
        assert.equal(first[0].id, added);
        assert.deepEqual(calls, { revisions: 2, pages: 1, builds: 1 });
        assert.equal(set.isActive(added), true);
        add(tenant(count + 2));
        await set.poll();
        assert.equal(calls.pages, 1, 'adding another tenant cannot schedule work for an idle resident');
        assert.equal(set.isActive(added), false);
        assert.equal(await set.lookup(added), first[0]);
        assert.equal(calls.pages, 2);
      } finally { await set.close(); }
    });
  }
  it('bounds materialized tenants, reports excess demand and releases removed tenants', async function () {
    const { set, calls, remove } = await registry(10);
    const removed = [];
    try {
      set.onRemove(id => removed.push(id));
      await set.lookup(tenant(1)); await set.lookup(tenant(2));
      await assert.rejects(set.lookup(tenant(3)), { code: 'TENANT_REGISTRY_OVER_BOUND' });
      assert.equal(set.stats().failure, 'TENANT_REGISTRY_OVER_BOUND');
      remove(tenant(1));
      await set.poll();
      assert.deepEqual(removed, [tenant(1)]);
      assert.equal(set.stats().failure, null);
      assert.equal(calls.pages, 4);
      assert.equal(set.isActive(tenant(1)), false);
      assert.equal((await set.lookup(tenant(3))).id, tenant(3));
      assert.equal(await set.lookup(tenant(1)), null);
    } finally { await set.close(); }
    await assert.rejects(set.lookup(tenant(2)), { code: 'TENANT_REGISTRY_CLOSED' });
  });
  it('withdraws before draining without allowing a stale completion to re-admit the same tenant', async function () {
    const { set, add, remove } = await registry(10);
    let finish;
    const drain = new Promise(resolve => { finish = resolve; });
    set.onRemove(() => drain);
    try {
      await set.lookup(tenant(1));
      remove(tenant(1));
      await set.poll();
      assert.equal(await set.lookup(tenant(1)), null);
      add(tenant(1));
      await set.poll();
      await assert.rejects(set.lookup(tenant(1)), { code: 'TENANT_REGISTRY_ADMISSION_STALE' });
      finish();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal((await set.lookup(tenant(1))).id, tenant(1));
    } finally { finish(); await set.close(); }
  });
  it('a foreign slice costs no database work and never acquires membership', async function () {
    const { set, calls } = await registry(10, { accept: id => id === tenant(2) });
    try {
      assert.equal(await set.lookup(tenant(1)), null);
      assert.equal(calls.pages, 0);
      assert.equal(set.tenants.size, 0);
    } finally { await set.close(); }
  });
});
