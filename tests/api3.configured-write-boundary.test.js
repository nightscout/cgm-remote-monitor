/* eslint require-atomic-updates: 0 */
'use strict';

const assert = require('node:assert/strict');
const {ObjectId} = require('mongodb');
const instance = require('./fixtures/api3/instance');
const authSubject = require('./fixtures/api3/authSubject');

// Exercise real HTTP adapters: a boundary-only test with name:'treatments'
// cannot detect the physical-name/logical-name mix-up in API v3's constructor.
for (const physical of ['treatments', 'configured_boundary_treatments']) {
  describe('API v3 validated updates in ' + physical, function () {
    this.timeout(30000);
    let app, raw, jwt;
    const ids = [], events = [];
    const keys = ['MONGO_TREATMENTS_COLLECTION', 'CUSTOMCONNSTR_MONGO_TREATMENTS_COLLECTION'];
    let saved;

    before(async function () {
      saved = keys.map(key => process.env[key]);
      keys.forEach(key => { delete process.env[key]; });
      process.env.MONGO_TREATMENTS_COLLECTION = physical;
      app = await instance.create({useHttps: false});
      jwt = (await authSubject(app.ctx.authorization.storage, ['all'], app.app)).jwt;
      raw = app.ctx.store.collection(physical);
      app.ctx.bus.on('storage-write-committed', event => events.push(event));
    });
    beforeEach(function () {
      app.env.writeValidation = 'reject';
      events.length = 0;
    });
    after(async function () {
      try {
        if (raw) await raw.deleteMany({_id: {$in: ids}});
        if (app) app.ctx.bus.teardown();
      } finally {
        keys.forEach((key, i) => {
          if (saved[i] === undefined) delete process.env[key];
          else process.env[key] = saved[i];
        });
      }
    });

    async function seed(extra = {}) {
      const id = new ObjectId();
      ids.push(id);
      await raw.insertOne({_id: id, identifier: id.toHexString(), eventType: 'Temporary Target',
        created_at: new Date().toISOString(), duration: 30, targetBottom: 100, targetTop: 140,
        units: 'mg/dl', ...extra});
      return id;
    }
    function patch(id, doc) {
      return app.patch('/api/v3/treatments/' + id.toHexString(), jwt.all).send(doc);
    }

    it('writes to the configured collection and observes the logical collection name', async function () {
      const id = await seed();
      await patch(id, {targetBottom: 120}).expect(200);
      assert.equal((await raw.findOne({_id: id})).targetBottom, 120);
      assert.equal(events.length, 1);
      assert.equal(events[0].collection, 'treatments');
      assert.equal(events[0].source, 'v3');
      assert.equal(events[0].counts.modified, 1);
    });

    for (const status of [400, 409]) {
      it('returns ' + status + ' for a concurrent change after validation', async function () {
        const id = await seed(), prototype = Object.getPrototypeOf(raw), original = prototype.updateOne;
        let attempts = 0;
        try {
          prototype.updateOne = async function (filter, ...args) {
            if (JSON.stringify(filter).includes(id.toHexString())) {
              attempts++;
              // Interpose at the last possible moment, after the boundary read.
              await original.call(raw, {_id: id}, {$set: status === 400
                ? {targetTop: 110} : {duration: attempts % 2 ? 31 : 30}});
            }
            return original.call(this, filter, ...args);
          };
          await patch(id, {targetBottom: 120}).expect(status);
          assert.equal(attempts, status === 400 ? 1 : 4);
          const stored = await raw.findOne({_id: id});
          assert.equal(stored.targetBottom, 100);
          assert(stored.targetBottom <= stored.targetTop);
          assert.equal(events.length, 0);
        } finally { prototype.updateOne = original; }
      });
    }

    it('keeps unrelated edits to legacy invalid targets possible', async function () {
      const id = await seed({targetBottom: 160});
      await patch(id, {notes: 'reviewed'}).expect(200);
      const stored = await raw.findOne({_id: id});
      assert.equal(stored.notes, 'reviewed');
      assert.equal(stored.targetBottom, 160);
    });

    for (const mode of ['off', 'log']) {
      it('preserves existing writes in ' + mode + ' mode', async function () {
        app.env.writeValidation = mode;
        const id = await seed();
        await patch(id, {targetBottom: 160}).expect(200);
        assert.equal((await raw.findOne({_id: id})).targetBottom, 160);
      });
    }
  });
}
