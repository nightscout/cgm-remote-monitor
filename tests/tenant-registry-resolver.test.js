'use strict';

// Registry resolver (decision tenant-registry): first-request lookup, bounded
// cache, refresh on the aggregate revision, unknown and removed hosts.
// A fake store and clock; synthetic tenants and hosts only.
// covers: lib/tenant-registry/resolver.js
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createRegistryResolver } = require('../lib/tenant-registry/resolver');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');

function fakeStore () {
  const hosts = new Map(), states = new Map();
  let revision = 1;
  const calls = { lookup: 0, revision: 0, entry: 0 };
  return {
    calls,
    failRevision: false,
    add (tenant, host, kind = 'alias') { states.set(tenant, 'active'); hosts.set(kind + ' ' + host, tenant); revision++; },
    remove (tenant) { for (const [key, value] of hosts) if (value === tenant) hosts.delete(key); states.set(tenant, 'removed'); revision++; },
    async lookup (host, kind) { calls.lookup++; const tenant = hosts.get(kind + ' ' + host); return tenant ? { tenant, state: states.get(tenant) } : null; },
    async revision () { calls.revision++; if (this.failRevision) throw new Error('unavailable'); return String(revision); },
    async entry (tenant) { calls.entry++; return states.has(tenant) ? { tenant, state: states.get(tenant), signingVersion: 1, keys: [] } : null; }
  };
}
const request = (host, extra = []) => ({ rawHeaders: ['Host', host, ...extra] });

describe('serving registry outage budgets', function () {
  it('bounds actual connection checkout and client reads without changing pool or server bounds', async function () {
    const filename = require.resolve('../lib/server/serve/registry-tenants'), loaded = new Module(filename, module);
    loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    const stopped = new Error('recorded constructor boundary'); let selected;
    loaded.require = name => name === '../../storage/postgres-connection' ? async options => { selected = options; throw stopped; }
      : Module.prototype.require.call(loaded, name);
    loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
    await assert.rejects(loaded.exports.create({ settings: { namespace: 'synthetic_registry' }, connectionString: 'synthetic' }), error => error === stopped);
    assert.equal(selected.connectionTimeoutMillis, 1000); assert.equal(selected.query_timeout, 1000);
    assert.equal(selected.max, 2); assert.equal(selected.statement_timeout, 5000);
  });
});

describe('tenant registry resolver', function () {
  let store, clock, resolver;
  const A = randomUUID(), B = randomUUID();
  beforeEach(async function () {
    store = fakeStore(); clock = { t: 0 };
    store.add(A, 'one.example.test');
    resolver = createRegistryResolver({ store, refreshMs: 1000, now: () => clock.t, schedule: () => null, cancel: () => {} });
    await resolver.start();
  });
  afterEach(() => resolver.close());

  it('RR_FIRST_REQUEST: looks a host up once, then serves it from the cache', async function () {
    assert.equal(await resolver.resolve(request('one.example.test')), A);
    assert.equal(await resolver.resolve(request('ONE.example.test:1337')), A, 'same host rules as the static resolver');
    assert.equal(store.calls.lookup, 1);
  });

  it('RR_ORIGIN: derives HTTPS only from a registered alias of the resolved tenant', async function () {
    assert.deepEqual(await resolver.resolveOrigin(request('ONE.example.test:443')), { tenant: A, origin: 'https://one.example.test' });
    const canonical = createRegistryResolver({ store, mode: 'canonical-internal', trustedProxy: () => true,
      refreshMs: 1000, schedule: () => null, cancel: () => {} });
    store.add(A, 'internal.example.test', 'internal');
    store.add(B, 'other.example.test');
    await canonical.start();
    try {
      assert.deepEqual(await canonical.resolveOrigin(request('internal.example.test', ['X-Forwarded-Host', 'one.example.test'])),
        { tenant: A, origin: 'https://one.example.test' });
      await assert.rejects(canonical.resolveOrigin(request('internal.example.test')), { code: 'TENANT_ORIGIN_REFUSED' });
      await assert.rejects(canonical.resolveOrigin(request('internal.example.test', ['X-Forwarded-Host', 'unregistered.example.test'])), { code: 'TENANT_ORIGIN_REFUSED' });
      await assert.rejects(canonical.resolveOrigin(request('internal.example.test', ['X-Forwarded-Host', 'other.example.test'])), { code: 'TENANT_SELECTOR_CONFLICT' });
    } finally { canonical.close(); }
  });

  it('RR_UNKNOWN_HOST: the same refusal as today, one lookup per host per revision', async function () {
    for (let i = 0; i < 5; i++) await assert.rejects(resolver.resolve(request('nope.example.test')), { code: 'TENANT_HOST_UNKNOWN' });
    assert.equal(store.calls.lookup, 1);
    await assert.rejects(resolver.resolve(request('bad host')), { code: 'TENANT_HOST_INVALID' });
    await assert.rejects(resolver.resolve(request('one.example.test', ['X-Forwarded-Host', 'one.example.test'])), { code: 'TENANT_PROXY_UNTRUSTED' });
  });

  it('RR_NEW_TENANT: a tenant provisioned while running is served after the next poll, without a restart', async function () {
    await assert.rejects(resolver.resolve(request('two.example.test')), { code: 'TENANT_HOST_UNKNOWN' });
    store.add(B, 'two.example.test');
    await assert.rejects(resolver.resolve(request('two.example.test')), { code: 'TENANT_HOST_UNKNOWN' }, 'still the cached refusal before the poll');
    clock.t += 1000; await resolver.poll();
    assert.equal(await resolver.resolve(request('two.example.test')), B);
  });

  it('RR_REMOVED: a removed tenant is refused after the next poll; its entry refuses', async function () {
    assert.equal(await resolver.resolve(request('one.example.test')), A);
    assert.equal((await resolver.entry(A)).tenant, A);
    store.remove(A);
    clock.t += 1000; await resolver.poll();
    await assert.rejects(resolver.resolve(request('one.example.test')), { code: 'TENANT_HOST_UNKNOWN' });
    await assert.rejects(resolver.entry(A), { code: 'TENANT_REMOVED' });
  });

  it('RR_REVISION_LISTENERS: listeners hear a moved revision only', async function () {
    const heard = [];
    resolver.onRevision(revision => heard.push(revision));
    await resolver.poll();
    store.add(B, 'two.example.test');
    await resolver.poll();
    assert.deepEqual(heard, ['3']);
  });

  it('RR_FAIL_CLOSED: if the poll has not succeeded within the staleness bound, cached answers are not used', async function () {
    await resolver.resolve(request('one.example.test'));
    store.failRevision = true;
    clock.t += 3001; await resolver.poll();
    await resolver.resolve(request('one.example.test'));
    assert.equal(store.calls.lookup, 2, 'looked up again; nothing cached is trusted');
    assert.equal(resolver.stats().pollErrors, 1);
  });

  it('RR_BOUNDED: at most maxTenants positive entries; concurrent misses share one lookup', async function () {
    const small = createRegistryResolver({ store, maxTenants: 2, refreshMs: 1000, now: () => clock.t, schedule: () => null, cancel: () => {} });
    await small.start();
    const tenants = Array.from({ length: 3 }, () => randomUUID());
    tenants.forEach((tenant, i) => store.add(tenant, 'bulk-' + i + '.example.test'));
    await small.poll();
    for (let i = 0; i < 3; i++) await small.resolve(request('bulk-' + i + '.example.test'));
    assert.equal(small.stats().cached, 2);
    assert.equal(small.stats().evictions, 1);
    const before = store.calls.lookup;
    await Promise.all(Array.from({ length: 10 }, () => small.resolve(request('bulk-0.example.test'))));
    assert.equal(store.calls.lookup - before, 1, 'evicted host re-looked up once for ten concurrent requests');
    small.close();
  });

  it('RR_CANONICAL: canonical-internal mode needs a trusted peer, an internal name and agreeing selectors', async function () {
    store.add(A, 'a.internal.test', 'internal');
    store.add(B, 'two.example.test');
    store.add(B, 'b.internal.test', 'internal');
    const trusted = createRegistryResolver({ store, mode: 'canonical-internal', trustedProxy: req => req.trusted === true,
      refreshMs: 1000, now: () => clock.t, schedule: () => null, cancel: () => {} });
    await trusted.start();
    const req = (host, extra, trust = true) => ({ ...request(host, extra), trusted: trust });
    assert.equal(await trusted.resolve(req('a.internal.test', ['X-Forwarded-Host', 'one.example.test'])), A);
    await assert.rejects(trusted.resolve(req('a.internal.test', [], false)), { code: 'TENANT_PROXY_UNTRUSTED' });
    await assert.rejects(trusted.resolve(req('one.example.test', [])), { code: 'TENANT_HOST_UNKNOWN' }, 'a public alias is not an internal name');
    await assert.rejects(trusted.resolve(req('a.internal.test', ['X-Forwarded-Host', 'two.example.test'])), { code: 'TENANT_SELECTOR_CONFLICT' });
    await assert.rejects(trusted.resolve(req('a.internal.test', ['X-Resolved-Tenant', B])), { code: 'TENANT_SELECTOR_CONFLICT' });
    trusted.close();
  });

  // Control (decision ack-path-tenant-independent): provisioning other tenants
  // costs the cached active set no registry reads, so registry work during
  // provisioning is the same at 10 and 1,000 tenants; removal still refuses
  // at the next poll and another tenant's host never resolves to it.
  it('RR_ADDRESSED: registry work while provisioning is independent of the roster; removal and cross-tenant refusal stay immediate', async function () {
    async function provision (count) {
      const s = fakeStore(), stamps = new Map();
      let revision = 1;
      Object.assign(s, {
        add (tenant, host) { revision++; this.hosts.set('alias ' + host, tenant); this.states.set(tenant, 'active'); stamps.set(tenant, revision); },
        remove (tenant) { revision++; for (const [key, value] of this.hosts) if (value === tenant) this.hosts.delete(key); this.states.set(tenant, 'removed'); stamps.set(tenant, revision); },
        hosts: new Map(), states: new Map(),
        async lookup (host, kind) { s.calls.lookup++; const tenant = this.hosts.get(kind + ' ' + host); return tenant ? { tenant, state: this.states.get(tenant) } : null; },
        async entry (tenant) { s.calls.entry++; return this.states.has(tenant) ? { tenant, state: this.states.get(tenant), signingVersion: 1, keys: [] } : null; },
        async revision () { s.calls.revision++; return String(revision); },
        async changed (after, tenants) { s.calls.revision++; return { revision: String(revision), changed: tenants.filter(tenant => (stamps.get(tenant) || 0) > Number(after)) }; }
      });
      const active = ['a', 'b', 'c'].map(name => ({ tenant: randomUUID(), host: name + '.active.test' }));
      active.forEach(row => s.add(row.tenant, row.host));
      const r = createRegistryResolver({ store: s, refreshMs: 1000, now: () => 0, schedule: () => null, cancel: () => {} });
      await r.start();
      const use = async () => { for (const row of active) { assert.equal(await r.resolve(request(row.host)), row.tenant); await r.entry(row.tenant); } };
      await use();
      const before = s.calls.lookup + s.calls.entry;
      for (let i = 0; i < count; i++) { s.add(randomUUID(), 'bulk-' + i + '.example.test'); await r.poll(); await use(); }
      const work = s.calls.lookup + s.calls.entry - before;
      // Revocation: a removed active tenant is refused after the next poll.
      s.remove(active[0].tenant); await r.poll();
      await assert.rejects(r.resolve(request(active[0].host)), { code: 'TENANT_HOST_UNKNOWN' });
      await assert.rejects(r.entry(active[0].tenant), { code: 'TENANT_REMOVED' });
      // Cross-tenant: one tenant's host with another's asserted id refuses.
      await assert.rejects(r.resolve(request(active[1].host, ['X-Resolved-Tenant', active[2].tenant])), { code: 'TENANT_PROXY_UNTRUSTED' });
      assert.equal(await r.resolve(request(active[1].host)), active[1].tenant);
      r.close();
      return work;
    }
    const small = await provision(10), large = await provision(1000);
    assert.equal(small, 0, 'unaddressed revisions cost the cached active set nothing');
    assert.equal(large, small, 'equal at 10 and 1,000 provisioned tenants');
  });

  it('RR_BOUNDS: refuses unbounded cache or refresh settings', function () {
    assert.throws(() => createRegistryResolver({ store, maxTenants: 0 }));
    assert.throws(() => createRegistryResolver({ store, maxTenants: 100001 }));
    assert.throws(() => createRegistryResolver({ store, refreshMs: 100 }));
    assert.throws(() => createRegistryResolver({ store, mode: 'canonical-internal' }), /trusted-proxy/);
  });
});

describe('revision-first registry polling', function () {
  const A = randomUUID(), B = randomUUID(), C = randomUUID(), resident = randomUUID();
  const a = request('one.example.test'), b = request('two.example.test'), c = request('three.example.test');
  let store, resolver, clock, candidateReads;

  beforeEach(function () {
    store = fakeStore();
    store.add(A, 'one.example.test');
    store.add(B, 'two.example.test');
    store.add(C, 'three.example.test');
    clock = 0;
    candidateReads = 0;
    resolver = createRegistryResolver({ store, refreshMs: 1000, now: () => clock, schedule: () => null,
      candidates () { candidateReads++; return [resident]; } });
  });
  afterEach(() => resolver.close());

  it('refreshes unchanged residents with one scalar read per poll', async function () {
    let addressed = 0;
    store.changed = async () => { addressed++; return { revision: '4', changed: [] }; };
    await resolver.start();
    await resolver.resolve(a);
    await resolver.entry(B);
    for (let i = 0; i < 5; i++) {
      clock += 1000;
      assert.equal(await resolver.poll(), '4');
    }
    assert.equal(store.calls.revision, 6);
    assert.equal(candidateReads, 0);
    assert.equal(addressed, 0);
    assert.equal(await resolver.resolve(a), A);
    assert.equal((await resolver.entry(B)).tenant, B);
    assert.equal(store.calls.lookup, 1);
    assert.equal(store.calls.entry, 1);
  });

  it('coalesces both reads and carries only fills covered by the addressed snapshot', async function () {
    const newHost = request('new.example.test');
    await resolver.start();
    await resolver.resolve(a);
    await assert.rejects(resolver.resolve(newHost), { code: 'TENANT_HOST_UNKNOWN' });

    store.add(C, 'new.example.test');
    const scalar = Promise.withResolvers(), addressed = Promise.withResolvers();
    const addressedStarted = Promise.withResolvers();
    const reads = [], heard = [];
    resolver.onRevision((revision, { previous, unchanged }) => heard.push({
      revision, previous, carried: [A, B, C, resident].filter(unchanged)
    }));
    store.revision = () => { reads.push('scalar'); return scalar.promise; };
    store.changed = (after, ids) => {
      reads.push({ after, ids: new Set(ids) });
      addressedStarted.resolve();
      return addressed.promise;
    };

    const first = resolver.poll(), duringScalar = resolver.poll();
    await resolver.entry(B);
    store.remove(A); // Commit after the scalar snapshot.
    scalar.resolve('5');
    await addressedStarted.promise;
    const duringAddressed = resolver.poll();
    await resolver.resolve(c);
    await resolver.entry(C);
    addressed.resolve({ revision: '6', changed: [A] });
    assert.deepEqual(await Promise.all([first, duringScalar, duringAddressed]), ['6', '6', '6']);
    assert.deepEqual(reads, ['scalar', { after: '4', ids: new Set([A, B, resident]) }]);
    assert.deepEqual(heard, [{ revision: '6', previous: '4', carried: [B, resident] }]);

    await assert.rejects(resolver.resolve(a), { code: 'TENANT_HOST_UNKNOWN' });
    assert.equal(await resolver.resolve(newHost), C);
    const before = { ...store.calls };
    await resolver.entry(B);
    assert.equal(store.calls.entry, before.entry);
    await resolver.resolve(c);
    await resolver.entry(C);
    assert.equal(store.calls.lookup - before.lookup, 1);
    assert.equal(store.calls.entry - before.entry, 1);
  });

  it('retries a failed addressed read from the last success and applies global invalidation', async function () {
    await resolver.start();
    await resolver.resolve(b);
    await resolver.entry(B);
    store.remove(A);
    const after = [], pending = Promise.withResolvers(), addressedStarted = Promise.withResolvers();
    store.changed = async previous => {
      after.push(previous);
      if (after.length === 1) {
        addressedStarted.resolve();
        return pending.promise;
      }
      return { revision: '5', changed: null };
    };
    clock = 2900;
    const failed = resolver.poll();
    await addressedStarted.promise;
    clock = 3100;
    await resolver.resolve(b);
    await resolver.entry(B);
    assert.equal(store.calls.lookup, 2);
    assert.equal(store.calls.entry, 2);

    pending.reject(new Error('unavailable'));
    assert.equal(await failed, '4');
    assert.equal(resolver.stats().pollErrors, 1);
    await resolver.resolve(b);
    assert.equal(store.calls.lookup, 3);

    const heard = [];
    resolver.onRevision((revision, { unchanged }) => heard.push([revision, unchanged(B), unchanged(resident)]));
    assert.equal(await resolver.poll(), '5');
    assert.deepEqual(after, ['4', '4']);
    assert.deepEqual(heard, [['5', false, false]]);
    await resolver.resolve(b);
    await resolver.entry(B);
    assert.equal(store.calls.lookup, 4);
    assert.equal(store.calls.entry, 3);
  });

  it('releases the shared poll when the scalar store call throws', async function () {
    await resolver.start();
    const revision = store.revision;
    store.revision = () => { throw new Error('unavailable'); };
    assert.equal(await resolver.poll(), '4');
    assert.equal(resolver.stats().pollErrors, 1);
    store.revision = revision;
    store.remove(B);
    assert.equal(await resolver.poll(), '5');
  });
});
