'use strict';

const assert = require('node:assert/strict');
const { ObjectId } = require('mongodb');
const { mock } = require('node:test');
const { optInSuite } = require('./support/opt-in');
const fixture = require('./fixtures/frame-acquisition');
const snapshot = require('../lib/server/tenant-app/snapshot');
const scope = require('../lib/storage/tenant-scope');

optInSuite(process.env.NS_FRAME_ACQUISITION_TEST === '1',
  'NS_FRAME_ACQUISITION_TEST=1 with Docker for disposable PostgreSQL/MongoDB')(
  'actual shared-frame acquisition boundaries', function () {
    this.timeout(120000);
    const lab = fixture();
    const attempts = [];
    before(() => lab.open());
    beforeEach(async function () {
      await lab.seed();
      mock.timers.enable({ apis: ['Date'], now: lab.NOW });
      for (const name of ['http', 'https']) for (const method of ['request', 'get']) {
        mock.method(require('node:' + name), method, () => {
          attempts.push(name + '.' + method); throw new Error('forbidden acquisition provider egress');
        });
      }
      mock.method(globalThis, 'fetch', () => {
        attempts.push('fetch'); throw new Error('forbidden acquisition provider egress');
      });
    });
    afterEach(async function () {
      mock.timers.reset(); mock.restoreAll();
      assert.deepEqual(attempts.splice(0), [], 'acquisition/property computation must not attempt guarded HTTP provider egress');
      await lab.liveness(); await lab.release();
    });
    after(() => lab.close());

    const selected = properties => JSON.parse(JSON.stringify({ bgnow: properties.bgnow,
      direction: properties.direction, upbat: properties.upbat, iob: properties.iob }));
    for (const backend of ['mongo', 'pg']) {
      it(backend + ' agrees on selected current clinical properties across actual view, framed snapshot and resident loader', async function () {
        const actual = [];
        for (const path of ['properties', 'snapshot', 'loader-live', 'loader-frame']) {
          const setup = await lab.context(backend);
          const frame = await lab.acquire(setup, path);
          actual.push(selected(lab.properties(setup, frame)));
          assert.equal(frame.ddata.lastUpdated, lab.NOW);
        }
        assert.ok(actual.every(value => value.bgnow.last === 100), 'shipping bgnow must retain the synthetic current reading');
        assert.ok(actual.every(value => value.iob.iob === 1.25), 'device IOB must survive crowded device acquisition');
        for (const value of actual.slice(1)) assert.deepEqual(value, actual[0]);
      });

      it(backend + ' preserves explicit alarm and property acquisition bounds rather than claiming equal working sets', async function () {
        const alarmSetup = await lab.context(backend), propertySetup = await lab.context(backend);
        const alarm = await lab.acquire(alarmSetup, 'alarms'), properties = await lab.acquire(propertySetup, 'properties');
        assert.equal(alarm.ddata.sgvs.length, 12, 'actual alarms must acquire twelve newest sgv records');
        assert.equal(alarm.ddata.mbgs.length, 1); assert.equal(alarm.ddata.cals.length, 1);
        assert.equal(properties.ddata.sgvs.length, 15, 'properties use the loader two-day window');
        assert.deepEqual(alarm.ddata.food, []); assert.deepEqual(alarm.ddata.activity, []);
        assert.deepEqual(properties.ddata.food, []); assert.deepEqual(properties.ddata.activity, []);
        const snapshotSetup = await lab.context(backend);
        const frame = await lab.acquire(snapshotSetup, 'snapshot');
        assert.equal(frame.ddata.food[0].name, 'Synthetic food');
        assert.equal(frame.ddata.activity[0].steps, 100);
        assert.ok(!frame.ddata.treatments.some(doc => doc._id === 'too-old'));
        assert.ok(frame.ddata.treatments.some(doc => doc._id === 'sensor'), 'latest-kind lookup keeps older sensor event');
        assert.ok(alarm.queries.some(value => value.kind === 'entries' && value.q.count === 12));
      });

      it(backend + ' distinguishes live framefalse and tenant frametrue upper bounds with future records', async function () {
        await lab.seed(docs => {
          docs.entries.push({ _id: 'future', type: 'sgv', date: lab.NOW + lab.HOUR, sgv: 777 });
          docs.treatments.push({ _id: 'future-treatment', eventType: 'Note', created_at: new Date(lab.NOW + lab.HOUR).toISOString() });
          docs.devicestatus.push({ _id: 'future-status', created_at: new Date(lab.NOW + lab.HOUR).toISOString(), uploader: { battery: 99 } });
        });
        const liveSetup = await lab.context(backend), frameSetup = await lab.context(backend);
        const live = await lab.acquire(liveSetup, 'properties'), framed = await lab.acquire(frameSetup, 'snapshot');
        assert.ok(live.ddata.sgvs.some(doc => doc._id === 'future'));
        assert.ok(!framed.ddata.sgvs.some(doc => doc._id === 'future'));
        assert.ok(live.ddata.treatments.some(doc => doc._id === 'future-treatment'));
        assert.ok(!framed.ddata.treatments.some(doc => doc._id === 'future-treatment'));
        assert.ok(live.ddata.devicestatus.some(doc => doc._id === 'future-status'));
        assert.ok(!framed.ddata.devicestatus.some(doc => doc._id === 'future-status'));
        const liveQuery = liveSetup.trace.find(value => value.logical === 'entries' && value.query);
        const frameQuery = frameSetup.trace.find(value => value.logical === 'entries' && value.query);
        assert.equal(liveQuery.query.find.date.$lte, undefined);
        assert.equal(frameQuery.query.find.date.$lte, lab.NOW);
      });

      it(backend + ' keeps same-spelling typed identity collision behavior explicit across union and framed acquisition', async function () {
        await lab.seed((docs, tenant) => docs.entries.push({ _id: lab.HEX, type: 'sgv',
          date: lab.NOW - 120000, sgv: tenant === lab.A ? 133 : 233 }));
        const alarmSetup = await lab.context(backend), snapshotSetup = await lab.context(backend);
        const alarm = await lab.acquire(alarmSetup, 'alarms'), framed = await lab.acquire(snapshotSetup, 'snapshot');
        const ids = alarmSetup.trace.filter(value => value.logical === 'entries' && value.ids).flatMap(value => value.ids);
        assert.deepEqual(ids.filter(id => id.shown === lab.HEX).map(id => id.kind).sort(), ['ObjectId', 'string']);
        assert.equal(alarm.ddata.sgvs.filter(doc => doc._id === lab.HEX).length, 1,
          'bounded view union keys by shown string identity');
        assert.equal(framed.ddata.sgvs.filter(doc => doc._id === lab.HEX).length, 2,
          'framed loader retains both fetched rows before runtime identity normalization');
      });

      it(backend + ' keeps stats failure policy explicit for views, tenant snapshots and the resident loader', async function () {
        for (const path of ['properties', 'snapshot', 'loader-live']) {
          const setup = await lab.context(backend);
          setup.ctx.store.db.stats = async () => { throw new Error('synthetic acquisition stats unavailable'); };
          if (path === 'loader-live') {
            const frame = await lab.acquire(setup, path);
            assert.deepEqual(frame.ddata.dbstats, {}, 'resident loader logs and continues after stats failure');
          } else await assert.rejects(lab.acquire(setup, path), /synthetic acquisition stats unavailable/);
        }
      });

      it(backend + ' retains raw typed identity reads and crowded per-kind device union through private materialization', async function () {
        const setup = await lab.context(backend), frame = await lab.acquire(setup, 'properties');
        const raw = setup.trace.find(value => value.logical === 'entries' && value.ids);
        assert.ok(raw.ids.some(id => id.shown === lab.HEX && id.kind === 'ObjectId'));
        assert.ok(raw.ids.some(id => id.shown === 'typed-string' && id.kind === 'string'));
        assert.ok(frame.ddata.sgvs.some(doc => doc._id === lab.HEX && typeof doc._id === 'string'));
        const recent = frame.ddata.recentDeviceStatus(lab.NOW);
        assert.equal(recent.filter(doc => doc.device === 'synthetic-uploader').length, 10);
        assert.equal(recent.filter(doc => doc._id === 'multi-kind').length, 1, 'one row shared by two kinds remains one runtime row');
        assert.ok(recent.some(doc => doc.device === 'synthetic-pump'), 'an older pump kind is not displaced by uploader volume');
        assert.ok(!recent.some(doc => doc._id === 'old-status'));
        assert.equal(setup.ctx.ddata.sgvs.length, 0, 'private view loader must leave the supplied resident ddata untouched');
        assert.equal(setup.ctx.cache.isEmpty('entries'), true, 'private view loader must leave the supplied resident cache untouched');
      });
    }

    it('PG snapshot keeps real row binding consistent with its frame tenant label', async function () {
      const setup = await lab.context('pg', lab.A);
      const frame = await lab.acquire(setup, 'snapshot');
      assert.equal(frame.tenant, lab.A);
      assert.equal(lab.properties(setup, frame).bgnow.last, 100,
        'a frame labelled tenant A must contain actual PG tenant A clinical values');
      const other = await lab.context('pg', lab.B);
      const otherFrame = await lab.acquire(other, 'snapshot');
      assert.equal(lab.properties(other, otherFrame).bgnow.last, 200);
      assert.equal(frame.ddata.dbstats.indexSize, undefined, 'shared PG index bytes are not assigned to one tenant');
      assert.ok(frame.ddata.dbstats.dataSize > 0);
    });

    it('snapshot refuses a wrong declared port and a foreign active tenant scope before acquisition', async function () {
      const setup = await lab.context('pg');
      assert.throws(() => snapshot({ tenant: lab.A, env: setup.env, language: lab.language,
        ports: { ...setup.ports, entries: { ...setup.ports.entries, tenant: lab.B } } }), /tenant-bound entries port/);
      const service = snapshot({ tenant: lab.A, env: setup.env, language: lab.language, ports: setup.ports });
      await assert.rejects(scope.withTenant(lab.B, () => service.load({ at: lab.NOW })), /Snapshot tenant scope mismatch/);
      assert.equal(setup.trace.length, 0);
    });
  });
