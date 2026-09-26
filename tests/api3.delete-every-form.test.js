/* eslint require-atomic-updates: 0 */
'use strict';

// An API v3 DELETE removes every stored form of the record it names.
//
// A record can be stored twice under one 24-hex id: once with the string
// `_id` (v1 stored it that way up to 15.0.6) and once with the ObjectId (a v1
// edit on 15.0.8 or earlier added it beside the first). v1 DELETE and the
// websocket dbRemove remove both (BF-110). A v3 DELETE marked or removed only
// one, so the other stayed valid and a deleted treatment kept showing in v1
// and v3 reads (BF-117).

require('should');

describe('API3: DELETE across stored identifier forms', function () {
  const self = this
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    , utils = require('./fixtures/api3/utils')
    , ObjectID = require('mongodb').ObjectId
    ;

  self.timeout(15000);

  const HEX = {
    soft: '5f2500000000000000000c01'
    , permanent: '5f2500000000000000000c02'
    , other: '5f2500000000000000000c03'
    , read: '5f2500000000000000000c04'
    , readReversed: '5f2500000000000000000c06'
    , patch: '5f2500000000000000000c05'
    , patchReversed: '5f2500000000000000000c07'
  };

  // Synthetic values only.
  function sample (n, extra) {
    return Object.assign({
      created_at: new Date(Date.UTC(2021, 5, 1, 0, n)).toISOString()
      , eventType: 'Note'
      , notes: 'delete-every-form ' + n
      , enteredBy: 'delete-every-form-test'
    }, extra || {});
  }

  function col () {
    return self.instance.ctx.store.collection(self.env.treatments_collection);
  }

  function storedFor (hex) {
    return col().find({ _id: { $in: [new ObjectID(hex), hex] } }).toArray();
  }

  // The ObjectId copy is the one an edit on 15.0.8 or earlier added beside
  // the string copy, so it holds the edit. Which copy an unsorted read meets
  // first depends on the order they were stored in, so tests that pick one
  // copy run in both orders.
  async function seedTwin (hex, n, objectIdFirst) {
    const stringCopy = sample(n, { _id: hex, notes: 'string copy' });
    const objectIdCopy = sample(n, { _id: new ObjectID(hex), notes: 'edited copy' });
    for (const doc of objectIdFirst ? [objectIdCopy, stringCopy] : [stringCopy, objectIdCopy]) {
      await col().insertOne(doc);
    }
  }

  before(async () => {
    self.instance = await instance.create({});
    self.app = self.instance.app;
    self.env = self.instance.env;
    self.app.use('/api/v1', require('../lib/api')(self.env, self.instance.ctx));

    let authResult = await authSubject(self.instance.ctx.authorization.storage, ['all'], self.instance.app);
    self.jwt = authResult.jwt;
    self.accessToken = authResult.accessToken.all;
  });

  after(async () => {
    await col().deleteMany({ enteredBy: 'delete-every-form-test' });
    await utils.storageClear(self.instance.ctx);
    self.instance.ctx.bus.teardown();
  });

  [false, true].forEach(function (objectIdFirst) {
    const order = objectIdFirst ? ' (ObjectId copy stored first)' : ' (string copy stored first)';

    it('GET returns the ObjectId copy, which holds the edit' + order, async () => {
      const hex = objectIdFirst ? HEX.readReversed : HEX.read;
      await seedTwin(hex, 4, objectIdFirst);
      const res = await self.instance.get('/api/v3/treatments/' + hex, self.jwt.all).expect(200);
      res.body.result.notes.should.equal('edited copy');
    });

    it('PATCH writes the ObjectId copy' + order, async () => {
      const hex = objectIdFirst ? HEX.patchReversed : HEX.patch;
      await seedTwin(hex, 5, objectIdFirst);
      await self.instance.patch('/api/v3/treatments/' + hex, self.jwt.all)
        .send({ notes: 'patched' }).expect(200);
      const objectIdCopy = await col().findOne({ _id: new ObjectID(hex) });
      objectIdCopy.notes.should.equal('patched');
      const stringCopy = await col().findOne({ _id: hex });
      stringCopy.notes.should.equal('string copy');
    });
  });

  it('DELETE marks both copies deleted, and GET answers 410', async () => {
    await seedTwin(HEX.soft, 1);
    await col().insertOne(sample(3, { _id: new ObjectID(HEX.other) }));

    await self.instance.delete('/api/v3/treatments/' + HEX.soft, self.jwt.all).expect(200);

    const stored = await storedFor(HEX.soft);
    stored.length.should.equal(2);
    stored.forEach(function (doc) {
      doc.isValid.should.equal(false, 'copy with a ' + typeof doc._id + ' _id is marked deleted');
    });
    await self.instance.get('/api/v3/treatments/' + HEX.soft, self.jwt.all).expect(410);

    // control: a record with another id is not touched
    const other = await col().findOne({ _id: new ObjectID(HEX.other) });
    (other.isValid === undefined).should.equal(true, 'the other record was written');
  });

  it('DELETE ?permanent=true removes both copies', async () => {
    await seedTwin(HEX.permanent, 2);

    await self.instance.delete('/api/v3/treatments/' + HEX.permanent + '?permanent=true', self.jwt.all).expect(200);

    (await storedFor(HEX.permanent)).length.should.equal(0, 'copies left after the DELETE');
    (await col().countDocuments({ _id: new ObjectID(HEX.other) })).should.equal(1, 'the other record');
  });

  // v1 accepts null and empty identifiers. v3 exposes the record's _id for
  // both, just as it does when identifier is absent, so that public identifier
  // must also work for both kinds of DELETE.
  [false, true].forEach(function (permanent) {
    const suffix = permanent ? '?permanent=true' : '';

    async function deleteAndVerify (id, storedIds) {
      const url = '/api/v3/treatments/' + id;
      const read = await self.instance.get(url, self.jwt.all).expect(200);
      read.body.result.identifier.should.equal(id);

      await self.instance.delete(url + suffix, self.jwt.all).expect(200);

      const stored = await col().find({ _id: { $in: storedIds } }).toArray();
      stored.length.should.equal(permanent ? 0 : storedIds.length);
      stored.forEach(function (doc) { doc.isValid.should.equal(false); });
      await self.instance.get(url, self.jwt.all).expect(permanent ? 404 : 410);
    }

    [
      { label: 'absent', fields: {} }
      , { label: 'null', fields: { identifier: null } }
      , { label: 'empty', fields: { identifier: '' } }
    ].forEach(function (shape) {
      it('DELETE' + suffix + ' removes a v1-created treatment with identifier ' + shape.label, async () => {
        const id = new ObjectID();
        await self.instance.post('/api/v1/treatments')
          .set('api-secret', self.accessToken)
          .send(sample(10, Object.assign({ _id: id.toHexString() }, shape.fields)))
          .expect(200);

        const stored = await col().findOne({ _id: id });
        if (shape.label === 'absent') stored.should.not.have.property('identifier');
        else stored.should.have.property('identifier', shape.fields.identifier);

        await deleteAndVerify(id.toHexString(), [id]);
      });
    });

    // Upgraded sites can also hold hex strings or custom strings as _id.
    [null, ''].forEach(function (identifier) {
      ['hex', 'custom'].forEach(function (form) {
        it('DELETE' + suffix + ' removes a legacy ' + form + ' string _id with identifier ' + JSON.stringify(identifier), async () => {
          const id = (form === 'custom' ? 'legacy-' : '') + new ObjectID().toHexString();
          await col().insertOne(sample(11, { _id: id, identifier }));
          await deleteAndVerify(id, [id]);
        });
      });
    });

    it('DELETE' + suffix + ' removes both ObjectId and string copies with empty identifiers', async () => {
      const id = new ObjectID();
      await col().insertMany([
        sample(12, { _id: id, identifier: null })
        , sample(12, { _id: id.toHexString(), identifier: '' })
      ]);
      await deleteAndVerify(id.toHexString(), [id, id.toHexString()]);
    });
  });

  // A document with an identifier of its own is addressed by it, even when
  // its _id is the identifier another document is deleted by.
  [false, true].forEach(function (permanent) {
    ['hex', 'custom'].forEach(function (form) {
      ['string', 'array'].forEach(function (shape) {
        it('DELETE' + (permanent ? ' ?permanent=true' : '') + ' leaves a matching ' + form + ' _id with its own ' + shape + ' identifier', async () => {
          const objectId = new ObjectID();
          const id = (form === 'custom' ? 'legacy-' : '') + objectId.toHexString();
          const unrelatedId = form === 'custom' ? id : objectId;
          const identifier = shape === 'array' ? [null, '', 'another-record-' + id] : 'another-record-' + id;
          await col().insertOne(sample(6, { _id: new ObjectID(), identifier: id, notes: 'addressed' }));
          await col().insertOne(sample(7, { _id: unrelatedId, identifier, notes: 'unrelated' }));

          await self.instance.delete('/api/v3/treatments/' + id + (permanent ? '?permanent=true' : ''), self.jwt.all).expect(200);

          const unrelated = await col().findOne({ _id: unrelatedId });
          unrelated.should.be.ok();
          unrelated.identifier.should.eql(identifier);
          (unrelated.isValid === undefined).should.equal(true, 'the unrelated record was written');
          const addressed = await col().find({ identifier: id }).toArray();
          if (permanent) addressed.length.should.equal(0);
          else addressed[0].isValid.should.equal(false);
        });
      });
    });
  });

  it('DELETE of an id with no record answers 404', async () => {
    await self.instance.delete('/api/v3/treatments/5f2500000000000000000cff', self.jwt.all).expect(404);
  });
});
