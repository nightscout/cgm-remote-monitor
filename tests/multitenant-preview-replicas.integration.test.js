'use strict';

// covers: lib/server/serve/preview-api.js, lib/server/serve/preview-config.js, lib/server/serve/preview-domains.js, lib/tenant-authorization/access-postgres.js, lib/server/tenant-app/data-access.js
// Single-host process interchangeability only. No Kubernetes, node-failure,
// shared-revision, exactly-once-event or durable-publication acceptance.
const assert = require('node:assert/strict');
const { optInSuite } = require('./support/opt-in');
const createFixture = require('./fixtures/multitenant-preview-replicas');
const grants = ['api:entries:read', 'api:entries:create', 'api:entries:update'];
const entry = (identifier, sgv) => ({ identifier, type: 'sgv', date: 1793664000000,
  utcOffset: 0, app: 'synthetic-replicas', sgv });

optInSuite(process.env.NS_MULTITENANT_PREVIEW_REPLICAS_DOCKER_TEST === '1',
  'NS_MULTITENANT_PREVIEW_REPLICAS_DOCKER_TEST=1')(
  'bounded multitenant REST CLI process behavior on one host', function () {
    this.timeout(120000);
    const fixture = createFixture();
    const [A, B] = fixture.tenants;
    const call = (...args) => fixture.http(...args);
    const changeGrants = permissions => fixture.admin.query(
      "UPDATE preview_auth.tenant_authorization_roles SET permissions=$1 WHERE tenant_id=$2 AND name='viewer'", [permissions, A]);
    const rows = async (tenant, identifier) => (await fixture.admin.query(
      "SELECT doc FROM preview_data.entries WHERE tenant_id=$1 AND doc->>'identifier'=$2", [tenant, identifier])).rows.map(row => row.doc);
    async function pair () {
      const first = fixture.start(), second = fixture.start();
      await fixture.ready(first); await fixture.ready(second);
      return [first, second];
    }
    before(() => fixture.setup());
    after(() => fixture.cleanup());
    afterEach(async () => {
      for (const worker of [...fixture.workers]) await fixture.stop(worker);
    });

    it('alternates committed outcomes and tenant isolation across two actual CLI processes', async function () {
      const [first, second] = await pair();
      const a = await fixture.localToken(A), b = await fixture.localToken(B);
      const cases = [[A, a, 121], [B, b, 181]];
      for (const [tenant, credential, value] of cases) {
        assert.equal((await call(first, tenant, 'POST', '/api/v3/entries', credential, entry('replica-overlap', value))).status, 201);
      }
      for (const [tenant, credential, value] of cases) {
        const read = await call(second, tenant, 'GET', '/api/v3/entries/replica-overlap', credential);
        assert.equal(read.status, 200);
        assert.equal(read.body.result.sgv, value, 'authenticated tenant must receive its own marker');
        assert.equal((await call(second, tenant, 'PATCH', '/api/v3/entries/replica-overlap', credential, { sgv: value + 1 })).status, 200);
        assert.equal((await call(first, tenant, 'GET', '/api/v3/entries/replica-overlap', credential)).body.result.sgv, value + 1);
        const stored = await rows(tenant, 'replica-overlap');
        assert.equal(stored.length, 1);
        assert.equal(stored[0].sgv, value + 1);
      }
      for (const worker of [first, second]) {
        assert.equal((await call(worker, B, 'GET', '/api/v3/entries/replica-overlap', a)).status, 401);
        assert.equal((await call(worker, A, 'GET', '/api/v1/tenant/settings', a)).status, 404);
      }
    });

    it('keeps legacy and new-token grants current across restart', async function () {
      const [first, second] = await pair();
      const local = await fixture.localToken(A);
      const old = await fixture.exchange(first, A);
      assert.equal(old.status, 200);
      const credentials = [local, old.body.token];
      for (const worker of [first, second]) for (const credential of credentials) {
        assert.equal((await call(worker, A, 'GET', '/api/v3/entries', credential)).status, 200);
      }
      await changeGrants(['denied']);
      try {
        for (const worker of [first, second]) for (const credential of credentials) {
          assert.equal((await call(worker, A, 'GET', '/api/v3/entries', credential)).status, 403,
            'already-warmed authority must observe the independently committed revocation');
          assert.equal((await call(worker, A, 'POST', '/api/v3/entries', credential, entry('replica-revoked', 199))).status, 403);
        }
        await fixture.stop(first);
        const replacement = fixture.start(); await fixture.ready(replacement);
        for (const credential of credentials) assert.equal((await call(replacement, A, 'GET', '/api/v3/entries', credential)).status, 403);
        const b = await fixture.localToken(B);
        assert.equal((await call(second, B, 'GET', '/api/v3/entries', b)).status, 200, 'other tenant remains authorized');
        assert.equal((await rows(A, 'replica-revoked')).length, 0);
      } finally { await changeGrants(grants); }
      for (const worker of fixture.workers) for (const credential of credentials) {
        assert.equal((await call(worker, A, 'GET', '/api/v3/entries', credential)).status, 200, 'restored current authority is reacquired');
      }
    });

    it('preserves committed writes across a killed post-commit pre-response process and reports retry semantics', async function () {
      const first = fixture.start(undefined, {}, { holdResponse: true }), second = fixture.start();
      await fixture.ready(first); await fixture.ready(second);
      const token = await fixture.localToken(A), identifier = 'replica-ambiguous-response';
      let responseReceived = false;
      // Attach rejection immediately: killing the worker deliberately breaks HTTP.
      const request = call(first, A, 'POST', '/api/v3/entries', token, entry(identifier, 131))
        .then(response => { responseReceived = true; return { response }; }, error => ({ error }));
      await fixture.until(async () => first.stdout.includes('REPLICA_POSTCOMMIT_RESPONSE_HELD'), 'actual handler response barrier');
      const committed = await rows(A, identifier);
      assert.equal(committed.length, 1, 'independent PG connection observes the actual committed row');
      assert.equal(committed[0].sgv, 131);
      assert.equal(responseReceived, false, 'success response remains withheld');
      await fixture.kill(first);
      const interrupted = await request;
      assert.ok(interrupted.error, 'client sees transport failure after the committed write');
      const read = await call(second, A, 'GET', '/api/v3/entries/' + identifier, token);
      assert.equal(read.status, 200); assert.equal(read.body.result.sgv, 131);
      const retried = await call(second, A, 'POST', '/api/v3/entries', token, entry(identifier, 131));
      assert.equal(retried.status, 200, 'existing-identifier resend returns existing/replaced outcome');
      assert.equal((await rows(A, identifier)).length, 1, 'identifier retry does not insert a second stored row');
      assert.equal((await rows(B, identifier)).length, 0);
      const replacement = fixture.start(); await fixture.ready(replacement);
      assert.equal((await call(replacement, A, 'GET', '/api/v3/entries/' + identifier, token)).body.result.sgv, 131);
      // No assertion about event count/history deduplication or durable delivery:
      // the shipping resend policy may stamp/announce a replacement on retry.
    });

    it('characterizes a history-cursor gap from process-local clocks under controlled time', async function () {
      // Characterization of an unresolved limit, not a statelessness acceptance:
      // freeze only srv-dates.js Date.now calls, retaining its actual allocator.
      const clock = String(Date.now() + 3600000);
      const options = { NS_PREVIEW_REPLICA_CONTROL: 'history-clock', NS_PREVIEW_REPLICA_CLOCK_MS: clock };
      const first = fixture.start(undefined, options), second = fixture.start(undefined, options);
      await fixture.ready(first); await fixture.ready(second);
      const token = await fixture.localToken(A);
      const foreignBefore = (await fixture.admin.query('SELECT doc FROM preview_data.entries WHERE tenant_id=$1 ORDER BY doc::text', [B])).rows;
      const one = 'replica-clock-one', two = 'replica-clock-two';
      assert.equal((await call(first, A, 'POST', '/api/v3/entries', token, entry(one, 151))).status, 201);
      const firstStored = (await rows(A, one))[0];
      // The cursor is obtained after the first actual write and before the second.
      const initial = await call(first, A, 'GET', '/api/v3/entries/history/' + (firstStored.srvModified - 1), token);
      assert.equal(initial.status, 200);
      assert.ok(initial.body.result.some(doc => doc.identifier === one));
      assert.equal((await call(second, A, 'POST', '/api/v3/entries', token, entry(two, 152))).status, 201);
      const secondStored = (await rows(A, two))[0];
      assert.equal(firstStored.srvModified, Number(clock), 'scoped fixture clock reached the actual first allocator');
      assert.equal(secondStored.srvModified, firstStored.srvModified, 'already-running replica allocators can stamp equal cursors');
      const missedByProcesses = [];
      for (const worker of [first, second]) {
        const history = await call(worker, A, 'GET', '/api/v3/entries/history/' + firstStored.srvModified, token);
        assert.equal(history.status, 200);
        missedByProcesses.push(!history.body.result.some(doc => doc.identifier === two));
        assert.equal(history.body.result.some(doc => doc.identifier === two), false,
          'strict greater-than history misses the later committed second record at the same stamp');
        assert.equal((await call(worker, A, 'GET', '/api/v3/entries/' + two, token)).body.result.sgv, 152,
          'record persists and is addressable despite history gap');
      }
      assert.equal((await call(first, A, 'POST', '/api/v3/entries', token, entry('replica-clock-single-next', 153))).status, 201);
      const sameProcess = (await rows(A, 'replica-clock-single-next'))[0];
      assert.equal(sameProcess.srvModified, firstStored.srvModified + 1, 'same process advances the actual allocator');
      const sameHistory = await call(second, A, 'GET', '/api/v3/entries/history/' + firstStored.srvModified, token);
      assert.ok(sameHistory.body.result.some(doc => doc.identifier === 'replica-clock-single-next'));
      await fixture.stop(second);
      const replacement = fixture.start(undefined, options); await fixture.ready(replacement);
      assert.equal((await call(replacement, A, 'POST', '/api/v3/entries', token, entry('replica-clock-restart-next', 154))).status, 201);
      assert.equal((await rows(A, 'replica-clock-restart-next'))[0].srvModified, sameProcess.srvModified + 1,
        'restarted process hydrates persisted latest timestamp before allocating');
      assert.deepEqual((await fixture.admin.query('SELECT doc FROM preview_data.entries WHERE tenant_id=$1 ORDER BY doc::text', [B])).rows,
        foreignBefore, 'other tenant state is unchanged by the clock characterization');
      console.log('REPLICA_HISTORY_OBSERVATION ' + JSON.stringify({
        first: firstStored.srvModified, second: secondStored.srvModified,
        sameProcessNext: sameProcess.srvModified,
        restartNext: (await rows(A, 'replica-clock-restart-next'))[0].srvModified,
        missedByProcesses, addressedReadPassed: true, foreignTenantUnchanged: true
      }));
    });

    it('refuses schema-ledger drift before either process binds', async function () {
      const ledger = (await fixture.admin.query('SELECT name, checksum FROM preview_data.schema_migrations ORDER BY name LIMIT 1')).rows[0];
      assert.ok(ledger);
      await fixture.admin.query("UPDATE preview_data.schema_migrations SET checksum='replica-test-drift' WHERE name=$1", [ledger.name]);
      try {
        await fixture.refused(fixture.configuration());
        await fixture.refused(fixture.configuration());
      } finally {
        await fixture.admin.query('UPDATE preview_data.schema_migrations SET checksum=$1 WHERE name=$2', [ledger.checksum, ledger.name]);
      }
      const [first, second] = await pair();
      const token = await fixture.localToken(A);
      for (const worker of [first, second]) assert.equal((await call(worker, A, 'GET', '/api/v3/entries', token)).status, 200);
    });
  });
