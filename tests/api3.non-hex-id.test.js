/* eslint require-atomic-updates: 0 */
'use strict';

// API v3 addresses a v1 record whose `_id` is a string that is not 24-hex.
//
// API v3 gives a record without `identifier` the identifier String(_id), and
// its documentation says that identifier is used "when reading or addressing
// these documents" (lib/api3/swagger.yaml). A record can hold a non-hex string
// `_id` - a UUID in treatments or entries stored by 15.0.6 or earlier, or a
// custom id added over the websocket, which keeps it as given. v3 listed such
// a record under that identifier but looked a non-hex identifier up in the
// `identifier` field only: GET and DELETE answered 404, and PUT or POST with
// that identifier stored a second record beside it.

require('should');

describe('API3: records whose _id is a non-hex string', function () {
  const self = this
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    , utils = require('./fixtures/api3/utils')
    , ObjectID = require('mongodb').ObjectId
    ;

  self.timeout(15000);

  const ID = {
    tGet: '00000000-5f51-4000-8000-000000000001'
    , tPut: '00000000-5f51-4000-8000-000000000002'
    , tDelete: '00000000-5f51-4000-8000-000000000003'
    , tPost: '00000000-5f51-4000-8000-000000000004'
    , fGet: 'custom-food-id-5f52-0001'
    , fPut: 'custom-food-id-5f52-0002'
    , fDelete: 'custom-food-id-5f52-0003'
    , fPost: 'custom-food-id-5f52-0004'
    , v3Uuid: '00000000-5f53-4000-8000-000000000001'
    , hex: '5f53abcdef00000000000001'
  };

  // Synthetic values only.
  function treatment (n, extra) {
    const date = 1770653232000 + n * 60000;
    return Object.assign({ date: date, utcOffset: 0, app: 'non-hex-id.test', eventType: 'Note', created_at: new Date(date).toISOString(), notes: 'value ' + n }, extra || {});
  }

  function food (n, extra) {
    return Object.assign({ date: 1770653232000 + n * 60000, utcOffset: 0, app: 'non-hex-id.test', type: 'food', name: 'food ' + n, carbs: n }, extra || {});
  }

  function col (name) {
    return self.instance.ctx.store.collection(self.env[name + '_collection']);
  }

  // every stored record for this id, by _id or by identifier
  function storedFor (name, id) {
    return col(name).find({ $or: [{ _id: id }, { identifier: id }] }).toArray();
  }

  before(async () => {
    self.instance = await instance.create({});
    self.app = self.instance.app;
    self.env = self.instance.env;
    const authResult = await authSubject(self.instance.ctx.authorization.storage, ['all'], self.instance.app);
    self.jwt = authResult.jwt;
  });

  after(async () => {
    await utils.storageClear(self.instance.ctx);
    self.instance.ctx.bus.teardown();
  });

  [
    { name: 'treatments', make: treatment, get: 'tGet', put: 'tPut', del: 'tDelete', post: 'tPost', field: 'notes' }
    , { name: 'food', make: food, get: 'fGet', put: 'fPut', del: 'fDelete', post: 'fPost', field: 'name' }
  ].forEach(function (c) {
    const url = '/api/v3/' + c.name;

    describe(c.name, function () {

      it('GET /api/v3/' + c.name + '/<id> returns it', async () => {
        await col(c.name).insertOne(c.make(1, { _id: ID[c.get] }));
        const res = await self.instance.get(url + '/' + ID[c.get], self.jwt.all).expect(200);
        res.body.result.identifier.should.equal(ID[c.get]);
      });

      it('PUT /api/v3/' + c.name + '/<id> replaces it, leaving one record', async () => {
        await col(c.name).insertOne(c.make(2, { _id: ID[c.put] }));
        const edited = c.make(2);
        edited[c.field] = 'edited';
        await self.instance.put(url + '/' + ID[c.put], self.jwt.all).send(edited).expect(200);
        const stored = await storedFor(c.name, ID[c.put]);
        stored.length.should.equal(1, 'records for this id after the PUT');
        stored[0][c.field].should.equal('edited');
      });

      it('DELETE /api/v3/' + c.name + '/<id>?permanent=true removes it', async () => {
        await col(c.name).insertOne(c.make(3, { _id: ID[c.del] }));
        await self.instance.delete(url + '/' + ID[c.del] + '?permanent=true', self.jwt.all).expect(200);
        (await storedFor(c.name, ID[c.del])).length.should.equal(0);
      });

      it('POST /api/v3/' + c.name + ' with that identifier deduplicates onto it', async () => {
        await col(c.name).insertOne(c.make(4, { _id: ID[c.post] }));
        const resent = c.make(4, { identifier: ID[c.post] });
        resent[c.field] = 'resent';
        await self.instance.post(url, self.jwt.all).send(resent);
        const stored = await storedFor(c.name, ID[c.post]);
        stored.length.should.equal(1, 'records for this id after the POST');
        stored[0][c.field].should.equal('resent');
      });
    });
  });

  it('a record with a UUID identifier and an ObjectId _id is still found by that identifier (control)', async () => {
    await col('treatments').insertOne(treatment(5, { _id: new ObjectID(), identifier: ID.v3Uuid }));
    const res = await self.instance.get('/api/v3/treatments/' + ID.v3Uuid, self.jwt.all).expect(200);
    res.body.result.identifier.should.equal(ID.v3Uuid);
  });

  it('a record with an ObjectId _id is still found by its hex (control)', async () => {
    await col('treatments').insertOne(treatment(6, { _id: new ObjectID(ID.hex) }));
    await self.instance.get('/api/v3/treatments/' + ID.hex, self.jwt.all).expect(200);
  });

  describe('filters', function () {
    const filters = require('../lib/api3/storage/mongoCollection/utils');

    it('filterForOne matches a non-hex identifier as a literal _id as well', function () {
      filters.filterForOne('custom-id').should.eql({
        $or: [{ identifier: { $eq: 'custom-id' } }, { _id: { $eq: 'custom-id' } }]
      });
    });

    it('identifyingFilter matches a non-hex identifier as a literal _id of a record without identifier', function () {
      filters.identifyingFilter('custom-id').should.eql({
        $or: [{ identifier: { $eq: 'custom-id' } }, { identifier: { $exists: false }, _id: { $eq: 'custom-id' } }]
      });
    });

    it('an operator-shaped identifier is still data: no _id branch, identifier compared literally', function () {
      const op = { $ne: null };
      filters.filterForOne(op).should.eql({ $or: [{ identifier: { $eq: op } }] });
      filters.identifyingFilter(op).should.eql({ $or: [{ identifier: { $eq: op } }] });
    });

    it('an operator-looking string is compared literally, in both branches', function () {
      const text = '{"$ne":null}';
      filters.filterForOne(text).should.eql({
        $or: [{ identifier: { $eq: text } }, { _id: { $eq: text } }]
      });
    });
  });

  it('GET by an operator-looking string matches nothing, although records exist (control)', async () => {
    await self.instance.get('/api/v3/treatments/' + encodeURIComponent('{"$ne":null}'), self.jwt.all).expect(404);
  });

  it('a new identifier still creates a new record (control)', async () => {
    const res = await self.instance.post('/api/v3/treatments', self.jwt.all).send(treatment(7, { identifier: '00000000-5f53-4000-8000-000000000007' }));
    res.status.should.equal(201);
  });
});
