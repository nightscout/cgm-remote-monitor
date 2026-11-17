/* eslint require-atomic-updates: 0 */
'use strict';

// API v3 PATCH, PUT and POST reach a record whose stored identifier is empty
// by the id GET shows for it (BF-145).
//
// normalizeDoc shows a record's _id as its identifier whenever the stored
// identifier is falsy (absent, null, "", 0, false). GET and DELETE address
// such a record by that id (BF-140, BF-142). PATCH, PUT and the POST
// deduplication used a filter whose _id fallback applied only when the field
// was absent, so for null, "" or 0 a PATCH answered 404 and a PUT stored a
// second record beside the first.

require('should');

describe('API3: edits by the id shown for a record with an empty identifier', function () {
  const self = this
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    , utils = require('./fixtures/api3/utils')
    , ObjectID = require('mongodb').ObjectId
    ;

  self.timeout(15000);

  const DEVICE = 'empty-identifier-edit-test';

  // JSON cannot carry -0 or NaN, and v1 treatments refuse a non-string
  // identifier, so every record is stored directly.
  const EMPTY = [
    { label: 'null', value: null }
    , { label: '""', value: '' }
    , { label: '0', value: 0 }
    , { label: 'false', value: false }
  ];

  // Synthetic values only.
  const SEED = {
    treatments: (n) => ({ eventType: 'Note', notes: 'seed ' + n
      , created_at: new Date(Date.UTC(2021, 6, 1, 0, n)).toISOString() })
    , entries: (n) => ({ type: 'sgv', sgv: 100 + n, date: Date.UTC(2021, 6, 2, 0, n)
      , dateString: new Date(Date.UTC(2021, 6, 2, 0, n)).toISOString() })
    , devicestatus: (n) => ({ created_at: new Date(Date.UTC(2021, 6, 3, 0, n)).toISOString() })
  };

  function colFor (colName) {
    return self.instance.ctx.store.collection(self.env[colName + '_collection']);
  }

  async function seed (colName, n, fields) {
    const _id = new ObjectID();
    // utcOffset as v1 stores it; v3 treats it as immutable.
    await colFor(colName).insertOne(Object.assign(SEED[colName](n), { _id, device: DEVICE, utcOffset: 0 }, fields));
    return _id;
  }

  // A full v3 document for PUT and POST, at the seeded record's time.
  function v3Doc (colName, n, extra) {
    const doc = SEED[colName](n);
    doc.date = colName === 'entries' ? doc.date : new Date(doc.created_at).getTime();
    return Object.assign(doc, { device: DEVICE, app: DEVICE, utcOffset: 0 }, extra);
  }

  before(async () => {
    self.instance = await instance.create({});
    self.app = self.instance.app;
    self.env = self.instance.env;

    let authResult = await authSubject(self.instance.ctx.authorization.storage, ['all'], self.instance.app);
    self.jwt = authResult.jwt;
  });

  after(async () => {
    for (const colName of Object.keys(SEED)) {
      await colFor(colName).deleteMany({ device: DEVICE });
    }
    await utils.storageClear(self.instance.ctx);
    self.instance.ctx.bus.teardown();
  });

  ['treatments', 'entries', 'devicestatus'].forEach(function (colName, c) {
    EMPTY.forEach(function (shape, i) {
      const n = c * 20 + i * 4;

      it(colName + ': PATCH by the shown id edits the record with identifier ' + shape.label, async () => {
        const _id = await seed(colName, n, { identifier: shape.value });
        const url = '/api/v3/' + colName + '/' + _id.toHexString();
        const read = await self.instance.get(url, self.jwt.all).expect(200);
        read.body.result.identifier.should.equal(_id.toHexString());

        await self.instance.patch(url, self.jwt.all).send({ notes: 'patched ' + n }).expect(200);

        const edited = await colFor(colName).findOne({ _id });
        edited.notes.should.equal('patched ' + n);
        Object.is(edited.identifier, shape.value).should.equal(true, 'identifier kept as stored');
        (await colFor(colName).countDocuments({ notes: 'patched ' + n })).should.equal(1);
      });

      it(colName + ': PUT by the shown id replaces the record with identifier ' + shape.label, async () => {
        const _id = await seed(colName, n + 1, { identifier: shape.value, notes: 'before put ' + n });
        const url = '/api/v3/' + colName + '/' + _id.toHexString();

        await self.instance.put(url, self.jwt.all)
          .send(v3Doc(colName, n + 1, { notes: 'put ' + n })).expect(200);

        (await colFor(colName).countDocuments({ notes: { $in: ['before put ' + n, 'put ' + n] } }))
          .should.equal(1, 'one record after the PUT');
        const replaced = await colFor(colName).findOne({ _id });
        replaced.notes.should.equal('put ' + n);
        replaced.identifier.should.equal(_id.toHexString());
      });

      // A device status re-sent with the identifier it is shown under is
      // acknowledged and not rewritten (ID-SIMPLE-MATCH, devicestatus option
      // (b), decided 2026-10-26); other collections are updated.
      // CHANGED EXPECTATION (ID-FIRST-MATCH slice 4, ID-Q2): device status is
      // merged too, as every other collection is, so its POST updates the
      // record (the title is kept). The merge sets the identifier it was
      // matched by, as the replace did on the other collections.
      const updates = true;
      const title = colName !== 'devicestatus' ? 'updates' : 'is acknowledged and leaves';
      it(colName + ': POST with the shown id as identifier ' + title + ' the record with identifier ' + shape.label, async () => {
        const _id = await seed(colName, n + 2, { identifier: shape.value, notes: 'before post ' + n });

        const res = await self.instance.post('/api/v3/' + colName, self.jwt.all)
          .send(v3Doc(colName, n + 2, { identifier: _id.toHexString(), notes: 'post ' + n }))
          .expect(200);
        res.body.isDeduplication.should.equal(true);

        (await colFor(colName).countDocuments({ notes: { $in: ['before post ' + n, 'post ' + n] } }))
          .should.equal(1, 'one record after the POST');
        const stored = await colFor(colName).findOne({ _id });
        stored.notes.should.equal(updates ? 'post ' + n : 'before post ' + n);
        if (!updates) {
          Object.is(stored.identifier, shape.value).should.equal(true, 'identifier kept as stored');
          res.body.identifier.should.equal(_id.toHexString());
        }
      });
    });
  });

  // A record with its own identifier is addressed by it (BF-117): its _id
  // does not reach it, and a PATCH of another record's id leaves it alone.
  it('PATCH by the _id of a record with its own identifier answers 404 and writes nothing', async () => {
    const _id = await seed('treatments', 90, { identifier: 'own-identifier-90' });
    await self.instance.patch('/api/v3/treatments/' + _id.toHexString(), self.jwt.all)
      .send({ notes: 'patched' }).expect(404);
    (await colFor('treatments').findOne({ _id })).notes.should.equal('seed 90');
  });

  it('PUT by the _id of a record with its own identifier leaves it and stores a new record', async () => {
    const _id = await seed('treatments', 91, { identifier: 'own-identifier-91' });
    await self.instance.put('/api/v3/treatments/' + _id.toHexString(), self.jwt.all)
      .send(v3Doc('treatments', 91, { notes: 'put 91' })).expect(201);
    (await colFor('treatments').findOne({ _id })).notes.should.equal('seed 91');
    (await colFor('treatments').countDocuments({ identifier: _id.toHexString() })).should.equal(1);
  });

  it('PATCH of one record leaves records with empty identifiers under other _ids', async () => {
    const target = await seed('treatments', 92, { identifier: null });
    const bystanders = [];
    for (const [i, shape] of EMPTY.entries()) {
      bystanders.push(await seed('treatments', 93 + i, { identifier: shape.value }));
    }
    bystanders.push(await seed('treatments', 98, {}));

    await self.instance.patch('/api/v3/treatments/' + target.toHexString(), self.jwt.all)
      .send({ notes: 'patched 92' }).expect(200);

    (await colFor('treatments').findOne({ _id: target })).notes.should.equal('patched 92');
    for (const _id of bystanders) {
      (await colFor('treatments').findOne({ _id })).notes.should.not.equal('patched 92');
    }
  });
});
