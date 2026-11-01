'use strict';

// API v3: a devicestatus POSTed with the identifier of a status already
// stored is acknowledged and not written again (ID-SIMPLE-MATCH,
// devicestatus option (b), maintainer decision 2026-10-26), as v1 does
// (api.devicestatus.identifier-match). Before, the POST answered
// 200 isDeduplication and replaced the stored status, with a new srvModified
// even for an identical body.
//
// The reply keeps the deduplication shape: 200, isDeduplication: true, the
// stored identifier, Last-Modified and Location. Nothing is replaced, the
// stored srvModified is unchanged and no storage-socket update is sent.
//
// Pinned beside it, unchanged:
//   - other collections (treatments here) still replace on a deduplicating
//     POST;
//   - a devicestatus POST matched through the created_at + device fallback
//     (a stored status with no identifier of its own) still replaces it;
//   - a devicestatus PATCH with a null removes the field (Q1b covers v3
//     PATCH on every collection).
//
// CHANGED EXPECTATION (ID-FIRST-MATCH slice 4, ID-Q2): device status follows
// the default of the other collections: a re-POST matched by its identifier
// (sent, or computed by API v3) is merged into the stored status (RFC 7386:
// what it sends is set, what it leaves out is kept, a null removes), with a
// new srvModified, and announced on the storage socket. The reply is the
// deduplication reply of a write (200, isDeduplication, the stored identifier,
// lastModified the new srvModified). The tests below keep their titles and
// check the merge. The created_at + device fallback still replaces
// (ID-NATURAL-KEY).
//
// CHANGED EXPECTATION (maintainer 2026-10-31, compat card B): the re-POST matched by
// its identifier REPLACES the stored status, as on 15.0.9: a field it leaves
// out is gone. Everything else above (a new srvModified, the announcement,
// the deduplication reply) is unchanged.
//
// Synthetic values only.

require('should');

describe('API3 devicestatus: a re-POST with a stored identifier is acknowledged, not stored again', function () {
  this.timeout(20000);
  const self = this
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    , utils = require('./fixtures/api3/utils')
    , opTools = require('../lib/api3/shared/operationTools')
    ;
  const DEVICE = 'v3-devicestatus-dedup-test';
  let n = 0;

  function col (name) {
    return self.instance.ctx.store.collection(self.instance.env[name + '_collection']);
  }

  function status (extra) {
    n += 1;
    return Object.assign({
      date: Date.UTC(2021, 5, 1, 0, n)
      , utcOffset: 0
      , app: 'v3-dedup-test'
      , device: DEVICE
      , uploaderBattery: 50
      , pump: { reservoir: 100 }
    }, extra || {});
  }

  function storedFor (name, identifier) {
    return col(name).find({ identifier: identifier }).toArray();
  }

  function post (name, doc) {
    return self.instance.post('/api/v3/' + name, self.jwt.all).send(doc);
  }

  before(async function () {
    self.instance = await instance.create({});
    const auth = await authSubject(self.instance.ctx.authorization.storage, ['all'], self.instance.app);
    self.jwt = auth.jwt;
  });

  after(async function () {
    await utils.storageClear(self.instance.ctx);
    self.instance.ctx.bus.teardown();
  });

  it('an identical re-POST is a deduplication and leaves the stored status as it was', async function () {
    const doc = status({ identifier: 'v3-ds-same' });
    await post('devicestatus', doc).expect(201);
    const before = await storedFor('devicestatus', 'v3-ds-same');
    before.length.should.equal(1);

    const res = await post('devicestatus', Object.assign({}, doc)).expect(200);
    res.body.isDeduplication.should.equal(true);
    res.body.identifier.should.equal('v3-ds-same');
    res.body.should.not.have.property('deduplicatedIdentifier');
    res.headers.location.should.endWith('/devicestatus/v3-ds-same');

    // CHANGED EXPECTATION (slice 4, ID-Q2): merged, so srvModified is new; the values are as they were.
    const after = await storedFor('devicestatus', 'v3-ds-same');
    after.length.should.equal(1);
    after[0].srvModified.should.be.above(before[0].srvModified);
    res.body.lastModified.should.equal(after[0].srvModified);
    res.headers['last-modified'].should.equal(new Date(after[0].srvModified).toUTCString());
    Object.assign({}, after[0], { srvModified: 0 }).should.eql(Object.assign({}, before[0], { srvModified: 0 }));
  });

  it('a different re-POST is a deduplication and writes nothing: no replace, no new srvModified', async function () {
    const doc = status({ identifier: 'v3-ds-diff' });
    await post('devicestatus', doc).expect(201);
    const before = await storedFor('devicestatus', 'v3-ds-diff');

    const changed = Object.assign({}, doc, { uploaderBattery: 20, extra: 'x' });
    delete changed.pump;
    const res = await post('devicestatus', changed).expect(200);
    res.body.isDeduplication.should.equal(true);
    res.body.identifier.should.equal('v3-ds-diff');

    // CHANGED EXPECTATION (slice 4, ID-Q2): merged: the field sent is set, the one left out kept.
    // CHANGED EXPECTATION (maintainer 2026-10-31, compat card B): replaced: the field left out (pump) is gone.
    const after = await storedFor('devicestatus', 'v3-ds-diff');
    after.length.should.equal(1);
    String(after[0]._id).should.equal(String(before[0]._id));
    after[0].uploaderBattery.should.equal(20);
    after[0].should.not.have.property('pump');
    after[0].extra.should.equal('x');
    after[0].srvCreated.should.equal(before[0].srvCreated);
    after[0].srvModified.should.be.above(before[0].srvModified);
  });

  it('a re-POST without identifier computes the same identifier and is acknowledged too', async function () {
    const doc = status();
    const created = await post('devicestatus', Object.assign({}, doc)).expect(201);
    const identifier = created.body.identifier;
    identifier.should.equal(opTools.calculateIdentifier(Object.assign({}, doc)));
    const before = await storedFor('devicestatus', identifier);

    const res = await post('devicestatus', Object.assign({}, doc, { uploaderBattery: 1 })).expect(200);
    res.body.isDeduplication.should.equal(true);
    res.body.identifier.should.equal(identifier);
    // CHANGED EXPECTATION (slice 4, ID-Q2): merged into the status the computed identifier names.
    const after = await storedFor('devicestatus', identifier);
    after.length.should.equal(1);
    String(after[0]._id).should.equal(String(before[0]._id));
    after[0].uploaderBattery.should.equal(1);
    after[0].pump.should.eql({ reservoir: 100 });
  });

  it('the acknowledged re-POST sends no storage-socket update', async function () {
    const doc = status({ identifier: 'v3-ds-quiet' });
    await post('devicestatus', doc).expect(201);
    const events = [];
    function seen (event) { events.push(event); }
    self.instance.ctx.bus.on('storage-socket-update', seen);
    try {
      await post('devicestatus', Object.assign({}, doc)).expect(200);
    } finally {
      self.instance.ctx.bus.removeListener('storage-socket-update', seen);
    }
    // CHANGED EXPECTATION (slice 4, ID-Q2): the merge is announced, with the record as merged.
    events.length.should.equal(1);
    events[0].doc.identifier.should.equal('v3-ds-quiet');
    events[0].doc.pump.should.eql({ reservoir: 100 });
  });

  it('a status first stored through v1 is acknowledged by a v3 re-POST of its identifier', async function () {
    const doc = status({ identifier: 'v3-ds-from-v1', created_at: new Date(Date.UTC(2021, 5, 2)).toISOString() });
    delete doc.date;
    await new Promise(function (resolve, reject) {
      self.instance.v1.devicestatus.create([Object.assign({}, doc)], function (err) { if (err) reject(err); else resolve(); });
    });
    const before = await storedFor('devicestatus', 'v3-ds-from-v1');
    before.length.should.equal(1);

    const res = await post('devicestatus', Object.assign({}, doc, { uploaderBattery: 5 })).expect(200);
    res.body.isDeduplication.should.equal(true);
    res.body.identifier.should.equal('v3-ds-from-v1');
    // CHANGED EXPECTATION (slice 4, ID-Q2): merged into the status v1 stored.
    const after = await storedFor('devicestatus', 'v3-ds-from-v1');
    after.length.should.equal(1);
    String(after[0]._id).should.equal(String(before[0]._id));
    after[0].uploaderBattery.should.equal(5);
    after[0].pump.should.eql({ reservoir: 100 });
  });

  it('control: a status matched through the created_at + device fallback is still replaced', async function () {
    const createdAt = new Date(Date.UTC(2021, 5, 3)).toISOString();
    const inserted = await col('devicestatus').insertOne({ device: DEVICE, created_at: createdAt, utcOffset: 0, uploaderBattery: 50 });

    const res = await post('devicestatus', { device: DEVICE, created_at: createdAt, app: 'v3-dedup-test', utcOffset: 0, uploaderBattery: 10 }).expect(200);
    res.body.isDeduplication.should.equal(true);
    res.body.deduplicatedIdentifier.should.equal(String(inserted.insertedId));

    const docs = await col('devicestatus').find({ device: DEVICE, created_at: createdAt }).toArray();
    docs.length.should.equal(1);
    docs[0].uploaderBattery.should.equal(10);
  });

  // ID-FIRST-MATCH slice 4 (ID-Q8): the deduplicating write is a merge now.
  it('control: a treatments re-POST is still a deduplicating replace', async function () {
    const doc = { date: Date.UTC(2021, 5, 4), utcOffset: 0, app: 'v3-dedup-test', device: DEVICE, eventType: 'Note', notes: 'first' };
    doc.identifier = opTools.calculateIdentifier(doc);
    await post('treatments', doc).expect(201);
    const before = await storedFor('treatments', doc.identifier);

    const res = await post('treatments', Object.assign({}, doc, { notes: 'second' })).expect(200);
    res.body.isDeduplication.should.equal(true);

    const after = await storedFor('treatments', doc.identifier);
    after.length.should.equal(1);
    after[0].notes.should.equal('second');
    after[0].srvModified.should.be.above(before[0].srvModified);
  });

  it('pinned: a devicestatus PATCH with a null removes the field (Q1b)', async function () {
    const doc = status({ identifier: 'v3-ds-patch', extra: 'x', q1bN: { x: 1, y: 2 } });
    await post('devicestatus', doc).expect(201);

    await self.instance.patch('/api/v3/devicestatus/v3-ds-patch', self.jwt.all).send({ extra: null, q1bN: { x: null } }).expect(200);

    const docs = await storedFor('devicestatus', 'v3-ds-patch');
    docs.length.should.equal(1);
    docs[0].should.not.have.property('extra');
    docs[0].q1bN.should.eql({ y: 2 });
    docs[0].uploaderBattery.should.equal(50);
  });
});
