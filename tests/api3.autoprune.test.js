/* eslint require-atomic-updates: 0 */
'use strict';

require('should');

/**
 * API v3 auto-prune (API3_AUTOPRUNE_<COLLECTION>).
 *
 * After a successful v3 create/update/patch/delete the collection deletes
 * documents older than the configured number of days, in the background and
 * at most once an hour. The storage call returns a promise; these tests check
 * that the prune really runs, logs its count, and that a failing delete is
 * logged instead of becoming an unhandled promise rejection (which ends the
 * process on Node 15 and later).
 */
describe('API3 auto-prune', function () {
  const self = this
    , testConst = require('./fixtures/api3/const.json')
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    , utils = require('./fixtures/api3/utils')
    ;

  const ENV_NAME = 'API3_AUTOPRUNE_TREATMENTS';
  const DAY = 24 * 3600 * 1000;

  self.timeout(20000);

  async function waitFor (predicate, timeoutMs = 5000) {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) {
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return true;
  }

  function newDoc (suffix) {
    return {
      date: Date.now(),
      app: testConst.TEST_APP,
      device: testConst.TEST_DEVICE + ' API3 AUTOPRUNE ' + suffix,
      eventType: 'Note',
      notes: 'autoprune ' + suffix
    };
  }

  before(async () => {
    self.savedEnv = process.env[ENV_NAME];
    process.env[ENV_NAME] = '30';

    self.instance = await instance.create({});
    self.url = '/api/v3/treatments';
    self.col = self.instance.ctx.apiApp.get('collections').treatments;
    self.rawCol = self.instance.ctx.store.collection(self.instance.env.treatments_collection || 'treatments');

    const authResult = await authSubject(self.instance.ctx.authorization.storage, [
      'create', 'read'
    ], self.instance.app);
    self.jwt = authResult.jwt;
  });

  after(async () => {
    if (self.savedEnv === undefined) {
      delete process.env[ENV_NAME];
    } else {
      process.env[ENV_NAME] = self.savedEnv;
    }
    await utils.storageClear(self.instance.ctx);
    self.instance.ctx.bus.teardown();
  });

  beforeEach(() => {
    self.info = [];
    self.errors = [];
    self.unhandled = [];
    self.origInfo = console.info;
    self.origError = console.error;
    console.info = (...args) => { self.info.push(args); self.origInfo(...args); };
    console.error = (...args) => { self.errors.push(args); self.origError(...args); };
    // Mocha's own handler re-emits a user-code rejection on process, so the
    // same rejection can reach this listener twice; count each promise once.
    self.unhandledPromises = new Set();
    self.onUnhandled = (reason, promise) => {
      if (!self.unhandledPromises.has(promise)) {
        self.unhandledPromises.add(promise);
        self.unhandled.push(reason);
      }
    };
    process.on('unhandledRejection', self.onUnhandled);
    // allow a prune now, regardless of the hourly throttle
    self.col.nextAutoPrune = new Date(0);
  });

  afterEach(() => {
    console.info = self.origInfo;
    console.error = self.origError;
    process.removeListener('unhandledRejection', self.onUnhandled);
    if (self.restoreStorage) {
      self.restoreStorage();
      self.restoreStorage = null;
    }
  });

  it('reads the setting for the collection', () => {
    self.col.autoPruneDays.should.equal('30');
  });

  it('a v3 create prunes documents older than the retention period and logs the count', async () => {
    await self.rawCol.deleteMany({});
    const old = new Date(Date.now() - 40 * DAY);
    const recent = new Date(Date.now() - 5 * DAY);
    await self.rawCol.insertMany([
      { eventType: 'Note', notes: 'autoprune old 1', created_at: old.toISOString(), date: old.getTime() },
      { eventType: 'Note', notes: 'autoprune old 2', created_at: old.toISOString(), date: old.getTime() },
      { eventType: 'Note', notes: 'autoprune recent', created_at: recent.toISOString(), date: recent.getTime() }
    ]);

    await self.instance.post(self.url, self.jwt.create)
      .send(newDoc('create'))
      .expect(201);

    const logged = await waitFor(() => self.info.some((a) => /Auto-pruned/.test(a.join(' '))));
    logged.should.equal(true, 'expected an "Auto-pruned" log line');

    const line = self.info.map((a) => a.join(' ')).find((l) => /Auto-pruned/.test(l));
    line.should.match(/^Auto-pruned 2 documents from treatments collection/);

    const remaining = await self.rawCol.find({}).toArray();
    remaining.map((d) => d.notes).sort().should.eql(['autoprune create', 'autoprune recent']);

    self.col.nextAutoPrune.getTime().should.be.above(Date.now() + 3500 * 1000);
    self.unhandled.should.have.length(0);
  });

  it('a failing prune is logged, does not reject unhandled, and waits for the next hourly slot', async () => {
    const original = self.col.storage.deleteManyOr;
    let calls = 0;
    self.col.storage.deleteManyOr = async () => {
      calls++;
      throw new Error('simulated autoprune storage failure');
    };
    self.restoreStorage = () => { self.col.storage.deleteManyOr = original; };

    await self.instance.post(self.url, self.jwt.create)
      .send(newDoc('failing'))
      .expect(201);

    const logged = await waitFor(() => self.errors.some((a) => a.some((x) => x && x.message === 'simulated autoprune storage failure')));
    // give an unhandled rejection, if any, time to surface
    await new Promise((resolve) => setTimeout(resolve, 100));

    self.unhandled.map((r) => (r && r.message) || String(r)).should.eql([]);
    logged.should.equal(true, 'expected the storage error to be logged');
    calls.should.equal(1);

    // the hourly throttle still applies after a failure: a second write does not retry
    self.col.nextAutoPrune.getTime().should.be.above(Date.now() + 3500 * 1000);
    await self.instance.post(self.url, self.jwt.create)
      .send(newDoc('failing again'))
      .expect(201);
    await new Promise((resolve) => setTimeout(resolve, 100));
    calls.should.equal(1);

    // and the server is still answering
    await self.instance.get(self.url + '?limit=1', self.jwt.read)
      .expect(200);
  });
});
