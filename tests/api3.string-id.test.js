/* eslint require-atomic-updates: 0 */
'use strict';

// API v3 finds a record stored through v1 with a string `_id`.
//
// v1 stored a 24-hex `_id` as the string itself for profiles, devicestatus,
// food and activity, and for treatments and entries up to 15.0.6. API v3
// addresses a v1 record by its `_id` when it has no `identifier`, but it
// asked for the ObjectId form only, so a record stored with the string form
// could not be read, replaced or deleted through v3, and a v3 create or PUT
// for the same identifier stored a second record beside it.

require('should');

describe('API3: records stored with a string _id', function () {
  const self = this
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    , utils = require('./fixtures/api3/utils')
    , ObjectID = require('mongodb').ObjectId
    ;

  self.timeout(15000);

  const HEX = {
    profileGet: '5f2300000000000000000b01'
    , profilePut: '5f2300000000000000000b02'
    , profileDelete: '5f2300000000000000000b03'
    , profileCreate: '5f2300000000000000000b04'
    , profileUpper: '5F2300000000000000000B05'
    , profileObjectId: '5f2300000000000000000a01'
    , foodGet: '5f2400000000000000000b01'
    , foodPut: '5f2400000000000000000b02'
    , foodDelete: '5f2400000000000000000b03'
    , foodCreate: '5f2400000000000000000b04'
  };

  // Synthetic values only. utcOffset is what API v3 derives from `date`, so a
  // v3 write of the same record changes no immutable field.
  function sample (app, n, extra) {
    return Object.assign({ date: 1770653232000 + n * 60000, utcOffset: 0, app: app, some_property: 'value ' + n }, extra || {});
  }

  function col (name) {
    return self.instance.ctx.store.collection(self.env[name + '_collection']);
  }

  function storedFor (name, hex) {
    return col(name).find({ _id: { $in: [new ObjectID(hex), hex, hex.toLowerCase()] } }).toArray();
  }

  function byIdentifier (name, hex) {
    return col(name).find({ identifier: hex }).toArray();
  }

  before(async () => {
    self.instance = await instance.create({});
    self.app = self.instance.app;
    self.env = self.instance.env;

    let authResult = await authSubject(self.instance.ctx.authorization.storage, ['all'], self.instance.app);
    self.jwt = authResult.jwt;
  });

  after(async () => {
    await utils.storageClear(self.instance.ctx);
    self.instance.ctx.bus.teardown();
  });

  [
    { name: 'profile', app: 'profiles.test', get: 'profileGet', put: 'profilePut', del: 'profileDelete', create: 'profileCreate' }
    , { name: 'food', app: 'food.test', get: 'foodGet', put: 'foodPut', del: 'foodDelete', create: 'foodCreate' }
  ].forEach(function (c) {
    const url = '/api/v3/' + c.name;

    describe(c.name, function () {

      it('GET /api/v3/' + c.name + '/<hex> returns it', async () => {
        const hex = HEX[c.get];
        await col(c.name).insertOne(sample(c.app, 1, { _id: hex }));

        const res = await self.instance.get(url + '/' + hex, self.jwt.all).expect(200);
        res.body.status.should.equal(200);
        res.body.result.identifier.should.equal(hex);
        res.body.result.some_property.should.equal('value 1');
      });

      it('PUT /api/v3/' + c.name + '/<hex> replaces it, leaving one record', async () => {
        const hex = HEX[c.put];
        await col(c.name).insertOne(sample(c.app, 2, { _id: hex }));

        await self.instance.put(url + '/' + hex, self.jwt.all)
          .send(sample(c.app, 2, { some_property: 'edited' }))
          .expect(200);

        const stored = (await storedFor(c.name, hex)).concat(
          (await byIdentifier(c.name, hex)).filter(function (d) { return String(d._id) !== hex; }));
        stored.length.should.equal(1, 'records for this id after the PUT');
        stored[0].some_property.should.equal('edited');
      });

      it('DELETE /api/v3/' + c.name + '/<hex>?permanent=true removes it', async () => {
        const hex = HEX[c.del];
        await col(c.name).insertOne(sample(c.app, 3, { _id: hex }));

        await self.instance.delete(url + '/' + hex + '?permanent=true', self.jwt.all).expect(200);
        (await storedFor(c.name, hex)).length.should.equal(0, 'records for this id after the DELETE');
      });

      it('POST /api/v3/' + c.name + ' with the same identifier deduplicates onto it', async () => {
        const hex = HEX[c.create];
        await col(c.name).insertOne(sample(c.app, 4, { _id: hex }));

        await self.instance.post(url, self.jwt.all)
          .send(sample(c.app, 4, { identifier: hex, some_property: 'resent' }))
          .expect(200);

        const byId = await storedFor(c.name, hex);
        const byIdent = await byIdentifier(c.name, hex);
        const all = byId.concat(byIdent.filter(function (d) { return String(d._id) !== hex; }));
        all.length.should.equal(1, 'records for this id after the POST');
        all[0].some_property.should.equal('resent');
      });
    });
  });

  it('a record stored with an upper-case string _id is returned by GET', async () => {
    await col('profile').insertOne(sample('profiles.test', 5, { _id: HEX.profileUpper }));
    const res = await self.instance.get('/api/v3/profile/' + HEX.profileUpper, self.jwt.all).expect(200);
    res.body.result.some_property.should.equal('value 5');
  });

  it('a record stored with an ObjectId _id is still returned by GET', async () => {
    await col('profile').insertOne(sample('profiles.test', 6, { _id: new ObjectID(HEX.profileObjectId) }));
    const res = await self.instance.get('/api/v3/profile/' + HEX.profileObjectId, self.jwt.all).expect(200);
    res.body.result.identifier.should.equal(HEX.profileObjectId);
  });
});
