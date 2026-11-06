'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const frameFixture = require('./fixtures/tenant-frame-concurrency');
const { optInSuite } = require('./support/opt-in');

function values (response) {
  assert.equal(response.body.sgvs.length, 1);
  assert.equal(response.body.treatments.length, 1);
  return { glucose: response.body.sgvs[0].mgdl, carbs: response.body.treatments[0].carbs,
    treatmentGeneration: response.body.treatments[0].frameGeneration };
}

optInSuite(process.env.NS_ENTRIES_CRUD_HTTP_TEST === '1' &&
  !!process.env.NS_TEST_POSTGRES_ADMIN_URI && !!process.env.CUSTOMCONNSTR_mongo,
'NS_ENTRIES_CRUD_HTTP_TEST=1 with owned PostgreSQL and MongoDB')(
  'tenant REST frame concurrent real PostgreSQL reads', function () {
    this.timeout(30000);
    const lab = frameFixture();
    before(() => lab.open());
    beforeEach(() => lab.seed());
    after(() => lab.close());

    it('observes mixed collection generations across one atomically committed concurrent update', async function () {
      const foreignBefore = await lab.rows('entries', lab.B);
      const foreignTreatmentsBefore = await lab.rows('treatments', lab.B);
      assert.deepEqual(values(await lab.http().expect(200)), { glucose: 101, carbs: 20, treatmentGeneration: 0 });
      const barrier = lab.barrier();
      let pending;
      try {
        pending = lab.http().then(response => response);
        await barrier.ready();
        assert.ok(barrier.observed.filter(read => read.logical === 'entries').every(read =>
          read.documents.every(doc => doc.frameGeneration === 0 && doc.sgv === 101)));
        await lab.advance();
        assert.equal((await lab.rows('entries'))[0].frameGeneration, 1);
        assert.equal((await lab.rows('treatments'))[0].frameGeneration, 1);
        barrier.release();
        const response = await pending;
        assert.equal(response.status, 200);
        assert.deepEqual(values(response), { glucose: 101, carbs: 30, treatmentGeneration: 1 },
          'the current multi-read loader can expose a pre-update entry and a post-update treatment');
        const treatmentReads = barrier.observed.filter(read => read.logical === 'treatments' && read.documents.length);
        assert.ok(treatmentReads.length > 0, 'an actual treatment SELECT returned the new generation');
        assert.ok(treatmentReads.every(read => read.documents.every(doc => doc.frameGeneration === 1 && doc.carbs === 30)));
      } finally {
        barrier.restore();
        if (pending) await pending;
      }
      assert.deepEqual(values(await lab.http().expect(200)), { glucose: 111, carbs: 30, treatmentGeneration: 1 });
      assert.deepEqual(values(await lab.http('/api/v2/ddata/at', lab.B).expect(200)), { glucose: 902, carbs: 920, treatmentGeneration: 9 });
      assert.deepEqual(await lab.rows('entries', lab.B), foreignBefore);
      assert.deepEqual(await lab.rows('treatments', lab.B), foreignTreatmentsBefore);
    });

    for (const [kind, code, status, error] of [
      ['privilege', '42501', 503, 'TENANT_SNAPSHOT_UNAVAILABLE'],
      ['relation', '42P01', 500, 'TENANT_SNAPSHOT_INTERNAL']
    ]) {
      it('refuses a partial frame after a real ' + code + ' read failure and remains live after restoration', async function () {
        const barrier = lab.barrier();
        let changed = false, pending;
        try {
          pending = lab.http().then(response => response);
          await barrier.ready();
          await lab.failRead(kind); changed = true;
          barrier.release();
          const response = await pending;
          assert.equal(response.status, status, 'a failed collection read must refuse the whole HTTP frame');
          assert.deepEqual(response.body, { error });
          assert.ok(barrier.errors.some(failure => failure.logical === 'treatments' && failure.code === code),
            'the intended real driver failure must occur after another domain read succeeded');
        } finally {
          barrier.restore();
          try { if (pending) await pending; }
          finally { if (changed) await lab.restoreRead(kind); }
        }
        assert.deepEqual(values(await lab.http().expect(200)), { glucose: 101, carbs: 20, treatmentGeneration: 0 });
      });
    }

    it('serves derived HTTP without connecting to notification or connector destinations', async function () {
      const guard = lab.egressGuard();
      try {
        const socket = new net.Socket();
        assert.throws(() => socket.connect({ host: 'provider.invalid', port: 443 }), /non-dependency socket/);
        socket.destroy();
        assert.equal(guard.denied(), 1, 'the socket guard must prove it can detect application egress');
        for (const path of ['/api/v2/ddata/at', '/api/v2/properties/bgnow', '/api/v2/summary']) {
          const response = await lab.http(path);
          assert.equal(guard.denied(), 1, 'the actual derived read must not attempt a non-dependency socket');
          assert.equal(response.status, 200);
        }
        assert.equal(guard.denied(), 1, 'derived reads must open only owned dependency/server sockets');
      } finally { guard.restore(); }
      assert.deepEqual(values(await lab.http().expect(200)), { glucose: 101, carbs: 20, treatmentGeneration: 0 });
    });
  });
