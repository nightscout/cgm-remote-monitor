'use strict';

// BF-194: a Temporary Target is stored in mg/dL and labelled `units: mg/dl`,
// on API v1 (POST, PUT), API v3 (POST, PUT, PATCH) and the in-process
// storage calls (lib/treatmentTargetUnits.js). The socket paths are in
// tests/websocket.tt-units.test.js.
//
// Before, v1 removed `units` from a treatment without a glucose value, so a
// target sent as 6.0 mmol/L was stored as 6 without a label, and v3 stored
// the mmol label as sent. Readers that ignore the label read 6 mg/dL.
//
// WRITE_VALIDATION is off here (the default); synthetic values only.

const should = require('should');
const MMOL = require('../lib/constants.json').MMOL_TO_MGDL;

describe('Temporary Target units at write time (BF-194)', function () {
  const self = this
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    , opTools = require('../lib/api3/shared/operationTools')
    , utils = require('./fixtures/api3/utils')
    , API_SECRET_HASH = 'b723e97aa97846eb92d5264f084b2823f57c4aa1'
    , APP = 'cgm-remote-monitor.test'
    , DEVICE = 'tt-units-test'
    ;

  self.timeout(20000);

  // One row per rule: the targets and label sent, and what is stored.
  const RULES = [
    { name: 'labelled mmol', units: 'mmol', top: 6, bottom: 5, want: [6 * MMOL, 5 * MMOL] }
    , { name: 'labelled mmol/L', units: 'mmol/L', top: 6.5, bottom: 5.5, want: [6.5 * MMOL, 5.5 * MMOL] }
    , { name: 'labelled " MMOL/l " (case and spaces)', units: ' MMOL/l ', top: 7, bottom: 6, want: [7 * MMOL, 6 * MMOL] }
    , { name: 'unlabelled with a target below 20', top: 6, bottom: 5, want: [6 * MMOL, 5 * MMOL] }
    , { name: 'unlabelled with targets of 20 or more', top: 120, bottom: 20, want: [120, 20] }
    , { name: 'labelled mg/dL', units: 'mg/dL', top: 120, bottom: 100, want: [120, 100] }
    , { name: 'labelled mg/dl', units: 'mg/dl', top: 110, bottom: 90, want: [110, 90] }
    // A mmol label on numbers above 30 is a mg/dL number (write-validation's
    // tt-units-plausible): the numbers are kept, not multiplied again.
    , { name: 'labelled mmol with mg/dL numbers (above 30)', units: 'mmol', top: 99.085745, bottom: 99.085745, want: [99.085745, 99.085745] }
  ];

  let seq = 0;
  function nextDate () {
    seq += 1;
    return Date.now() - 7200000 - seq * 60000;
  }

  function fields (rule) {
    const f = { targetTop: rule.top, targetBottom: rule.bottom };
    if (rule.units !== undefined) f.units = rule.units;
    return f;
  }

  function v1Target (extra) {
    return Object.assign({
      eventType: 'Temporary Target',
      created_at: new Date(nextDate()).toISOString(),
      enteredBy: DEVICE,
      reason: 'Eating Soon',
      duration: 60
    }, extra);
  }

  function v3Target (extra) {
    const doc = Object.assign({
      date: nextDate(),
      app: APP,
      device: DEVICE,
      eventType: 'Temporary Target',
      duration: 60,
      reason: 'Eating Soon'
    }, extra);
    doc.identifier = opTools.calculateIdentifier(doc);
    return doc;
  }

  function col () {
    return self.instance.ctx.store.collection(self.instance.env.treatments_collection);
  }

  async function storedV1 (createdAt) {
    const docs = await col().find({ created_at: createdAt, enteredBy: DEVICE }).toArray();
    docs.length.should.equal(1);
    return docs[0];
  }

  function storedV3 (identifier) {
    return col().findOne({ identifier: identifier });
  }

  function shouldBeMgdl (stored, want) {
    should.exist(stored);
    ({ targetTop: stored.targetTop, targetBottom: stored.targetBottom, units: stored.units })
      .should.eql({ targetTop: want[0], targetBottom: want[1], units: 'mg/dl' });
  }

  function v1Post (body) {
    return self.instance.post('/api/v1/treatments/')
      .set('api-secret', API_SECRET_HASH)
      .send(body);
  }

  function v1Put (body) {
    return self.instance.put('/api/v1/treatments/')
      .set('api-secret', API_SECRET_HASH)
      .send(body);
  }

  function cb (call) {
    return new Promise((resolve, reject) => call((err, result) => err ? reject(err) : resolve(result)));
  }

  before(async () => {
    delete process.env.WRITE_VALIDATION;
    self.instance = await instance.create({});
    self.instance.app.use('/api/v1', require('../lib/api/')(self.instance.env, self.instance.ctx));
    self.url = '/api/v3/treatments';
    const authResult = await authSubject(self.instance.ctx.authorization.storage,
      ['create', 'update', 'read', 'delete', 'all'], self.instance.app);
    self.jwt = authResult.jwt;
    self.instance.env.writeValidation.should.equal('off');
  });

  after(async () => {
    await utils.storageClear(self.instance.ctx);
    self.instance.ctx.bus.teardown();
  });


  describe('API v1 POST, one treatment', function () {
    RULES.forEach(rule => {
      it(rule.name, async () => {
        const body = v1Target(fields(rule));
        const res = await v1Post(body).expect(200);
        shouldBeMgdl(await storedV1(body.created_at), rule.want);
        // The reply is the record as stored.
        res.body[0].targetTop.should.equal(rule.want[0]);
        res.body[0].units.should.equal('mg/dl');
      });
    });

    it('keeps a mmol glucose value true to the mg/dl label', async () => {
      const body = v1Target({ targetTop: 6, targetBottom: 5, units: 'mmol', glucose: 5.5, glucoseType: 'Finger' });
      await v1Post(body).expect(200);
      const stored = await storedV1(body.created_at);
      shouldBeMgdl(stored, [6 * MMOL, 5 * MMOL]);
      stored.glucose.should.equal(5.5 * MMOL);
    });

    it('leaves a cancel without targets as before', async () => {
      const body = v1Target({ duration: 0, units: 'mmol' });
      await v1Post(body).expect(200);
      const stored = await storedV1(body.created_at);
      should.not.exist(stored.targetTop);
      should.not.exist(stored.units);
    });

    it('does not touch another event type', async () => {
      const body = v1Target({ eventType: 'Note', notes: 'tt-units', targetTop: 6, targetBottom: 5, units: 'mmol', glucose: 5.5 });
      await v1Post(body).expect(200);
      const stored = await storedV1(body.created_at);
      stored.targetTop.should.equal(6);
      stored.targetBottom.should.equal(5);
      stored.glucose.should.equal(5.5);
      stored.units.should.equal('mmol');
    });
  });


  describe('API v1 POST, a batch', function () {
    it('applies each rule to its own item', async () => {
      const bodies = RULES.map(rule => v1Target(fields(rule)));
      const note = v1Target({ eventType: 'Note', notes: 'tt-units batch', targetTop: 6, units: 'mmol', glucose: 5.5 });
      const res = await v1Post(bodies.concat([note])).expect(200);
      res.body.length.should.equal(RULES.length + 1);
      for (let i = 0; i < RULES.length; i++) {
        shouldBeMgdl(await storedV1(bodies[i].created_at), RULES[i].want);
      }
      const storedNote = await storedV1(note.created_at);
      storedNote.targetTop.should.equal(6);
      storedNote.units.should.equal('mmol');
    });
  });


  describe('API v1 PUT', function () {
    ['labelled mmol', 'unlabelled with a target below 20', 'labelled mg/dL'].forEach(name => {
      const rule = RULES.find(r => r.name === name);
      it(rule.name, async () => {
        const first = v1Target({ targetTop: 150, targetBottom: 140, units: 'mg/dl' });
        const created = (await v1Post(first).expect(200)).body[0];
        const body = Object.assign({}, first, { _id: created._id }, fields(rule));
        if (rule.units === undefined) delete body.units;
        await v1Put(body).expect(200);
        shouldBeMgdl(await storedV1(first.created_at), rule.want);
      });
    });
  });


  describe('in-process storage (ctx.treatments)', function () {
    it('create converts a mmol target', async () => {
      const body = v1Target({ targetTop: 6, targetBottom: 5, units: 'mmol' });
      await cb(fn => self.instance.ctx.treatments.create(body, fn));
      shouldBeMgdl(await storedV1(body.created_at), [6 * MMOL, 5 * MMOL]);
    });

    it('save converts an unlabelled target below 20', async () => {
      const body = v1Target({ targetTop: 6, targetBottom: 5 });
      await cb(fn => self.instance.ctx.treatments.save(body, fn));
      shouldBeMgdl(await storedV1(body.created_at), [6 * MMOL, 5 * MMOL]);
    });
  });


  describe('API v3 POST', function () {
    RULES.forEach(rule => {
      it(rule.name, async () => {
        const doc = v3Target(fields(rule));
        await self.instance.post(self.url, self.jwt.create).send(doc).expect(201);
        shouldBeMgdl(await storedV3(doc.identifier), rule.want);
      });
    });

    it('does not touch another event type', async () => {
      const doc = v3Target({ eventType: 'Note', notes: 'tt-units', targetTop: 6, targetBottom: 5, units: 'mmol' });
      await self.instance.post(self.url, self.jwt.create).send(doc).expect(201);
      const stored = await storedV3(doc.identifier);
      stored.targetTop.should.equal(6);
      stored.units.should.equal('mmol');
    });
  });


  describe('API v3 PUT', function () {
    ['labelled mmol/L', 'unlabelled with a target below 20', 'labelled mg/dL'].forEach(name => {
      const rule = RULES.find(r => r.name === name);
      it(rule.name, async () => {
        const doc = v3Target({ targetTop: 150, targetBottom: 140, units: 'mg/dl' });
        await self.instance.post(self.url, self.jwt.create).send(doc).expect(201);
        const body = Object.assign({}, doc, fields(rule));
        if (rule.units === undefined) delete body.units;
        await self.instance.put(`${self.url}/${doc.identifier}`, self.jwt.update).send(body).expect(200);
        shouldBeMgdl(await storedV3(doc.identifier), rule.want);
      });
    });
  });


  describe('API v3 PATCH', function () {
    it('converts targets sent in mmol', async () => {
      const doc = v3Target({ targetTop: 150, targetBottom: 140, units: 'mg/dl' });
      await self.instance.post(self.url, self.jwt.create).send(doc).expect(201);
      await self.instance.patch(`${self.url}/${doc.identifier}`, self.jwt.update)
        .send({ targetTop: 7, targetBottom: 6, units: 'mmol' }).expect(200);
      shouldBeMgdl(await storedV3(doc.identifier), [7 * MMOL, 6 * MMOL]);
    });

    it('keeps mg/dL targets of a stored mg/dl record', async () => {
      const doc = v3Target({ targetTop: 150, targetBottom: 140, units: 'mg/dl' });
      await self.instance.post(self.url, self.jwt.create).send(doc).expect(201);
      await self.instance.patch(`${self.url}/${doc.identifier}`, self.jwt.update)
        .send({ targetTop: 160 }).expect(200);
      shouldBeMgdl(await storedV3(doc.identifier), [160, 140]);
    });

    it('converts both targets of an unlabelled stored record when one is edited', async () => {
      // A record stored before this change (v1 removed the label).
      const doc = v3Target({ targetTop: 6, targetBottom: 5 });
      await col().insertOne(Object.assign({}, doc, { srvModified: doc.date, srvCreated: doc.date }));
      await self.instance.patch(`${self.url}/${doc.identifier}`, self.jwt.update)
        .send({ targetTop: 7 }).expect(200);
      shouldBeMgdl(await storedV3(doc.identifier), [7 * MMOL, 5 * MMOL]);
    });

    it('leaves a stored record alone when the patch does not touch targets or units', async () => {
      const doc = v3Target({ targetTop: 6, targetBottom: 5, units: 'mmol' });
      await col().insertOne(Object.assign({}, doc, { srvModified: doc.date, srvCreated: doc.date }));
      await self.instance.patch(`${self.url}/${doc.identifier}`, self.jwt.update)
        .send({ notes: 'checked' }).expect(200);
      const stored = await storedV3(doc.identifier);
      stored.targetTop.should.equal(6);
      stored.units.should.equal('mmol');
    });

    it('does not touch another event type', async () => {
      const doc = v3Target({ eventType: 'Note', notes: 'tt-units', targetTop: 6, targetBottom: 5, units: 'mg/dl' });
      await self.instance.post(self.url, self.jwt.create).send(doc).expect(201);
      await self.instance.patch(`${self.url}/${doc.identifier}`, self.jwt.update)
        .send({ units: 'mmol' }).expect(200);
      const stored = await storedV3(doc.identifier);
      stored.targetTop.should.equal(6);
      stored.units.should.equal('mmol');
    });
  });
});
