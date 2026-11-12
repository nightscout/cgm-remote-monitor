'use strict';

// Registry resolver (decision tenant-registry): first-request lookup, bounded
// cache, refresh on the aggregate revision, unknown and removed hosts.
// A fake store and clock; synthetic tenants and hosts only.
// covers: lib/tenant-registry/resolver.js
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createRegistryResolver } = require('../lib/tenant-registry/resolver');

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

  it('RR_BOUNDS: refuses unbounded cache or refresh settings', function () {
    assert.throws(() => createRegistryResolver({ store, maxTenants: 0 }));
    assert.throws(() => createRegistryResolver({ store, maxTenants: 100001 }));
    assert.throws(() => createRegistryResolver({ store, refreshMs: 100 }));
    assert.throws(() => createRegistryResolver({ store, mode: 'canonical-internal' }), /trusted-proxy/);
  });
});
