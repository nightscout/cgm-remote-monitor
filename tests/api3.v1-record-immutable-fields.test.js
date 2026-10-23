'use strict';

// API v3 writes to a record that was created through API v1.
//
// API v3 refuses a write that changes a field it treats as immutable. A record
// created through v1 has no `app`, `device` or `isValid`, and a careportal
// record has no `date` either (its time is `created_at`). Sending one of those
// fields was treated as a change, so v3 could not deduplicate onto such a
// record (POST without identifier), replace it (PUT) or patch it with
// `isValid: true` as AndroidAPS does: each answered 400 "Field ... cannot be
// modified by the client". A value the record already has still cannot be
// changed, and the server-managed fields stay refused.

require('should');

describe('API3: writes to a record created through API v1', function () {
  const self = this
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    , utils = require('./fixtures/api3/utils')
    ;

  self.timeout(15000);

  const url = '/api/v3/treatments';
  let slot = 0;
  // synthetic times, whole ms, one slot per test
  const nextT = () => 1770653232123 + (slot++) * 120000;
  const iso = (ms) => new Date(ms).toISOString();

  // stored the way POST /api/v1/treatments stores a careportal entry
  function v1Create (doc) {
    return new Promise((resolve, reject) => {
      self.instance.ctx.treatments.create([doc], (err, docs) => {
        if (err) return reject(err);
        resolve(docs[0]);
      });
    });
  }

  function careportal (T, carbs, extra) {
    return v1Create(Object.assign({
      eventType: carbs < 12 ? 'Carb Correction' : 'Meal Bolus', created_at: iso(T), carbs: carbs,
      enteredBy: 'careportal-test', notes: 'careportal ' + carbs + ' g'
    }, extra || {}));
  }

  // the shape AndroidAPS uploads carbs with (no identifier, no device)
  function aapsCarbs (T, carbs) {
    return {
      eventType: carbs < 12 ? 'Carb Correction' : 'Meal Bolus', date: T, utcOffset: 0, app: 'AAPS',
      isValid: true, carbs: carbs, pumpId: T, pumpType: 'USER', pumpSerial: 'test'
    };
  }

  function storedAt (T) {
    return self.instance.ctx.store.collection(self.env.treatments_collection)
      .find({ $or: [{ created_at: iso(T) }, { date: T }] }).toArray();
  }

  function stored (id) {
    return self.instance.ctx.store.collection(self.env.treatments_collection).findOne({ _id: id });
  }

  before(async () => {
    self.instance = await instance.create({});
    self.env = self.instance.env;
    const authResult = await authSubject(self.instance.ctx.authorization.storage, ['all'], self.instance.app);
    self.jwt = authResult.jwt;
  });

  after(async () => {
    await utils.storageClear(self.instance.ctx);
    self.instance.ctx.bus.teardown();
  });

  describe('the v1 record lacks the field', function () {

    it('stores a careportal record without date, app, device or isValid', async () => {
      const T = nextT();
      const d = await careportal(T, 20);
      const s = await stored(d._id);
      s.should.not.have.properties('date', 'app', 'device', 'isValid', 'identifier');
      s.should.have.properties('created_at', 'utcOffset', 'eventType');
    });

    it('POST without identifier deduplicates onto a careportal record', async () => {
      const T = nextT();
      const d = await careportal(T, 20);
      const res = await self.instance.post(url, self.jwt.all).send(aapsCarbs(T, 20));
      res.body.should.not.have.property('message');
      res.status.should.equal(200);
      res.body.isDeduplication.should.equal(true);
      res.body.deduplicatedIdentifier.should.equal(d._id.toString());
      const after = await storedAt(T);
      after.length.should.equal(1);
      after[0].app.should.equal('AAPS');
      after[0].carbs.should.equal(20);
    });

    it('POST without identifier deduplicates onto a v1 record that carries date', async () => {
      const T = nextT();
      await careportal(T, 20, { date: T });
      const res = await self.instance.post(url, self.jwt.all).send(aapsCarbs(T, 20));
      res.body.should.not.have.property('message');
      res.status.should.equal(200);
      res.body.isDeduplication.should.equal(true);
    });

    it('a deduplicating POST with other carbs replaces the whole v1 record', async () => {
      // v3 deduplication is created_at + eventType and replaces the document;
      // the amounts are not compared (see BF-121).
      const T = nextT();
      await careportal(T, 20);
      const res = await self.instance.post(url, self.jwt.all).send(aapsCarbs(T, 30));
      res.status.should.equal(200);
      res.body.isDeduplication.should.equal(true);
      const after = await storedAt(T);
      after.length.should.equal(1);
      after[0].carbs.should.equal(30);
      after[0].should.not.have.properties('notes', 'enteredBy');
    });

    it('a POST whose eventType differs is not deduplicated and both records stay', async () => {
      const T = nextT();
      await careportal(T, 20);
      await self.instance.post(url, self.jwt.all).send(aapsCarbs(T, 5)).expect(201);
      (await storedAt(T)).length.should.equal(2);
    });

    it('PUT with app replaces a v1 record', async () => {
      const T = nextT();
      const d = await careportal(T, 20);
      const res = await self.instance.put(`${url}/${d._id}`, self.jwt.all)
        .send({ eventType: 'Meal Bolus', date: T, utcOffset: 0, app: 'AAPS', carbs: 25 });
      res.body.should.not.have.property('message');
      res.status.should.equal(200);
      const s = await stored(d._id);
      s.carbs.should.equal(25);
      s.app.should.equal('AAPS');
    });

    it('PUT with app and device replaces a v1 record', async () => {
      const T = nextT();
      const d = await careportal(T, 20);
      const res = await self.instance.put(`${url}/${d._id}`, self.jwt.all)
        .send({ eventType: 'Meal Bolus', date: T, utcOffset: 0, app: 'AAPS', device: 'test-device', carbs: 25 });
      res.body.should.not.have.property('message');
      res.status.should.equal(200);
      (await stored(d._id)).device.should.equal('test-device');
    });

    it('PUT without app is refused for the missing app, as for any v3 PUT', async () => {
      const T = nextT();
      const d = await careportal(T, 20);
      const res = await self.instance.put(`${url}/${d._id}`, self.jwt.all)
        .send({ eventType: 'Meal Bolus', date: T, utcOffset: 0, carbs: 25 })
        .expect(400);
      res.body.message.should.equal('Bad or missing app field');
    });

    it('PATCH in the AndroidAPS update shape (isValid true) changes a v1 record', async () => {
      const T = nextT();
      const d = await careportal(T, 20);
      const res = await self.instance.patch(`${url}/${d._id}`, self.jwt.all)
        .send({ identifier: d._id.toString(), eventType: 'Meal Bolus', isValid: true, carbs: 25 });
      res.body.should.not.have.property('message');
      res.status.should.equal(200);
      (await stored(d._id)).carbs.should.equal(25);
    });

    it('PATCH app sets it on a v1 record', async () => {
      const T = nextT();
      const d = await careportal(T, 20);
      const res = await self.instance.patch(`${url}/${d._id}`, self.jwt.all).send({ app: 'AAPS' });
      res.body.should.not.have.property('message');
      res.status.should.equal(200);
      (await stored(d._id)).app.should.equal('AAPS');
    });

    it('PATCH date equal to created_at is accepted', async () => {
      const T = nextT();
      const d = await careportal(T, 20);
      await self.instance.patch(`${url}/${d._id}`, self.jwt.all).send({ date: T }).expect(200);
    });
  });

  describe('controls: what stays refused', function () {

    async function refused (method, path, body, field) {
      const res = await self.instance[method](path, self.jwt.all).send(body).expect(400);
      res.body.message.should.equal(`Field ${field} cannot be modified by the client`);
    }

    it('a v3 record: normal create and update work, a different app or device is refused', async () => {
      const T = nextT();
      const doc = { eventType: 'Meal Bolus', date: T, utcOffset: 0, app: 'AAPS', device: 'dev-A', isValid: true, carbs: 20 };
      const c = await self.instance.post(url, self.jwt.all).send(doc).expect(201);
      const id = c.body.identifier;
      await self.instance.put(`${url}/${id}`, self.jwt.all).send(Object.assign({}, doc, { carbs: 21 })).expect(200);
      await self.instance.patch(`${url}/${id}`, self.jwt.all).send({ carbs: 22 }).expect(200);
      await refused('put', `${url}/${id}`, Object.assign({}, doc, { app: 'other' }), 'app');
      await refused('patch', `${url}/${id}`, { app: 'other' }, 'app');
      await refused('patch', `${url}/${id}`, { device: 'dev-B' }, 'device');
    });

    it('a v1 record that has app: a deduplicating POST with another app is refused', async () => {
      const T = nextT();
      await careportal(T, 20, { app: 'someapp', date: T });
      await refused('post', url, aapsCarbs(T, 20), 'app');
      (await storedAt(T))[0].app.should.equal('someapp');
    });

    it('a v1 record that has device: a different device is refused', async () => {
      const T = nextT();
      const d = await careportal(T, 20, { device: 'dev-A' });
      await refused('patch', `${url}/${d._id}`, { device: 'dev-B' }, 'device');
    });

    it('a v1 record: isValid false, server fields, identifier and another time are refused', async () => {
      const T = nextT();
      const d = await careportal(T, 20);
      const p = `${url}/${d._id}`;
      const before = await stored(d._id);
      await refused('patch', p, { isValid: false }, 'isValid');
      await refused('patch', p, { srvCreated: 1 }, 'srvCreated');
      await refused('patch', p, { srvModified: 1 }, 'srvModified');
      await refused('patch', p, { subject: 'someone' }, 'subject');
      await refused('patch', p, { modifiedBy: 'someone' }, 'modifiedBy');
      await refused('patch', p, { identifier: 'other-identifier' }, 'identifier');
      await refused('patch', p, { date: T + 60000 }, 'date');
      await refused('put', p, { eventType: 'Meal Bolus', date: T + 60000, utcOffset: 0, app: 'AAPS', carbs: 20 }, 'date');
      await refused('patch', p, { utcOffset: 120 }, 'utcOffset');
      (await stored(d._id)).should.eql(before);
    });

    it('a deleted v1 record still answers 410 to PUT and PATCH', async () => {
      const T = nextT();
      const d = await careportal(T, 20);
      await self.instance.delete(`${url}/${d._id}`, self.jwt.all).expect(200);
      await self.instance.patch(`${url}/${d._id}`, self.jwt.all).send({ carbs: 1 }).expect(410);
      await self.instance.put(`${url}/${d._id}`, self.jwt.all)
        .send({ eventType: 'Meal Bolus', date: T, utcOffset: 0, app: 'AAPS', carbs: 1 }).expect(410);
    });
  });
});
