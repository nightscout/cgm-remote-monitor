/* eslint require-atomic-updates: 0 */
'use strict';

const assert = require('node:assert/strict');
const {ObjectId} = require('mongodb');
const io = require('socket.io-client');
const instance = require('./fixtures/api3/instance');

describe('Socket partial-write cache reconciliation', function () {
  this.timeout(30000);
  let app, raw, socket;
  const updates = [], received = [], commits = [];
  before(async function () {
    app = await instance.create({useHttps: false});
    app.env.writeValidation = 'reject';
    raw = app.ctx.store.collection(app.env.treatments_collection);
    socket = io(app.baseUrl, {transports: ['websocket'], reconnection: false});
    await new Promise((resolve, reject) => {
      socket.on('connect', () => socket.emit('authorize', {client: 'test',
        secret: 'b723e97aa97846eb92d5264f084b2823f57c4aa1'}, auth => auth && auth.write_treatment ? resolve() : reject(new Error('authorization failed'))));
      socket.on('connect_error', reject);
    });
    app.ctx.bus.on('data-update', event => updates.push(event));
    app.ctx.bus.on('data-received', () => received.push(true));
    app.ctx.bus.on('storage-write-committed', event => commits.push(event));
  });
  after(async function () {
    if (socket) socket.close();
    if (raw) await raw.deleteMany({app: 'partial-reconcile-test'});
    if (app) app.ctx.bus.teardown();
  });

  for (const [event, readMode] of [['dbUpdate', 'normal'], ['dbUpdateUnset', 'normal'],
    ['dbUpdate', 'failure'], ['dbUpdate', 'concurrent-change']]) {
    it('reconciles ' + event + (readMode === 'normal' ? ' after a partial write' : ' when the reread has ' + readMode), async function () {
      const oid = new ObjectId(), hex = oid.toHexString();
      const created = new Date(Date.now() - 60000).toISOString();
      const docs = [oid, hex].map((_id, index) => ({_id, app: 'partial-reconcile-test', notes: 'copy-' + index,
        eventType: 'Temporary Target', created_at: created, duration: 30,
        units: 'mg/dl', targetBottom: 100, targetTop: 140}));
      await raw.insertMany(docs);
      app.ctx.cache.insertData('treatments', app.ctx.ddata.processRawDataForRuntime(docs));
      const unrelated = {_id: new ObjectId(), app: 'partial-reconcile-test', notes: 'unrelated', created_at: created};
      app.ctx.cache.insertData('treatments', app.ctx.ddata.processRawDataForRuntime([unrelated]));
      const entryId = new ObjectId().toHexString();
      app.ctx.cache.insertData('entries', [{_id: entryId, mills: Date.now(), sgv: 100}]);
      updates.length = received.length = commits.length = 0;
      const generation = app.ctx.cache.getRemovalGeneration('treatments');
      const listeners = app.ctx.bus.listenerCount('data-update');
      const proto = Object.getPrototypeOf(raw), originalUpdate = proto.updateOne, originalFind = proto.find;
      let calls = 0, secondId;
      try {
        proto.updateOne = async function (filter, ...args) {
          if (filter.$and && JSON.stringify(filter).includes(hex)) {
            calls++;
            if (calls === 2) secondId = filter.$and[1]._id.$eq;
            if (event === 'dbUpdate' && calls === 2) {
              // A valid second edit makes the pending lower target invalid.
              await originalUpdate.call(raw, {_id: filter.$and[1]._id.$eq}, {$set: {targetTop: 110}});
            } else if (event === 'dbUpdateUnset' && calls >= 2) {
              // Keep changing a valid field so all four snapshot attempts lose.
              await originalUpdate.call(raw, {_id: filter.$and[1]._id.$eq}, {$set: {duration: calls % 2 ? 30 : 31}});
            }
          }
          return originalUpdate.call(this, filter, ...args);
        };
        if (readMode !== 'normal') proto.find = function (filter, ...args) {
          if (calls >= 2 && filter && filter._id && filter._id.$in && JSON.stringify(filter).includes(hex)) {
            if (readMode === 'failure') {
              return {toArray: async () => { throw new Error('synthetic reconciliation read failure'); }};
            }
            const cursor = originalFind.call(this, filter, ...args);
            return {toArray: async () => {
              const snapshot = await cursor.toArray();
              await originalUpdate.call(raw, {_id: secondId}, {$set: {notes: 'newer concurrent edit'}});
              const latest = await raw.findOne({_id: secondId});
              app.ctx.bus.emit('data-update', {type:'treatments', op:'update',
                changes:app.ctx.ddata.processRawDataForRuntime([latest])});
              return snapshot;
            }};
          }
          return originalFind.call(this, filter, ...args);
        };
        const payload = event === 'dbUpdate' ? {targetBottom: 120} : {units: 1};
        const reply = await new Promise(resolve => socket.emit(event, {collection: 'treatments', _id: hex, data: payload}, resolve));
        assert.equal(reply.result, 'Unable to process update');
        assert.equal(calls, event === 'dbUpdateUnset' ? 5 : 2);
        assert(app.ctx.cache.getRemovalGeneration('treatments') > generation);
        assert.equal(received.length, 1);
        assert.equal(app.ctx.bus.listenerCount('data-update'), listeners);
        assert.equal(commits.length, 1);
        assert.equal(commits[0].partial, true);
        assert.equal(commits[0].counts.modified, 1);
        // Restore find before checking the actual durable state.
        proto.find = originalFind;
        const stored = await raw.find({_id: {$in: [oid, hex]}}).toArray();
        assert.equal(stored.length, 2);
        const committed = stored.filter(doc => event === 'dbUpdate' ? doc.targetBottom === 120 : doc.units === undefined);
        assert.equal(committed.length, 1);
        const cached = app.ctx.cache.getData('treatments');
        if (readMode !== 'normal') {
          assert.equal(cached.length, 0, 'untrustworthy reread must invalidate stale cache so the next load can recover');
          assert(app.ctx.cache.getData('entries').some(doc => doc._id === entryId),
            'unrelated glucose data must remain cached');
          assert(!updates.some(change => change.op === 'remove' && change.changes === null));
        } else {
          const relevant = cached.filter(doc => doc._id === hex);
          assert.equal(relevant.length, 2);
          const shape = rows => rows.map(({notes, targetBottom, targetTop, units, duration}) =>
            ({notes, targetBottom, targetTop, units, duration})).sort((a, b) => a.notes.localeCompare(b.notes));
          assert.deepEqual(shape(relevant), shape(stored), 'both cached forms must match the database');
          assert(cached.some(doc => doc.notes === 'unrelated'));
          assert(updates.some(change => change.op === 'remove'));
          assert(updates.some(change => change.op === 'update'));
        }
      } finally { proto.updateOne = originalUpdate; proto.find = originalFind; }
    });
  }

  it('does not announce or invalidate an update refused before any write', async function () {
    const oid = new ObjectId(), hex = oid.toHexString(), created = new Date().toISOString();
    const docs = [oid, hex].map(_id => ({_id, app:'partial-reconcile-test', created_at:created,
      eventType:'Temporary Target', duration:30, targetBottom:100, targetTop:140}));
    await raw.insertMany(docs);
    app.ctx.cache.insertData('treatments', app.ctx.ddata.processRawDataForRuntime(docs));
    updates.length = received.length = commits.length = 0;
    const reply = await new Promise(resolve => socket.emit('dbUpdate', {collection:'treatments',_id:hex,data:{targetBottom:160}}, resolve));
    assert.equal(reply.result, 'Unable to process update');
    assert.equal(updates.length, 0);
    assert.equal(received.length, 0);
    assert.equal(commits.length, 0);
    assert.equal(app.ctx.cache.getData('treatments').filter(doc => doc._id === hex).length, 2);
  });
});
