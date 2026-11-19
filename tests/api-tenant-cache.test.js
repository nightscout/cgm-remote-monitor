'use strict';

const assert = require('node:assert/strict');
const { AsyncLocalStorage } = require('node:async_hooks');
const { performance } = require('node:perf_hooks');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs'), vm = require('node:vm');
const createCache = require('../lib/server/serve/api-tenant-cache').create;
const settings = require('../lib/server/serve/pool-config');

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const options = extra => ({ capacity: 1, concurrency: 1, pendingLimit: 2, waitMs: 1000, ...extra });

function withoutEviction () {
  const file = require.resolve('../lib/server/serve/api-tenant-cache');
  const original = fs.readFileSync(file, 'utf8');
  const changed = original.replace('while (records.size > capacity)', 'while (false)');
  assert.notEqual(changed, original, 'eviction control must apply');
  const out = { exports: {} };
  vm.runInThisContext('(function(require,module,exports){' + changed + '\n})', { filename: file })(require, out, out.exports);
  return out.exports.create;
}

function withTimerOnlyDeadline () {
  const file = require.resolve('../lib/server/serve/api-tenant-cache');
  const original = fs.readFileSync(file, 'utf8');
  const changed = original.replace('while (waiting.length && waiting[0].deadline <= performance.now())', 'while (false)');
  assert.notEqual(changed, original, 'timer-only control must apply');
  const out = { exports: {} };
  vm.runInThisContext('(function(require,module,exports){' + changed + '\n})', { filename: file })(require, out, out.exports);
  return out.exports.create;
}

const stall = ms => { const end = performance.now() + ms; while (performance.now() < end) { /* finite event-loop stall */ } };

async function boundCriterion (create = createCache) {
  const cache = create(options()), pinned = cache.set('tenant-a', {});
  const service = await cache.load(pinned, async () => ({ value: 'a', close: () => assert.fail('eviction must not close active ports') }));
  for (const name of ['tenant-b', 'tenant-c', 'tenant-d']) cache.set(name, {});
  assert(cache.stats().entries <= 1, 'CACHE_MUST_RETAIN_NO_MORE_THAN_CAPACITY');
  assert.equal(cache.peek('tenant-a'), undefined);
  assert.equal(pinned.service, service, 'IN_FLIGHT_REFERENCE_MUST_REMAIN_VALID');
  await cache.close();
}

describe('bounded disposable API tenant cache', function () {
  it('bounds the retained records while keeping an evicted in-flight service usable', () => boundCriterion());

  it('control: removing eviction fails the same bound criterion, restored cache passes', async function () {
    await assert.rejects(boundCriterion(withoutEviction()), /CACHE_MUST_RETAIN_NO_MORE_THAN_CAPACITY/);
    await boundCriterion();
  });

  it('keeps the most recently touched record', async function () {
    const cache = createCache(options({ capacity: 2 }));
    const a = cache.set('a', {}), b = cache.set('b', {});
    assert.equal(cache.get('a'), a);
    cache.set('c', {});
    assert.equal(cache.peek('b'), undefined); assert.equal(cache.peek('a'), a);
    assert.notEqual(cache.peek('c'), b);
    await cache.close();
  });

  it('coalesces a miss and admits free build slots without a cold refusal', async function () {
    const cache = createCache(options()), record = cache.set('a', {}), gate = deferred();
    let built = 0;
    const first = cache.load(record, async () => { built++; await gate.promise; return { tenant: 'a' }; });
    const second = cache.load(record, () => assert.fail('coalesced builder must not run'));
    assert.equal(first, second);
    gate.resolve();
    assert.equal(await first, await second);
    assert.equal(await cache.load(record, () => assert.fail('cached builder must not run')), record.service);
    assert.equal(built, 1); assert.equal(cache.stats().active, 0); assert.equal(cache.stats().coalesced, 1);
    await cache.close();
  });

  it('waits for a build slot, preserves the waiting request context and bounds concurrent builds', async function () {
    const cache = createCache(options()), context = new AsyncLocalStorage(), gate = deferred();
    const selected = [];
    const a = context.run('a', () => cache.load(cache.set('a', {}), async () => { selected.push(context.getStore()); await gate.promise; return 'a'; }));
    const b = context.run('b', () => cache.load(cache.set('b', {}), async () => { selected.push(context.getStore()); return 'b'; }));
    assert.equal(cache.stats().active, 1); assert.equal(cache.stats().queued, 1);
    gate.resolve();
    assert.deepEqual(await Promise.all([a, b]), ['a', 'b']);
    assert.deepEqual(selected, ['a', 'b']); assert.equal(cache.stats().active, 0); assert.equal(cache.stats().queued, 0);
    await cache.close();
  });

  it('expires a bounded wait with typed overload and never executes expired work', async function () {
    const cache = createCache(options({ waitMs: 10 })), gate = deferred();
    const first = cache.load(cache.set('a', {}), () => gate.promise);
    const record = cache.set('b', {});
    await assert.rejects(cache.load(record, () => assert.fail('expired builder must not run')), error =>
      error.code === 'API_TENANT_BUILD_OVERLOADED' && error.retryAfter === 1);
    assert.equal(record.service, undefined); assert.equal(cache.stats().queued, 0); assert.equal(cache.stats().expired, 1);
    gate.resolve('a'); await first; await cache.close();
  });

  it('enforces the absolute queue deadline even when its timer callback is delayed', async function () {
    async function criterion (create = createCache) {
      const cache = create(options({ waitMs: 10 })), gate = deferred(); let ran = false;
      const first = cache.load(cache.set('a', {}), () => gate.promise);
      const second = cache.load(cache.set('b', {}), () => { ran = true; return 'b'; });
      const result = second.then(value => ({ value }), error => ({ error }));
      stall(30); gate.resolve('a'); await first;
      const settled = await result;
      try {
        assert.equal(ran, false, 'OVERDUE_BUILD_MUST_NOT_START');
        assert.equal(settled.error?.code, 'API_TENANT_BUILD_OVERLOADED');
        assert.equal(cache.stats().expired, 1); assert.equal(cache.stats().overloaded, 1);
        assert.equal(cache.stats().queued, 0); assert.equal(cache.stats().active, 0);
      } finally { await cache.close(); }
    }
    await criterion();
    await assert.rejects(criterion(withTimerOnlyDeadline()), /OVERDUE_BUILD_MUST_NOT_START/);
    await criterion();
  });

  it('drops elapsed queued work before admitting a fresh waiter and starts the fresh work next', async function () {
    const cache = createCache(options({ waitMs: 10, pendingLimit: 1 })), gate = deferred();
    const first = cache.load(cache.set('a', {}), () => gate.promise);
    const expired = cache.load(cache.set('b', {}), () => assert.fail('expired work must not run'));
    const refusal = assert.rejects(expired, { code: 'API_TENANT_BUILD_OVERLOADED' });
    stall(30);
    const fresh = cache.load(cache.set('c', {}), () => 'c');
    gate.resolve('a');
    assert.deepEqual(await Promise.all([first, fresh]), ['a', 'c']); await refusal;
    assert.equal(cache.stats().expired, 1); assert.equal(cache.stats().overloaded, 1);
    await cache.close();
  });

  it('settles elapsed queued work once when close happens before the delayed timer callback', async function () {
    const cache = createCache(options({ waitMs: 10 })), gate = deferred();
    const first = cache.load(cache.set('a', {}), () => gate.promise);
    const expired = cache.load(cache.set('b', {}), () => assert.fail('closed work must not run'));
    const rejected = assert.rejects(expired, { code: 'API_TENANT_BUILD_OVERLOADED' });
    stall(30); const closing = cache.close(); gate.resolve('a');
    await Promise.all([first, rejected, closing]);
    assert.equal(cache.stats().expired, 1); assert.equal(cache.stats().overloaded, 1);
    assert.equal(cache.stats().queued, 0); assert.equal(cache.stats().active, 0);
  });

  it('refuses excess queued work without admitting another build', async function () {
    const cache = createCache(options({ pendingLimit: 1 })), gate = deferred();
    const first = cache.load(cache.set('a', {}), () => gate.promise);
    const second = cache.load(cache.set('b', {}), () => 'b');
    await assert.rejects(cache.load(cache.set('c', {}), () => assert.fail('overload builder must not run')), { code: 'API_TENANT_BUILD_OVERLOADED' });
    assert.equal(cache.stats().active, 1); assert.equal(cache.stats().queued, 1);
    gate.resolve('a'); assert.deepEqual(await Promise.all([first, second]), ['a', 'b']);
    await cache.close();
  });

  it('does not publish a completed invalidated build over the replacement record', async function () {
    const cache = createCache(options({ concurrency: 2 })), gate = deferred();
    const old = cache.set('a', {});
    const pending = cache.load(old, async () => { await gate.promise; return { version: 1 }; });
    cache.delete('a'); const current = cache.set('a', {});
    const latest = await cache.load(current, () => ({ version: 2 }));
    gate.resolve(); const original = await pending;
    assert.equal(original.version, 1); assert.equal(latest.version, 2);
    assert.equal(cache.peek('a'), current); assert.equal(current.service, latest); assert.equal(old.service, original);
    await cache.close();
  });

  it('rebuilds from the current source after invalidation', async function () {
    async function criterion (invalidate) {
      const cache = createCache(options()); let value = 1;
      const read = () => cache.load(cache.get('a') || cache.set('a', {}), () => ({ value }));
      assert.equal((await read()).value, 1); value = 2;
      invalidate(cache);
      assert.equal((await read()).value, 2, 'INVALIDATION_MUST_DROP_OLD_SERVICE');
      await cache.close();
    }
    await criterion(cache => cache.delete('a'));
    await assert.rejects(criterion(() => {}), /INVALIDATION_MUST_DROP_OLD_SERVICE/);
    await criterion(cache => cache.delete('a'));
  });

  it('releases a failed build so the next demand can retry it', async function () {
    const cache = createCache(options()), record = cache.set('a', {}), expected = new Error('synthetic build failure');
    await assert.rejects(cache.load(record, () => { throw expected; }), error => error === expected);
    assert.equal(record.service, undefined);
    assert.equal(await cache.load(record, () => 'restored'), 'restored');
    assert.equal(cache.stats().failed, 1); await cache.close();
  });

  it('cancels queued work and drains active work on close', async function () {
    const cache = createCache(options()), gate = deferred();
    const active = cache.load(cache.set('a', {}), () => gate.promise);
    const queued = cache.load(cache.set('b', {}), () => assert.fail('closed queued builder must not run'));
    const rejected = assert.rejects(queued, { code: 'API_TENANT_CACHE_CLOSED' });
    let drained = false; const closing = cache.close().then(() => { drained = true; });
    await rejected; assert.equal(drained, false);
    gate.resolve('a'); await active; await closing;
    assert.equal(cache.stats().entries, 0); assert.equal(cache.stats().active, 0);
    await assert.rejects(cache.load({}, () => 'x'), { code: 'API_TENANT_CACHE_CLOSED' });
  });

  it('allows evicted loaded records and their services to be garbage collected', function () {
    const file = require.resolve('../lib/server/serve/api-tenant-cache');
    const source = `const assert=require('node:assert/strict'); const cache=require(${JSON.stringify(file)}).create(${JSON.stringify(options())});
      async function select(){let record=cache.set('a',{}); await cache.load(record,()=>({marker:'synthetic'}));return [new WeakRef(record),new WeakRef(record.service)];}
      (async()=>{const refs=await select();cache.set('b',{});for(let i=0;i<20;i++){await new Promise(setImmediate);global.gc();}assert.equal(refs[0].deref(),undefined,'EVICTED_RECORD_MUST_BE_COLLECTED');assert.equal(refs[1].deref(),undefined,'EVICTED_SERVICE_MUST_BE_COLLECTED');await cache.close();console.log('EVICTED_RECORD_AND_SERVICE_COLLECTED');})().catch(e=>{console.error(e);process.exitCode=1;});`;
    const result = spawnSync(process.execPath, ['--expose-gc', '-e', source], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /EVICTED_RECORD_AND_SERVICE_COLLECTED/);
  });
});

describe('API tenant cache environment configuration', function () {
  it('uses one registry capacity default and exposes independent build resource controls', function () {
    assert.deepEqual(settings.apiTenantCache({}, { capacity: 23 }), options({ capacity: 23, concurrency: 4, pendingLimit: 64 }));
    assert.deepEqual(settings.apiTenantCache({ NS_POOL_API_TENANT_CACHE_MAX: '2', NS_POOL_API_TENANT_BUILD_CONCURRENCY: '3',
      NS_POOL_API_TENANT_BUILD_QUEUE: '0', NS_POOL_API_TENANT_BUILD_WAIT_MS: '25' }, { capacity: 23 }),
    { capacity: 2, concurrency: 3, pendingLimit: 0, waitMs: 25 });
  });
  for (const name of ['NS_POOL_API_TENANT_CACHE_MAX', 'NS_POOL_API_TENANT_BUILD_CONCURRENCY', 'NS_POOL_API_TENANT_BUILD_WAIT_MS']) {
    it('rejects invalid ' + name, function () {
      for (const value of ['0', '-1', '1.5', ' 2', '02', 'unknown', '1000000000']) assert.throws(() => settings.apiTenantCache({ [name]: value }), error => error.code === 'PREVIEW_CONFIG_REFUSED' || error.message.includes(name));
    });
  }
  it('rejects invalid queue values', function () {
    for (const value of ['-1', '00', '2.5', '100001']) assert.throws(() => settings.apiTenantCache({ NS_POOL_API_TENANT_BUILD_QUEUE: value }), /NS_POOL_API_TENANT_BUILD_QUEUE/);
  });
});
