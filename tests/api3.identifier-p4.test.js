'use strict';

// P4 on API v3 PUT and PATCH /{identifier} (ID-FIRST-MATCH slice 5, ID-Q5,
// ID-Q10): when the route's identifier names more than one stored record, the
// write lands on the record whose time key equals the body's (created_at for
// treatments, sysTime or date for entries), else on the newest by _id. A PATCH
// that sends no time key takes the newest, as before. Before, both read the
// newest and wrote by identifier, so an edit of the older half of a chart
// split was refused (immutable date) or reached the other half. Every such
// pick is logged without the identifier; the cache takes only the written
// record.
//
// The records are stored straight to MongoDB, as the chart split stored two
// halves under one identifier before BF-212's fix. Synthetic values only.

const should = require('should');
const crypto = require('crypto');
const { onlyIn } = require('./fixtures/api3/role');

describe('API3 PUT and PATCH: an identifier that names two stored records reaches the one P4 picks', function () {
  const self = this
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    , utils = require('./fixtures/api3/utils')
    , APP = 'p4-v3-lab'
    , DEVICE = 'p4-v3-device'
    , MIN = 60000
    ;

  self.timeout(15000);

  let warnings, updates;
  const realWarn = console.warn;

  const col = (name) => self.instance.ctx.store.collection(self.instance.env[name + '_collection'] || name);
  const newId = () => crypto.randomUUID();
  const iso = (t) => new Date(t).toISOString();

  // A, then B two minutes later with another amount, one identifier; each
  // with its own _id, as the chart split stored them.
  async function seedTreatments (identifier, t) {
    const now = Date.now();
    const base = { identifier, eventType: 'Carb Correction', app: APP, device: DEVICE, utcOffset: 0
      , srvCreated: now, srvModified: now };
    const a = Object.assign({}, base, { date: t, created_at: iso(t), carbs: 12, half: 'a' });
    const b = Object.assign({}, base, { date: t + 2 * MIN, created_at: iso(t + 2 * MIN), carbs: 20, half: 'b' });
    await col('treatments').insertOne(a);
    await col('treatments').insertOne(b);
    return { a, b };
  }

  async function seedEntries (identifier, t) {
    const now = Date.now();
    const base = { identifier, type: 'sgv', app: APP, device: DEVICE, utcOffset: 0, srvCreated: now, srvModified: now };
    const a = Object.assign({}, base, { date: t, dateString: iso(t), sysTime: iso(t), sgv: 100, half: 'a' });
    const b = Object.assign({}, base, { date: t + 2 * MIN, dateString: iso(t + 2 * MIN), sysTime: iso(t + 2 * MIN)
      , sgv: 120, half: 'b' });
    await col('entries').insertOne(a);
    await col('entries').insertOne(b);
    return { a, b };
  }

  async function halves (name, identifier) {
    const out = {};
    (await col(name).find({ identifier }).toArray()).forEach((doc) => { out[doc.half] = doc; });
    return out;
  }

  const picks = () => warnings.filter((line) => line.indexOf('identifier names') !== -1);

  before(async () => {
    self.instance = await instance.create({});
    const authResult = await authSubject(self.instance.ctx.authorization.storage, ['all'], self.instance.app);
    self.jwt = authResult.jwt;
    self.instance.ctx.bus.on('data-update', (update) => { if (updates) updates.push(update); });
  });

  after(async () => {
    await utils.storageClear(self.instance.ctx);
    self.instance.ctx.bus.teardown();
  });

  beforeEach(() => {
    warnings = [];
    updates = [];
    console.warn = function (...args) { warnings.push(args.join(' ')); };
  });

  afterEach(() => {
    console.warn = realWarn;
    updates = null;
  });

  it('PUT with A\'s time replaces A, not B, and the pick is logged without the identifier', async () => {
    const identifier = newId();
    const t = Date.now() - 60 * MIN;
    const { a } = await seedTreatments(identifier, t);

    const res = await self.instance.put(`/api/v3/treatments/${identifier}`, self.jwt.all)
      .send({ date: a.date, utcOffset: 0, app: APP, device: DEVICE, eventType: 'Carb Correction', carbs: 15, half: 'a' })
      .expect(200);
    res.body.status.should.equal(200);
    should.not.exist(res.body.isDeduplication);

    const stored = await halves('treatments', identifier);
    stored.a.carbs.should.equal(15);
    stored.a.srvModified.should.be.above(a.srvModified);
    stored.b.carbs.should.equal(20);
    stored.b.srvModified.should.equal(stored.b.srvCreated);

    picks().length.should.equal(1);
    picks()[0].should.containEql('treatments v3 PUT');
    picks()[0].should.containEql(String(stored.a._id) + ' (same time)');
    picks()[0].should.not.containEql(identifier);
  });

  it('PATCH with B\'s time patches B, not A', async () => {
    const identifier = newId();
    const t = Date.now() - 50 * MIN;
    const { b } = await seedTreatments(identifier, t);

    await self.instance.patch(`/api/v3/treatments/${identifier}`, self.jwt.all)
      .send({ created_at: b.created_at, notes: 'edited' })
      .expect(200);

    const stored = await halves('treatments', identifier);
    stored.b.notes.should.equal('edited');
    should.not.exist(stored.a.notes);
    picks().length.should.equal(1);
    picks()[0].should.containEql('treatments v3 PATCH');
    picks()[0].should.containEql(String(stored.b._id) + ' (same time)');
  });

  it('PATCH with A\'s time patches A, which the newest-only read refused (immutable date)', async () => {
    const identifier = newId();
    const t = Date.now() - 45 * MIN;
    const { a } = await seedTreatments(identifier, t);

    await self.instance.patch(`/api/v3/treatments/${identifier}`, self.jwt.all)
      .send({ date: a.date, created_at: a.created_at, notes: 'edited' })
      .expect(200);

    const stored = await halves('treatments', identifier);
    stored.a.notes.should.equal('edited');
    should.not.exist(stored.b.notes);
  });

  it('PATCH with no time key patches the newest (B), as before', async () => {
    const identifier = newId();
    const t = Date.now() - 40 * MIN;
    await seedTreatments(identifier, t);

    await self.instance.patch(`/api/v3/treatments/${identifier}`, self.jwt.all)
      .send({ notes: 'edited' })
      .expect(200);

    const stored = await halves('treatments', identifier);
    stored.b.notes.should.equal('edited');
    should.not.exist(stored.a.notes);
    picks().length.should.equal(1);
    picks()[0].should.containEql(String(stored.b._id) + ' (newest)');
  });

  it('entries: PATCH with A\'s date patches A, not B', async () => {
    const identifier = newId();
    const t = Date.now() - 35 * MIN;
    const { a } = await seedEntries(identifier, t);

    await self.instance.patch(`/api/v3/entries/${identifier}`, self.jwt.all)
      .send({ date: a.date, noise: 1 })
      .expect(200);

    const stored = await halves('entries', identifier);
    stored.a.noise.should.equal(1);
    should.not.exist(stored.b.noise);
    picks()[0].should.containEql('entries v3 PATCH');
  });

  it('one record with the identifier: PUT and PATCH write it, and nothing is logged', async () => {
    const identifier = newId();
    const t = Date.now() - 30 * MIN;
    const now = Date.now();
    await col('treatments').insertOne({ identifier, eventType: 'Carb Correction', app: APP, device: DEVICE, utcOffset: 0
      , date: t, created_at: iso(t), carbs: 12, half: 'a', srvCreated: now, srvModified: now });

    await self.instance.put(`/api/v3/treatments/${identifier}`, self.jwt.all)
      .send({ date: t, utcOffset: 0, app: APP, device: DEVICE, eventType: 'Carb Correction', carbs: 14, half: 'a' })
      .expect(200);
    await self.instance.patch(`/api/v3/treatments/${identifier}`, self.jwt.all)
      .send({ notes: 'edited' })
      .expect(200);

    const docs = await col('treatments').find({ identifier }).toArray();
    docs.length.should.equal(1);
    docs[0].carbs.should.equal(14);
    docs[0].notes.should.equal('edited');
    picks().length.should.equal(0);
  });

  it('a picked record that is soft deleted is answered 410, as the newest one was', async () => {
    const identifier = newId();
    const t = Date.now() - 25 * MIN;
    const { a } = await seedTreatments(identifier, t);
    await col('treatments').updateOne({ identifier, half: 'a' }, { $set: { isValid: false } });

    await self.instance.patch(`/api/v3/treatments/${identifier}`, self.jwt.all)
      .send({ created_at: a.created_at, notes: 'edited' })
      .expect(410);

    const stored = await halves('treatments', identifier);
    should.not.exist(stored.a.notes);
    should.not.exist(stored.b.notes);
  });

  onlyIn('single', 'subject is the cache').it('the cache takes the written record (A), not the newest', async () => {
    const identifier = newId();
    const t = Date.now() - 20 * MIN;
    const { a } = await seedTreatments(identifier, t);

    await self.instance.put(`/api/v3/treatments/${identifier}`, self.jwt.all)
      .send({ date: a.date, utcOffset: 0, app: APP, device: DEVICE, eventType: 'Carb Correction', carbs: 16, half: 'a' })
      .expect(200);
    await self.instance.patch(`/api/v3/treatments/${identifier}`, self.jwt.all)
      .send({ created_at: a.created_at, notes: 'edited' })
      .expect(200);

    const stored = await halves('treatments', identifier);
    const mine = updates.filter((u) => u.type === 'treatments' && u.op === 'update');
    mine.length.should.equal(2);
    mine.forEach((u) => {
      u.changes.length.should.equal(1);
      String(u.changes[0]._id).should.equal(String(stored.a._id));
    });
    mine[0].changes[0].carbs.should.equal(16);
    mine[1].changes[0].notes.should.equal('edited');
  });
});
