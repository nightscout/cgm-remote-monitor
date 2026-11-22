'use strict';

const assert = require('node:assert/strict');
const generation = require('../lib/tenant-lifecycle/generation-scope');
const { optInSuite } = require('./support/opt-in');
// Either arm of NS_EVAL_FEWER_ROUNDTRIPS.
const fewerRoundTrips = process.env.NS_EVAL_FEWER_ROUNDTRIPS === '1';

optInSuite(process.env.NS_OPERATION_WINDOW_MINIMUM_DOCKER_TEST === '1', 'disposable PostgreSQL')(
  'serving tenant generation across restore', function () {
    this.timeout(120000);
    const fixture = require('./fixtures/operation-window-minimum-native').create({receiptPrefix:'generation-'});
    before(() => fixture.start());
    after(() => fixture.close());
    it('rebuilds the changed tenant cache once before admitting overlapping scopes', async () => {
      const {A, B, locks} = fixture, cache = new Map(), invalidated = [];
      const pool = fixture.freshPool('lifetime_api');
      let release, started;
      const barrier = new Promise(resolve => { release = resolve; });
      const entered = new Promise(resolve => { started = resolve; });
      const scope = generation.create({namespace:fixture.ns.control, locks, pool, fewerRoundTrips,
        async invalidate(tenant) {
          invalidated.push(tenant);
          started();
          await barrier;
          cache.delete(tenant);
        }
      });
      const warm = tenant => scope.run(tenant, () => {
        if (!cache.has(tenant)) cache.set(tenant, scope.currentGeneration(tenant));
        return cache.get(tenant);
      });
      let left, right;
      try {
        await scope.ready();
        const [old, neighbour] = await Promise.all([warm(A),warm(B)]);
        const changed = (await fixture.sql('UPDATE ' + fixture.control('tenant_lifecycle_windows') +
          ' SET generation=generation+1 WHERE tenant_id=$1 RETURNING generation::text', [A])).rows[0].generation;
        assert.notEqual(changed, old);
        left = warm(A); right = warm(A);
        await Promise.race([entered, left.then(() => assert.fail('STALE_CACHE_ADMITTED'))]);
        assert.equal(await warm(B), neighbour);
        release();
        assert.deepEqual(await Promise.all([left,right]), [changed,changed]);
        assert.deepEqual(invalidated,[A]);
      } finally {
        release();
        await Promise.allSettled([left,right]);
        await scope.close(); await pool.end();
      }
    });
    it('keeps old scopes withdrawn when local cache retirement fails, then retries the new generation', async () => {
      const {A, locks} = fixture;
      const pool = fixture.freshPool('lifetime_api');
      const oldEntered = Promise.withResolvers(), checkOld = Promise.withResolvers();
      let attempts = 0;
      const scope = generation.create({namespace:fixture.ns.control, locks, pool, fewerRoundTrips, async invalidate() {
        if (++attempts === 1) throw new Error('TEST_CACHE_RETIREMENT_FAILED');
      }});
      const old = scope.run(A, async () => {
        oldEntered.resolve();
        await checkOld.promise;
        assert.throws(() => scope.currentGeneration(A), {code:'LIFECYCLE_WINDOW_SUSPENDED'});
      });
      try {
        await oldEntered.promise;
        const changed = (await fixture.sql('UPDATE ' + fixture.control('tenant_lifecycle_windows') +
          ' SET generation=generation+1 WHERE tenant_id=$1 RETURNING generation::text', [A])).rows[0].generation;
        await assert.rejects(scope.run(A, () => assert.fail('STALE_CACHE_ADMITTED')), /TEST_CACHE_RETIREMENT_FAILED/);
        checkOld.resolve();
        await old;
        assert.equal(await scope.run(A, () => scope.currentGeneration(A)), changed);
        assert.equal(attempts, 2);
      } finally {
        checkOld.resolve();
        await Promise.allSettled([old]);
        await scope.close();
        await pool.end();
      }
    });
  });
