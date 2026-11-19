'use strict';

// Two API CLI processes serve direct requests and share a round-robin HTTP listener.
const assert = require('node:assert/strict'), fs = require('node:fs');
const { optInSuite } = require('./support/opt-in');
const createFixture = require('./fixtures/api-fixed-roster-serving');
const entry = identifier => ({ identifier, type: 'sgv', date: Date.now(), utcOffset: 0, app: 'synthetic-roster', sgv: 125 });
optInSuite(process.env.NS_API_ROSTER_SERVING_DOCKER_TEST === '1', 'NS_API_ROSTER_SERVING_DOCKER_TEST=1')(
  'fixed roster with two actual API CLI processes and tenant transaction fences', function () {
    this.timeout(120000);
    const f = createFixture({ drainTimeoutMs: 500 }), [A, B] = f.base.tenants;
    const call = (id, tenant, method, path, token, body, headers) => f.base.http(id === 'service' ? f.serviceWorker : f.current.get(id), tenant, method, path, token, body, headers);
    const stored = identifier => f.withAdmin(async admin => (await admin.query("SELECT tenant_id::text,doc FROM preview_entries.entries WHERE doc->>'identifier'=$1", [identifier])).rows);
    let a, b;
    before(async () => { await f.setup(); a = await f.base.localToken(A); b = await f.base.localToken(B); });
    after(() => f.cleanup());

    it('shares stored outcomes and current authority through both direct replicas and the service', async function () {
      const grants = ['api:entries:read', 'api:entries:create', 'api:entries:update'];
      assert.equal((await call('api-1', A, 'POST', '/api/v3/entries', a, entry('native-replica-marker'))).status, 201);
      assert.equal((await call('api-2', A, 'GET', '/api/v3/entries/native-replica-marker', a)).body.result.sgv, 125);
      for (let i = 0; i < 4; i++) assert.equal((await call('service', A, 'GET', '/api/v3/entries', a)).status, 200);
      assert(f.calls.get('api-1') >= 2 && f.calls.get('api-2') >= 2, 'service reaches both actual API processes');
      await f.withAdmin(admin => admin.query("UPDATE preview_authorization.tenant_authorization_roles SET permissions=ARRAY['denied'] WHERE tenant_id=$1 AND name='viewer'", [A]));
      try {
        for (const id of ['api-1', 'api-2', 'service']) {
          assert.equal((await call(id, A, 'GET', '/api/v3/entries', a)).status, 403, 'CURRENT_REPLICA_REVOKE');
          assert.equal((await call(id, A, 'POST', '/api/v3/entries', a, entry('native-replica-denied'))).status, 403);
          assert.equal((await call(id, B, 'GET', '/api/v3/entries', b)).status, 200);
          assert.equal((await call(id, B, 'GET', '/api/v3/entries', a)).status, 401, 'foreign tenant token cannot follow routing');
        }
        assert.equal((await stored('native-replica-denied')).length, 0);
      } finally { await f.withAdmin(admin => admin.query("UPDATE preview_authorization.tenant_authorization_roles SET permissions=$1 WHERE tenant_id=$2 AND name='viewer'", [grants, A])); }
    });

    it('refuses API startup when its readiness identity cannot read the shared clock catalogue', async function () {
      const refused = await f.refusedWithoutClock('api-1');
      assert.match(refused.stderr, /preview startup failed/);
      assert.doesNotMatch(refused.stdout, /Listening/);
    });

    it('uses the shared write clock so a later replica write appears after the prior client history cursor', async function () {
      const firstId = 'native-clock-first', secondId = 'native-clock-second';
      assert.equal((await call('api-1', A, 'POST', '/api/v3/entries', a, entry(firstId))).status, 201);
      const first = (await stored(firstId))[0].doc;
      assert.equal((await call('api-2', A, 'POST', '/api/v3/entries', a, entry(secondId))).status, 201);
      const second = (await stored(secondId))[0].doc;
      assert(second.srvModified > first.srvModified, 'CLOCK_ENABLED_REPLICAS_MONOTONIC');
      for (const id of ['api-1', 'api-2', 'service']) {
        const history = await call(id, A, 'GET', '/api/v3/entries/history/' + first.srvModified, a);
        assert.equal(history.status, 200);
        assert(history.body.result.some(doc => doc.identifier === secondId), 'CLOCK_ENABLED_HISTORY_CONVERGES: ' + id);
        assert.equal((await call(id, B, 'GET', '/api/v3/entries/' + secondId, b)).status, 404);
      }
      process.stdout.write('FIXED_ROSTER_CLOCK_ENABLED ' + JSON.stringify({ first: first.srvModified, second: second.srvModified, allDestinationsConverged: true }) + '\n');
    });

    it('restores A while its pre-restore HTTP success is held and B continues', async function () {
      let responseDone = false;
      const pending = call('api-1', A, 'POST', '/api/v3/entries', a, entry('native-held-A'), { 'x-roster-hold': 'postcommit' })
        .then(value => { responseDone = true; return { value }; }, error => { responseDone = true; return { error }; });
      try {
        await f.base.until(async () => fs.existsSync(f.mark('held', 'api-1')), 'actual post-commit response held');
        assert.equal((await stored('native-held-A')).length, 1);
        const before = await f.restoreState();
        const restored = await f.restore(async () => {
          assert.equal(responseDone, false, 'HTTP_SUCCESS_STILL_HELD');
          assert.equal((await call('api-2', A, 'POST', '/api/v3/entries', a, entry('native-refused-A'))).status, 503);
          assert.equal((await call('api-2', B, 'POST', '/api/v3/entries', b, entry('native-B-progress'))).status, 201);
        });
        assert.equal(restored.state, 'activated');
        assert.equal(BigInt(restored.generation), BigInt(before.generation) + 1n);
        assert.equal(responseDone, false, 'RESTORE_FINISHED_BEFORE_HTTP_SUCCESS');
      } finally { f.current.get('api-1').child.kill('SIGUSR2'); }
      const response = await pending;
      assert.equal(response.error, undefined);
      assert.equal(response.value.status, 201);
      assert.equal((await stored('native-refused-A')).length, 0);
      for (const id of ['api-1', 'api-2']) assert.equal((await call(id, A, 'GET', '/api/v3/entries', a)).status, 200);
      assert.equal((await stored('native-B-progress'))[0].tenant_id, B);
    });

    for (const version of ['v1', 'v3']) {
      it('returns retryable HTTP status and rolls back a crossing ' + version + ' write', async function () {
        const id = 'native-crossing-' + version, path = '/api/' + version + '/entries';
        const payload = entry(id), body = version === 'v1' ? [payload] : payload;
        const arm = f.mark('arm-write', 'api-1'), held = f.mark('held-write', 'api-1');
        fs.rmSync(held, { force: true });
        fs.writeFileSync(arm, 'hold', { flag: 'wx', mode: 0o600 });
        const pending = call('api-1', A, 'POST', path, a, body);
        let restoration, exclusive;
        const release = () => f.current.get('api-1').child.kill('SIGUSR2');
        const observe = client => {
          const query = client.query;
          client.query = function (...args) {
            const result = query.apply(this, args);
            if (!args[0]?.text?.includes('restore-exclusive-acquire')) return result;
            this.query = query;
            return result.then(value => { exclusive = value.rows[0].held; release(); return value; });
          };
        };
        try {
          await Promise.race([
            f.base.until(() => fs.existsSync(held), 'actual SQL write is held before COMMIT'),
            pending.then(reply => { throw new Error('API write finished before the INSERT barrier with HTTP ' + reply.status); })
          ]);
          f.operatorPool.once('acquire', observe);
          restoration = f.restore(async () => {});
          const [reply, outcome] = await Promise.all([pending, restoration]);
          assert.equal(exclusive, false, 'restore saw the in-flight tenant transaction');
          assert.equal(outcome.state, 'activated');
          assert.equal(reply.status, 503, 'RESTORE_CROSSING_HTTP_STATUS');
          assert.equal(reply.headers['retry-after'], '1', 'RESTORE_CROSSING_HTTP_RETRY_AFTER');
          assert.equal((await stored(id)).length, 0);
          const retry = await call('api-1', A, 'POST', path, a, body);
          assert.equal(retry.status, version === 'v1' ? 200 : 201);
          assert.equal((await stored(id)).length, 1);
        } finally {
          f.operatorPool.removeListener('acquire', observe);
          release();
          await Promise.allSettled([pending, restoration]);
          fs.rmSync(arm, { force: true });
        }
      });
    }

    it('bounds aggregate operation/data pools under concurrent service traffic', async function () {
      const results = await Promise.all(Array.from({ length: 16 }, () => call('service', B, 'GET', '/api/v3/entries', b)));
      assert(results.every(result => result.status === 200));
      const observed = await f.withAdmin(async admin => (await admin.query(`SELECT application_name,count(*)::integer AS connections
        FROM pg_stat_activity WHERE datname=current_database() AND application_name IN ('nightscout-operation-lifetime','nightscout-preview-data') GROUP BY application_name`)).rows);
      for (const row of observed) assert(row.connections > 0 && row.connections <= 4, 'two replicas, each configured with pool maximum 2: ' + JSON.stringify(row));
      assert.equal(observed.length, 2);
      process.stdout.write('FIXED_ROSTER_POOL_OBSERVED ' + JSON.stringify(observed) + '\n');
    });

    it('preserves a committed B write after killing its actual API before the success response', async function () {
      fs.rmSync(f.mark('held', 'api-1'), { force: true });
      const pending = call('api-1', B, 'POST', '/api/v3/entries', b, entry('native-commit-without-ack'),
        { 'x-roster-hold': 'postcommit' }).then(value => ({ value }), error => ({ error }));
      try {
        await f.base.until(async () => fs.existsSync(f.mark('held', 'api-1')), 'committed write response held');
        assert.equal((await stored('native-commit-without-ack')).length, 1);
        await f.base.kill(f.current.get('api-1'));
        assert((await pending).error, 'caller sees an uncertain transport failure, not synthetic success');
      } finally { if (!f.current.get('api-1').exit) f.current.get('api-1').child.kill('SIGUSR2'); await pending; }
      assert.equal((await call('api-2', B, 'GET', '/api/v3/entries/native-commit-without-ack', b)).status, 200);
      assert.equal((await stored('native-commit-without-ack')).length, 1, 'no transparent automatic mutation replay');
      await f.start('api-1', { readinessTenant: B });
      assert.equal((await call('api-1', B, 'GET', '/api/v3/entries/native-commit-without-ack', b)).status, 200);
    });

    it('reopens A while one replica is offline and serves the new generation on its return', async function () {
      await f.base.stop(f.current.get('api-2'));
      f.current.delete('api-2');
      const restored = await f.restore(async () => {});
      assert.equal(restored.state, 'activated');
      assert.equal((await call('api-1', B, 'GET', '/api/v3/entries', b)).status, 200);
      await f.start('api-2');
      assert.equal((await call('api-2', A, 'GET', '/api/v3/entries', a)).status, 200);
    });
  });
