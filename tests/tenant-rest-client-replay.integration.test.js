'use strict';

const assert = require('node:assert/strict');
const fixture = require('./fixtures/client-replay-http');
const patterns = require('./fixtures/client-replay-patterns');
const { optInSuite } = require('./support/opt-in');

optInSuite(process.env.NS_REST_CLIENT_REPLAY_TEST === '1',
  'NS_REST_CLIENT_REPLAY_TEST=1 with Docker for disposable PostgreSQL/Vault')(
  'Pinned synthetic NightscoutKit uploader and LoopFollow follower HTTP replay', function () {
    this.timeout(120000);
    const lab = fixture();
    let worker;
    const domains = ['entries', 'treatments', 'devicestatus', 'profile'];
    before(() => lab.open());
    beforeEach(async function () {
      await lab.reset();
      worker = lab.start();
      await lab.ready(worker);
    });
    afterEach(async function () { if (worker && worker.port) await lab.stop(worker); worker = null; });
    after(() => lab.close());

    // The pinned uploader hashes its API secret and sends api-secret; the pinned
    // follower sends its subject token in the query. These are distinct dialects.
    const upload = (domain, body, tenant = lab.A, method = 'POST') =>
      lab.http(worker, tenant, method, '/api/v1/' + domain, undefined, body,
        { 'api-secret': lab.rootCredential(tenant) });
    async function fill (tenant = lab.A, index = 0) {
      const docs = patterns.documents(index);
      for (const domain of domains) patterns.consumeUpload(await upload(domain, docs[domain], tenant), docs[domain].length);
      return docs;
    }
    const follower = (domain, tenant = lab.A, version = 1) => lab.http(worker, tenant, 'GET',
      patterns.followerPath(domain, lab.credential(tenant), version));

    it('requeues unchanged entry, treatment and device arrays after a simulated lost response without duplicate rows', async function () {
      const docs = await fill();
      for (const domain of domains.filter(value => value !== 'profile')) {
        const before = await lab.rows(domain);
        // Response loss is simulated after a successful server commit. No real
        // network fault or Swift retry scheduler is claimed by this replay.
        const reply = await upload(domain, docs[domain]);
        const returned = patterns.consumeUpload(reply, docs[domain].length);
        assert.deepEqual(returned, before.map(doc => doc._id), domain + ' retry consumes stable IDs');
        const after = await lab.rows(domain);
        const logical = rows => rows.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'srvModified')));
        // Shipping shared write-intent restamps successful legacy resends.
        assert.deepEqual(logical(after), logical(before), domain + ' retry logical rows and srvCreated');
        assert.ok(after.every((doc, index) => doc.srvModified >= before[index].srvModified), domain + ' retry monotonic srvModified');
        assert.deepEqual(await lab.rows(domain, lab.B), [], domain + ' retry tenant isolation');
      }
    });

    it('serves pinned follower suffixes, token query, windows and counts through v1 and inherited v2', async function () {
      const docs = await fill();
      await fill(lab.B, 1);
      for (const version of [1, 2]) for (const [index, tenant] of [lab.A, lab.B].entries()) {
        const expected = patterns.documents(index);
        for (const domain of domains) {
          const read = await follower(domain, tenant, version);
          assert.equal(read.status, 200, domain);
          assert.ok(Array.isArray(read.body), domain + ' follower expects JSON array');
          assert.equal(read.body.length, expected[domain].length, domain + ' follower count');
          assert.ok(read.body.every(doc => typeof doc._id === 'string'));
          if (domain === 'entries') assert.deepEqual(read.body.map(doc => doc.sgv), expected.entries.map(doc => doc.sgv).reverse());
          if (domain === 'treatments') {
            assert.equal(read.body[0].carbs, expected.treatments[0].carbs);
            assert.equal(read.body[0].absorptionTime, 180);
            assert.equal(read.body[0].syncIdentifier, docs.treatments[0].syncIdentifier);
          }
          if (domain === 'devicestatus') assert.deepEqual(read.body[0].loop, expected.devicestatus[0].loop);
          if (domain === 'profile') assert.deepEqual(read.body[0].store, expected.profile[0].store);
        }
      }
      // Exercise the actual filter, rather than obtaining the right result from
      // a corpus whose every row happens to be in the follower's window.
      patterns.consumeUpload(await upload('entries', [{ ...docs.entries[0], date: patterns.BASE - 300000,
        dateString: patterns.iso(-300000) }, { ...docs.entries[0], date: patterns.BASE + 600000,
        dateString: patterns.iso(600000), type: 'cal', sgv: undefined, slope: 1, intercept: 0, scale: 1 }]), 2);
      patterns.consumeUpload(await upload('treatments', [{ ...docs.treatments[0],
        created_at: patterns.iso(-60000), timestamp: patterns.iso(-60000) }]), 1);
      assert.equal((await follower('entries')).body.length, 2);
      assert.equal((await follower('treatments')).body.length, 1);
    });

    it('retains uploader extension data and API3 history through cross-version reads and process restart', async function () {
      const docs = await fill();
      await fill(lab.B, 1);
      const credentials = [];
      for (const tenant of [lab.A, lab.B]) {
        const issued = await lab.exchange(worker, tenant);
        assert.equal(issued.status, 200);
        credentials.push(issued.body.token);
      }
      const foreign = {};
      for (const domain of domains) foreign[domain] = await lab.rows(domain, lab.B);
      await lab.stop(worker);
      worker = lab.start();
      await lab.ready(worker);
      for (const domain of domains) {
        const stored = await lab.rows(domain);
        const listed = await lab.http(worker, lab.A, 'GET', '/api/v3/' + domain, credentials[0]);
        assert.equal(listed.status, 200);
        assert.equal(listed.body.result.length, docs[domain].length);
        const history = await lab.http(worker, lab.A, 'GET', '/api/v3/' + domain + '/history/' + (patterns.BASE - 1), credentials[0]);
        assert.equal(history.status, 200);
        assert.equal(history.body.result.length, stored.length);
        assert.deepEqual(new Set(history.body.result.map(doc => doc.identifier)), new Set(stored.map(doc => doc.identifier || doc._id)));
        assert.ok(history.body.result.every(doc => doc.srvModified > patterns.BASE));
        assert.deepEqual(await lab.rows(domain, lab.B), foreign[domain]);
        assert.equal((await follower(domain)).status, 200);
      }
      const device = (await lab.rows('devicestatus'))[0];
      assert.deepEqual(device.loop.predicted, docs.devicestatus[0].loop.predicted);
      const treatment = (await lab.rows('treatments'))[0];
      assert.equal(treatment.syncIdentifier, docs.treatments[0].syncIdentifier);
      assert.equal(treatment.absorptionTime, 180);
    });

    it('consumes returned profile and treatment IDs for pinned caller-managed PUT and DELETE workflows', async function () {
      const docs = await fill();
      const profile = (await lab.rows('profile'))[0];
      const replacement = { ...docs.profile[0], _id: profile._id,
        loopSettings: { dosingEnabled: false, overridePresets: [], maximumBolus: 2 } };
      const updated = await upload('profile', replacement, lab.A, 'PUT');
      assert.equal(updated.status, 200);
      assert.equal((await lab.rows('profile')).length, 1);
      const current = await lab.http(worker, lab.A, 'GET', '/api/v1/profile/current', undefined,
        undefined, { 'api-secret': lab.rootCredential(lab.A) });
      assert.equal(current.status, 200);
      assert.deepEqual(current.body.loopSettings, replacement.loopSettings);
      const treatment = (await lab.rows('treatments'))[0];
      assert.equal((await upload('treatments', { ...docs.treatments[0], _id: treatment._id, carbs: 20 }, lab.A, 'PUT')).status, 200);
      assert.equal((await follower('treatments')).body[0].carbs, 20);
      const removed = await lab.http(worker, lab.A, 'DELETE', '/api/v1/treatments/' + treatment._id,
        undefined, undefined, { 'api-secret': lab.rootCredential(lab.A) });
      assert.equal(removed.status, 200);
      assert.deepEqual(await lab.rows('treatments'), []);
      assert.deepEqual((await follower('treatments')).body, []);
    });

    it('rechecks follower current authority and refuses wrong-tenant tokens after successful source-pattern reads', async function () {
      await fill();
      await fill(lab.B, 1);
      const issued = await lab.exchange(worker, lab.A);
      assert.equal(issued.status, 200);
      const before = await lab.rows('entries', lab.B);
      const foreign = await lab.http(worker, lab.B, 'GET', patterns.followerPath('entries', lab.credential(lab.A)));
      assert.equal(foreign.status, 401);
      await lab.grants(['denied']);
      assert.equal((await follower('entries')).status, 401);
      const stale = await lab.http(worker, lab.A, 'GET', '/api/v3/entries', issued.body.token);
      assert.equal(stale.status, 403);
      assert.equal((await follower('entries', lab.B)).status, 200);
      assert.deepEqual(await lab.rows('entries', lab.B), before);
    });
  });
