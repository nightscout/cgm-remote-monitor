'use strict';

// Actual API process semantics. Evaluator/realtime/owner peers are synthetic
// lifecycle-only participants; full-role network binding is separate acceptance.
const assert = require('node:assert/strict'), fs = require('node:fs');
const { optInSuite } = require('./support/opt-in');
const createFixture = require('./fixtures/api-fixed-roster-serving');
const cohorts = require('../lib/server/serve/operation-cohort');
const manifests = require('../lib/server/serve/operation-cohort-manifest');
const maintenance = require('../lib/tenant-lifecycle/maintenance-window');
const entry = identifier => ({ identifier, type: 'sgv', date: Date.now(), utcOffset: 0, app: 'synthetic-roster', sgv: 125 });
optInSuite(process.env.NS_API_ROSTER_SERVING_DOCKER_TEST === '1', 'NS_API_ROSTER_SERVING_DOCKER_TEST=1')(
  'fixed roster with two actual API CLI processes and real lifetime leases', function () {
    this.timeout(120000);
    const f = createFixture(), [A, B] = f.base.tenants;
    const call = (id, tenant, method, path, token, body, headers) => f.base.http(id === 'service' ? f.serviceWorker : f.current.get(id), tenant, method, path, token, body, headers);
    const stored = identifier => f.withAdmin(async admin => (await admin.query("SELECT tenant_id::text,doc FROM preview_data.entries WHERE doc->>'identifier'=$1", [identifier])).rows);
    let a, b;
    before(async () => { await f.setup(); a = await f.base.localToken(A); b = await f.base.localToken(B); });
    after(() => f.cleanup());

    it('shares stored outcomes and current authority through both direct replicas and the service', async function () {
      const grants = ['api:entries:read', 'api:entries:create', 'api:entries:update'];
      assert.equal((await call('api-1', A, 'POST', '/api/v3/entries', a, entry('native-replica-marker'))).status, 201);
      assert.equal((await call('api-2', A, 'GET', '/api/v3/entries/native-replica-marker', a)).body.result.sgv, 125);
      for (let i = 0; i < 4; i++) assert.equal((await call('service', A, 'GET', '/api/v3/entries', a)).status, 200);
      assert(f.calls.get('api-1') >= 2 && f.calls.get('api-2') >= 2, 'service reaches both actual API processes');
      await f.withAdmin(admin => admin.query("UPDATE preview_auth.tenant_authorization_roles SET permissions=ARRAY['denied'] WHERE tenant_id=$1 AND name='viewer'", [A]));
      try {
        for (const id of ['api-1', 'api-2', 'service']) {
          assert.equal((await call(id, A, 'GET', '/api/v3/entries', a)).status, 403, 'CURRENT_REPLICA_REVOKE');
          assert.equal((await call(id, A, 'POST', '/api/v3/entries', a, entry('native-replica-denied'))).status, 403);
          assert.equal((await call(id, B, 'GET', '/api/v3/entries', b)).status, 200);
          assert.equal((await call(id, B, 'GET', '/api/v3/entries', a)).status, 401, 'foreign tenant token cannot follow routing');
        }
        assert.equal((await stored('native-replica-denied')).length, 0);
      } finally { await f.withAdmin(admin => admin.query("UPDATE preview_auth.tenant_authorization_roles SET permissions=$1 WHERE tenant_id=$2 AND name='viewer'", [grants, A])); }
    });

    it('refuses a fixed-roster API without the shared clock before opening any listener', async function () {
      const refused = await f.refusedWithoutClock('api-1');
      assert.match(refused.stderr, /API_REPLICAS_REQUIRE_WRITE_CLOCK/);
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

    it('refuses omitted real API backends and service-aliased participants before suspending A', async function () {
      const original = f.participants;
      const variants = [
        original.filter(peer => peer.id !== 'api-2'),
        original.map(peer => peer.id !== 'api-2' ? peer : { ...peer, endpoint: { ...peer.endpoint,
          url: original[0].endpoint.url.replace('127.0.0.2', '127.0.0.4') } })
      ];
      for (const [index, rows] of variants.entries()) {
        let remote, window, entered = false;
        try {
          await assert.rejects((async () => {
            remote = await cohorts.createRemote({ namespace: f.namespace, tenants: [A, B], participants: manifests.validate(rows) });
            window = maintenance.create({ namespace: f.namespace, locks: f.locks, pool: f.operatorPool, cohort: remote, drainTimeoutMs: 5000 });
            return window.withRestore(A, { artifactDigest: 'd'.repeat(64) }, async () => { entered = true; });
          })(),
            error => index === 0 ? error.code === 'RESTORE_COHORT_UNKNOWN_BACKEND' : ['RESTORE_COHORT_PROTOCOL', 'RESTORE_COHORT_PARTICIPANT_CHANGED'].includes(error.code));
          assert.equal(entered, false);
          const phase = await f.withAdmin(async admin => (await admin.query('SELECT phase FROM preview_control.tenant_lifecycle_windows WHERE tenant_id=$1', [A])).rows[0].phase);
          assert.equal(phase, 'active');
        } finally { if (window) await window.close(); if (remote) await remote.close(); }
      }
    });

    it('holds A maintenance until its post-commit response finishes while B continues on the other replica', async function () {
      let responseDone = false, entered = false;
      const pending = call('api-1', A, 'POST', '/api/v3/entries', a, entry('native-held-A'), { 'x-roster-hold': 'postcommit' })
        .then(value => { responseDone = true; return { value }; }, error => ({ error }));
      await f.base.until(async () => fs.existsSync(f.mark('held', 'api-1')), 'actual post-commit response held');
      assert.equal((await stored('native-held-A')).length, 1, 'independent storage sees committed write before response');
      const restoring = f.restore(async () => { entered = true; return 'bounded-restore-body'; });
      const outcome = restoring.then(value => ({ value }), error => ({ error }));
      try {
        await f.base.until(async () => (await call('api-2', A, 'GET', '/api/v3/entries', a)).status !== 200, 'A serving refusal during maintenance');
        assert.equal(entered, false, 'HELD_RESPONSE_BLOCKS_RESTORE'); assert.equal(responseDone, false);
        assert.equal((await call('api-2', B, 'POST', '/api/v3/entries', b, entry('native-B-progress'))).status, 201);
        assert.equal((await call('service', B, 'GET', '/api/v3/entries/native-B-progress', b)).status, 200);
      } finally { f.current.get('api-1').child.kill('SIGUSR2'); }
      const response = await pending, restored = await outcome;
      assert.equal(response.error, undefined); assert.equal(response.value.status, 201);
      assert.equal(restored.error, undefined, restored.error && restored.error.code);
      assert.equal(restored.value.state, 'activated'); assert.equal(entered, true);
      for (const id of ['api-1', 'api-2']) assert.equal((await call(id, A, 'GET', '/api/v3/entries', a)).status, 200);
      assert.equal((await stored('native-B-progress'))[0].tenant_id, B);
    });

    it('rejects a replaced actual API incarnation under its old pin, and accepts a fresh pin', async function () {
      const client = await f.operatorPool.connect(); let pin;
      try {
        pin = await cohorts.pin(f.cohort, A, { client });
        await f.base.stop(f.current.get('api-2')); await f.start('api-2');
        await assert.rejects(cohorts.assertComplete(f.cohort, A, { client }), { code: 'RESTORE_COHORT_PARTICIPANT_CHANGED' });
        await cohorts.releasePin(pin); pin = null;
        pin = await cohorts.pin(f.cohort, A, { client });
        await cohorts.assertComplete(f.cohort, A, { client });
      } finally { if (pin) await cohorts.releasePin(pin); client.release(); }
      assert.equal((await call('api-2', B, 'GET', '/api/v3/entries', b)).status, 200);
    });

    it('bounds aggregate operation/data pools under concurrent service traffic', async function () {
      const results = await Promise.all(Array.from({ length: 16 }, () => call('service', B, 'GET', '/api/v3/entries', b)));
      assert(results.every(result => result.status === 200));
      const observed = await f.withAdmin(async admin => (await admin.query(`SELECT application_name,count(*)::integer AS connections
        FROM pg_stat_activity WHERE datname=current_database() AND application_name IN ('nightscout-operation-lifetime','nightscout-preview-data') GROUP BY application_name`)).rows);
      for (const row of observed) assert(row.connections > 0 && row.connections <= 4, 'two replicas, each configured with pool maximum 2: ' + JSON.stringify(row));
      assert.equal(observed.length, 2);
      process.stdout.write('FIXED_ROSTER_POOL_OBSERVED ' + JSON.stringify(observed) + '\n');
    });

    it('control: prematurely finishing the real response lifetime makes the held-response drain oracle red', async function () {
      fs.rmSync(f.mark('held', 'api-1'), { force: true });
      let entered = false, responseDone = false;
      const pending = call('api-1', A, 'POST', '/api/v3/entries', a, entry('native-early-release'),
        { 'x-roster-hold': 'postcommit', 'x-roster-release-lifetime': '1' }).then(value => { responseDone = true; return { value }; }, error => ({ error }));
      await f.base.until(async () => fs.existsSync(f.mark('held', 'api-1')), 'early lifetime control applied');
      try {
        const result = await f.restore(async () => { entered = true; return 'early-release-control'; });
        assert.equal(result.state, 'activated'); assert.equal(entered, true); assert.equal(responseDone, false, 'actual success response still withheld');
        assert.throws(() => assert.equal(entered, false, 'HELD_RESPONSE_BLOCKS_RESTORE'), /HELD_RESPONSE_BLOCKS_RESTORE/);
      } finally { f.current.get('api-1').child.kill('SIGUSR2'); }
      const response = await pending;
      assert.equal(response.error, undefined); assert.equal(response.value.status, 201);
    });

    it('preserves a committed B write after killing its actual API before the success response', async function () {
      fs.rmSync(f.mark('held', 'api-1'), { force: true });
      const pending = call('api-1', B, 'POST', '/api/v3/entries', b, entry('native-commit-without-ack'),
        { 'x-roster-hold': 'postcommit' }).then(value => ({ value }), error => ({ error }));
      await f.base.until(async () => fs.existsSync(f.mark('held', 'api-1')), 'committed write response held');
      assert.equal((await stored('native-commit-without-ack')).length, 1);
      await f.base.kill(f.current.get('api-1'));
      assert((await pending).error, 'caller sees an uncertain transport failure, not synthetic success');
      assert.equal((await call('api-2', B, 'GET', '/api/v3/entries/native-commit-without-ack', b)).status, 200);
      assert.equal((await stored('native-commit-without-ack')).length, 1, 'no transparent automatic mutation replay');
      await f.start('api-1');
      assert.equal((await call('api-1', B, 'GET', '/api/v3/entries/native-commit-without-ack', b)).status, 200);
    });

    it('keeps A suspended after losing a completed invalidation reply while B remains available', async function () {
      fs.writeFileSync(f.mark('drop-invalidation', 'api-2'), 'once', { mode: 0o600 });
      await assert.rejects(f.restore(async () => 'restore-completed'), /SOCKET_IPC_UNAVAILABLE/);
      assert.equal(fs.readFileSync(f.mark('lost-invalidation', 'api-2'), 'utf8'), 'handler-completed');
      const phase = await f.withAdmin(async admin => (await admin.query('SELECT phase FROM preview_control.tenant_lifecycle_windows WHERE tenant_id=$1', [A])).rows[0].phase);
      assert.equal(phase, 'suspended', 'LOST_INVALIDATION_REPLY_MUST_NOT_ACTIVATE');
      for (const id of ['api-1', 'api-2']) {
        assert.notEqual((await call(id, A, 'GET', '/api/v3/entries', a)).status, 200);
        assert.equal((await call(id, B, 'GET', '/api/v3/entries', b)).status, 200);
      }
    });
  });
