'use strict';

// identifier-held (ID-RULE1-EDIT, decided by the maintainer 2026-10-30) on
// API v3. A PATCH whose body `identifier` is not the addressed record's own
// and is held by another stored record (soft deleted included) is answered
// 409, nothing written; before, it was the immutable-field 400. A body
// identifier no other record holds keeps that 400. A PUT stores the route's
// identifier whatever the body sends, so it never carries another record's
// identifier: it is answered as before. The same under WRITE_IDENTIFIER
// lenient and strict. Synthetic values only.

const should = require('should');
const crypto = require('crypto');

describe('API3 identifier-held: a PATCH carrying another record\'s identifier is refused 409', function () {
  const self = this
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    , utils = require('./fixtures/api3/utils')
    , apiConst = require('../lib/api3/const.json')
    , MESSAGE = 'identifier is held by another record'
    , APP = 'held-v3-lab'
    , DEVICE = 'held-v3-device'
    , MIN = 60000
    ;

  self.timeout(15000);

  let updates;
  const col = () => self.instance.ctx.store.collection(self.instance.env.treatments_collection || 'treatments');

  async function seed (yFields, xFields) {
    const t = Date.now() - 90 * MIN;
    const now = Date.now();
    const base = { eventType: 'Note', app: APP, device: DEVICE, utcOffset: 0, srvCreated: now, srvModified: now };
    const x = Object.assign({}, base, { identifier: crypto.randomUUID(), date: t, created_at: new Date(t).toISOString(), notes: 'x' }, xFields);
    const y = Object.assign({}, base, { identifier: crypto.randomUUID(), date: t + MIN, created_at: new Date(t + MIN).toISOString(), notes: 'y' }, yFields);
    await col().insertOne(x);
    await col().insertOne(y);
    return { x, y };
  }

  async function both (pair) {
    return {
      x: JSON.parse(JSON.stringify(await col().findOne({ _id: pair.x._id })))
      , y: JSON.parse(JSON.stringify(await col().findOne({ _id: pair.y._id })))
    };
  }

  const patch = (identifier, body) => self.instance.patch(`/api/v3/treatments/${identifier}`, self.jwt.all).send(body);

  function setMode (identifier) {
    const env = self.instance.env;
    env.write = Object.freeze(Object.assign({}, env.write, { identifier }));
  }

  before(async () => {
    self.instance = await instance.create({});
    const authResult = await authSubject(self.instance.ctx.authorization.storage, ['all'], self.instance.app);
    self.jwt = authResult.jwt;
    self.instance.ctx.bus.on('data-update', (update) => { if (updates) updates.push(update); });
  });

  after(async () => {
    setMode('lenient');
    await utils.storageClear(self.instance.ctx);
    self.instance.ctx.bus.teardown();
  });

  beforeEach(() => { updates = []; setMode('lenient'); });
  afterEach(() => { updates = null; });

  for (const mode of ['lenient', 'strict']) {
    it(`PATCH X with Y's identifier (${mode}): 409, the one message, X and Y unchanged, no cache update`, async () => {
      setMode(mode);
      const pair = await seed();
      const before = await both(pair);
      const res = await patch(pair.x.identifier, { identifier: pair.y.identifier, notes: 'changed' }).expect(409);
      res.body.should.eql({ status: 409, message: MESSAGE });
      JSON.stringify(res.body).should.not.containEql(pair.y.identifier);
      (await both(pair)).should.eql(before);
      updates.should.eql([]);
    });
  }

  it('PATCH X with the identifier of a soft-deleted Y: 409, nothing written', async () => {
    const pair = await seed({ isValid: false });
    const before = await both(pair);
    await patch(pair.x.identifier, { identifier: pair.y.identifier, notes: 'changed' }).expect(409);
    (await both(pair)).should.eql(before);
  });

  it('PATCH X with an identifier no other record holds: the immutable-field 400, as before', async () => {
    const pair = await seed();
    const res = await patch(pair.x.identifier, { identifier: crypto.randomUUID(), notes: 'changed' }).expect(400);
    res.body.message.should.equal(apiConst.MSG.HTTP_400_IMMUTABLE_FIELD.replace('{0}', 'identifier'));
  });

  it('PATCH X with its own identifier, or none: written', async () => {
    const pair = await seed();
    await patch(pair.x.identifier, { identifier: pair.x.identifier, notes: 'own' }).expect(200);
    (await both(pair)).x.notes.should.equal('own');
    await patch(pair.x.identifier, { notes: 'none' }).expect(200);
    (await both(pair)).x.notes.should.equal('none');
  });

  it('PATCH a soft-deleted X with Y\'s identifier: 410, as before', async () => {
    const pair = await seed({}, { isValid: false });
    await patch(pair.x.identifier, { identifier: pair.y.identifier, notes: 'changed' }).expect(410);
  });

  it('PUT X with Y\'s identifier in the body: the route\'s identifier is stored, as before; Y unchanged', async () => {
    const pair = await seed();
    const before = await both(pair);
    await self.instance.put(`/api/v3/treatments/${pair.x.identifier}`, self.jwt.all)
      .send({ identifier: pair.y.identifier, date: pair.x.date, utcOffset: 0, app: APP, device: DEVICE, eventType: 'Note', notes: 'put' })
      .expect(200);
    const after = await both(pair);
    after.x.identifier.should.equal(pair.x.identifier);
    after.x.notes.should.equal('put');
    after.y.should.eql(before.y);
  });
});
