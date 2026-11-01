'use strict';

// WRITE_VALIDATION on API v1 and API v3 treatment writes
// (lib/server/write-validation.js). Default off: nothing is refused. Opt-in
// reject: a Temporary Target that breaks a domain rule is refused with 400 on
// both APIs and nothing is stored. Validation judges the record as sent; a
// Temporary Target that is stored is then in mg/dL, labelled mg/dl, in every
// mode (BF-194, lib/treatmentTargetUnits.js, tests/api.treatments-tt-units.test.js).

const should = require('should');
const MMOL = require('../lib/constants.json').MMOL_TO_MGDL;

describe('Treatment write validation (WRITE_VALIDATION)', function () {
  const self = this
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    , opTools = require('../lib/api3/shared/operationTools')
    , utils = require('./fixtures/api3/utils')
    , API_SECRET_HASH = 'b723e97aa97846eb92d5264f084b2823f57c4aa1'
    , APP = 'cgm-remote-monitor.test'
    , DEVICE = 'write-validation-test'
    ;

  self.timeout(20000);

  let seq = 0;
  // A v3 Temporary Target; `fields` override the defaults.
  function v3Target (fields) {
    seq += 1;
    const doc = Object.assign({
      date: Date.now() - 3600000 - seq * 60000,
      app: APP,
      device: DEVICE,
      eventType: 'Temporary Target',
      duration: 60,
      reason: 'Eating Soon'
    }, fields);
    doc.identifier = opTools.calculateIdentifier(doc);
    return doc;
  }

  // What the careportal sends on an mmol/L site when a glucose value was
  // left in the hidden field: targets already converted to mg/dL, still
  // labelled mmol, and a glucose value, so v1 keeps `units`.
  function careportalDoubleLabel (minutesAgo) {
    return {
      eventType: 'Temporary Target',
      created_at: new Date(Date.now() - minutesAgo * 60000).toISOString(),
      enteredBy: DEVICE,
      reason: 'Eating Soon',
      duration: 60,
      targetTop: 99.085745,
      targetBottom: 99.085745,
      units: 'mmol',
      glucose: 6.1,
      glucoseType: 'Finger'
    };
  }

  function v1Post (body) {
    return self.instance.post('/api/v1/treatments/')
      .set('api-secret', API_SECRET_HASH)
      .send(body);
  }

  function storedV1 (createdAt) {
    return self.instance.ctx.store.collection(self.instance.env.treatments_collection)
      .find({ created_at: createdAt, enteredBy: DEVICE }).toArray();
  }

  async function storedV3 (identifier) {
    return self.instance.ctx.store.collection(self.instance.env.treatments_collection)
      .findOne({ identifier: identifier });
  }

  // A record stored as sent, before BF-194: write it to the collection.
  function seedV3 (doc) {
    return self.instance.ctx.store.collection(self.instance.env.treatments_collection)
      .insertOne(Object.assign({}, doc, { srvModified: doc.date, srvCreated: doc.date }));
  }

  function setMode (mode) {
    self.instance.env.writeValidation = mode;
  }

  before(async () => {
    delete process.env.WRITE_VALIDATION;
    self.instance = await instance.create({});
    self.instance.app.use('/api/v1', require('../lib/api/')(self.instance.env, self.instance.ctx));
    self.url = '/api/v3/treatments';

    const authResult = await authSubject(self.instance.ctx.authorization.storage,
      ['create', 'update', 'read', 'delete', 'all'], self.instance.app);
    self.jwt = authResult.jwt;
    // The mode the server booted with; the default-off tests run in it.
    self.bootMode = self.instance.env.writeValidation;
  });

  after(async () => {
    setMode(self.bootMode);
    await utils.storageClear(self.instance.ctx);
    self.instance.ctx.bus.teardown();
  });

  afterEach(() => setMode(self.bootMode));


  describe('default off', function () {

    it('reads WRITE_VALIDATION as off when it is not set', () => {
      self.instance.env.writeValidation.should.equal('off');
    });

    it('API v3 stores mg/dL numbers labelled mmol as mg/dl, not multiplied', async () => {
      const doc = v3Target({ targetTop: 99.085745, targetBottom: 99.085745, units: 'mmol' });
      await self.instance.post(self.url, self.jwt.create).send(doc).expect(201);

      const stored = await storedV3(doc.identifier);
      stored.targetTop.should.equal(99.085745);
      stored.targetBottom.should.equal(99.085745);
      stored.units.should.equal('mg/dl');
    });

    it('API v3 stores a target labelled mmol/L in mg/dL', async () => {
      const doc = v3Target({ targetTop: 6, targetBottom: 5.5, units: 'mmol/L' });
      await self.instance.post(self.url, self.jwt.create).send(doc).expect(201);
      const stored = await storedV3(doc.identifier);
      stored.units.should.equal('mg/dl');
      stored.targetTop.should.equal(6 * MMOL);
    });

    it('API v3 stores targetBottom above targetTop as sent', async () => {
      const doc = v3Target({ targetTop: 90, targetBottom: 140, units: 'mg/dl' });
      await self.instance.post(self.url, self.jwt.create).send(doc).expect(201);
      (await storedV3(doc.identifier)).targetBottom.should.equal(140);
    });

    it('API v1 stores the careportal double label in mg/dL', async () => {
      const body = careportalDoubleLabel(200);
      await v1Post(body).expect(200);

      // The targets are already mg/dL numbers (above 30); the glucose value
      // is mmol/L and is converted, so the mg/dl label is true for both.
      const stored = await storedV1(body.created_at);
      stored.length.should.equal(1);
      stored[0].targetTop.should.equal(99.085745);
      stored[0].glucose.should.equal(6.1 * MMOL);
      stored[0].units.should.equal('mg/dl');
    });

    it('API v3 PATCH retains existing units and duration behavior with validation off', async () => {
      const doc = v3Target({ duration: 0, units: 'mmol' });
      await self.instance.post(self.url, self.jwt.create).send(doc).expect(201);
      await self.instance.patch(`${self.url}/${doc.identifier}`, self.jwt.update)
        .send({ units: 'mmol/L', endmills: doc.date + 3600000 }).expect(200);
      const stored = await storedV3(doc.identifier);
      stored.units.should.equal('mmol/L');
      stored.duration.should.equal(60);
    });
  });


  describe('reject', function () {

    beforeEach(() => setMode('reject'));

    it('API v3 refuses the mislabelled Temporary Target with 400', async () => {
      const doc = v3Target({ targetTop: 99.085745, targetBottom: 99.085745, units: 'mmol' });
      const res = await self.instance.post(self.url, self.jwt.create).send(doc).expect(400);

      res.body.status.should.equal(400);
      res.body.message.should.match(/targetTop is labelled units mmol but is above 30, so it is a mg\/dL value: send units mg\/dl, or targetTop in mmol\/L/);
      should.not.exist(await storedV3(doc.identifier));
    });

    it('API v3 refuses targetBottom above targetTop with 400', async () => {
      const doc = v3Target({ targetTop: 90, targetBottom: 140, units: 'mg/dl' });
      const res = await self.instance.post(self.url, self.jwt.create).send(doc).expect(400);
      res.body.message.should.match(/targetBottom must not be above targetTop/);
      should.not.exist(await storedV3(doc.identifier));
    });

    it('API v3 refuses units outside the known set with 400', async () => {
      const doc = v3Target({ targetTop: 6, targetBottom: 5, units: 'mmol/mol' });
      const res = await self.instance.post(self.url, self.jwt.create).send(doc).expect(400);
      res.body.message.should.match(/units must be mg\/dl or mmol/);
    });

    it('API v3 refuses a target that is not a finite number with 400', async () => {
      const doc = v3Target({ targetTop: '6', targetBottom: 5, units: 'mmol' });
      const res = await self.instance.post(self.url, self.jwt.create).send(doc).expect(400);
      res.body.message.should.match(/targetTop must be a number above zero/);
    });

    it('API v3 stores a valid mmol/L target in mg/dL', async () => {
      const doc = v3Target({ targetTop: 6, targetBottom: 5.5, units: 'mmol/L' });
      await self.instance.post(self.url, self.jwt.create).send(doc).expect(201);
      const stored = await storedV3(doc.identifier);
      stored.units.should.equal('mg/dl');
      stored.targetTop.should.equal(6 * MMOL);
    });

    it('API v3 stores a cancel (duration 0, no targets)', async () => {
      const doc = v3Target({ duration: 0 });
      await self.instance.post(self.url, self.jwt.create).send(doc).expect(201);
      should.exist(await storedV3(doc.identifier));
    });

    it('API v3 does not touch other event types', async () => {
      const doc = v3Target({ eventType: 'Note', notes: 'x', units: 'banana', targetTop: 1, targetBottom: 9 });
      await self.instance.post(self.url, self.jwt.create).send(doc).expect(201);
    });

    // A target is stored in mg/dL, so a PATCH in mmol/L sends its targets
    // with the label.
    [
      { alias: 'mmol/L', target: 6, patch: { targetTop: 6, targetBottom: 6 }, stored: 6 * MMOL },
      { alias: 'mg/dL', target: 100, patch: {}, stored: 100 }
    ].forEach(example => {
      it('API v3 PATCH accepts ' + example.alias + ' without repeating eventType', async () => {
        const doc = v3Target({ targetTop: example.target, targetBottom: example.target, units: example.alias });
        await self.instance.post(self.url, self.jwt.create).send(doc).expect(201);
        await self.instance.patch(`${self.url}/${doc.identifier}`, self.jwt.update)
          .send(Object.assign({ units: example.alias }, example.patch)).expect(200);
        const stored = await storedV3(doc.identifier);
        stored.units.should.equal('mg/dl');
        stored.targetTop.should.equal(example.stored);
        stored.targetBottom.should.equal(example.stored);
      });
    });

    ['patch', 'put', 'post'].forEach(method => {
      it('API v3 ' + method.toUpperCase() + ' refuses a targetless cancel made active by endmills', async () => {
        const doc = v3Target({ duration: 0 });
        await self.instance.post(self.url, self.jwt.create).send(doc).expect(201);
        const body = method === 'patch' ? {} : Object.assign({}, doc);
        body.endmills = doc.date + 3600000;
        const url = method === 'post' ? self.url : `${self.url}/${doc.identifier}`;
        const jwt = method === 'post' ? self.jwt.all : self.jwt.update;
        const response = await self.instance[method](url, jwt).send(body).expect(400);
        response.body.message.should.match(/targetBottom must be a number above zero/);
        const stored = await storedV3(doc.identifier);
        stored.duration.should.equal(0);
        should.not.exist(stored.endmills);
      });
    });

    it('API v3 PATCH still allows cancelling a target with stored millisecond duration', async () => {
      const doc = v3Target({ durationInMilliseconds: 3600000, targetTop: 100, targetBottom: 90, units: 'mg/dl' });
      await self.instance.post(self.url, self.jwt.create).send(doc).expect(201);
      await self.instance.patch(`${self.url}/${doc.identifier}`, self.jwt.update)
        .send({ duration: 0, targetTop: null, targetBottom: null }).expect(200);
      const stored = await storedV3(doc.identifier);
      stored.duration.should.equal(0);
      stored.durationInMilliseconds.should.equal(0);
    });

    it('API v3 does not let endmills hide an invalid submitted duration', async () => {
      const doc = v3Target({ targetTop: 100, targetBottom: 90, units: 'mg/dl' });
      await self.instance.post(self.url, self.jwt.create).send(doc).expect(201);
      for (const duration of [-1, '0']) {
        const response = await self.instance.put(`${self.url}/${doc.identifier}`, self.jwt.update)
          .send({ ...doc, duration, endmills: doc.date + 3600000 }).expect(400);
        response.body.message.should.match(/duration must be a number of zero or more/);
        (await storedV3(doc.identifier)).duration.should.equal(60);
      }
    });

    it('API v3 PATCH checks the record as it would be stored', async () => {
      const doc = v3Target({ targetTop: 6, targetBottom: 5.5, units: 'mmol' });
      await seedV3(doc);

      await self.instance.patch(`${self.url}/${doc.identifier}`, self.jwt.update)
        .send({ targetTop: 108 }).expect(400);
      (await storedV3(doc.identifier)).targetTop.should.equal(6);

      await self.instance.patch(`${self.url}/${doc.identifier}`, self.jwt.update)
        .send({ targetTop: 6.5 }).expect(200);
      const stored = await storedV3(doc.identifier);
      stored.targetTop.should.equal(6.5 * MMOL);
      stored.targetBottom.should.equal(5.5 * MMOL);
      stored.units.should.equal('mg/dl');
    });

    it('API v3 PATCH of other fields leaves an already-stored invalid record editable', async () => {
      const doc = v3Target({ targetTop: 99.085745, targetBottom: 99.085745, units: 'mmol' });
      await seedV3(doc);

      await self.instance.patch(`${self.url}/${doc.identifier}`, self.jwt.update)
        .send({ notes: 'checked' }).expect(200);
    });

    it('API v3 PUT refuses the mislabelled Temporary Target with 400', async () => {
      setMode('off');
      const doc = v3Target({ targetTop: 6, targetBottom: 5.5, units: 'mmol' });
      await self.instance.post(self.url, self.jwt.create).send(doc).expect(201);
      setMode('reject');

      const replacement = Object.assign({}, doc, { targetTop: 108, targetBottom: 99 });
      await self.instance.put(`${self.url}/${doc.identifier}`, self.jwt.update)
        .send(replacement).expect(400);
      (await storedV3(doc.identifier)).targetTop.should.equal(6 * MMOL);
    });

    it('API v1 refuses the careportal double label with 400 and stores nothing', async () => {
      const body = careportalDoubleLabel(300);
      const res = await v1Post(body).expect(400);

      res.body.status.should.equal(400);
      res.body.message.should.match(/targetTop is labelled units mmol .* send units mg\/dl/);
      (await storedV1(body.created_at)).length.should.equal(0);
    });

    it('API v1 still stores the careportal mmol/L target without a glucose value', async () => {
      // v1 validates a treatment without glucose with its `units` removed, as
      // before; the mg/dL numbers (above 30) are then stored labelled mg/dl.
      const body = careportalDoubleLabel(400);
      delete body.glucose;
      delete body.glucoseType;
      await v1Post(body).expect(200);
      const stored = await storedV1(body.created_at);
      stored.length.should.equal(1);
      stored[0].targetTop.should.equal(99.085745);
      stored[0].units.should.equal('mg/dl');
    });

    it('API v1 stores the valid items of a mixed batch and reports the refused one in its slot', async () => {
      const first = careportalDoubleLabel(500);
      delete first.glucose;
      delete first.glucoseType;
      const bad = careportalDoubleLabel(501);
      const last = { eventType: 'Note', created_at: new Date(Date.now() - 502 * 60000).toISOString(),
        enteredBy: DEVICE, notes: 'batch tail' };

      const res = await v1Post([first, bad, last]).expect(200);

      // The reply shape old clients read: one object per item sent, in order,
      // `_id` on each stored one (NightscoutKit maps ids by position and
      // requires the count to match).
      res.body.should.be.an.Array();
      res.body.length.should.equal(3);
      should.exist(res.body[0]._id);
      should.exist(res.body[2]._id);
      res.body[2].notes.should.equal('batch tail');
      should.not.exist(res.body[1]._id);
      res.body[1].created_at.should.equal(bad.created_at);
      res.body[1].refused.status.should.equal(400);
      res.body[1].refused.message.should.match(/targetTop is labelled units mmol .* send units mg\/dl/);
      res.body[1].refused.rules.should.containEql({ rule: 'tt-units-plausible', field: 'targetTop' });
      res.headers.warning.should.match(/^299 - "1 of 3 treatments refused by WRITE_VALIDATION/);

      (await storedV1(first.created_at)).length.should.equal(1);
      (await storedV1(bad.created_at)).length.should.equal(0);
      (await storedV1(last.created_at)).length.should.equal(1);
    });

    it('API v1 answers 400 when every item of a batch is refused', async () => {
      const a = careportalDoubleLabel(510);
      const b = careportalDoubleLabel(511);
      const res = await v1Post([a, b]).expect(400);
      res.body.message.should.match(/targetTop is labelled units mmol/);
      (await storedV1(a.created_at)).length.should.equal(0);
      (await storedV1(b.created_at)).length.should.equal(0);
    });

    it('API v1 reply to a batch with nothing refused carries no refusal and no Warning', async () => {
      const ok = careportalDoubleLabel(520);
      delete ok.glucose;
      delete ok.glucoseType;
      const res = await v1Post([ok]).expect(200);
      res.body.length.should.equal(1);
      should.exist(res.body[0]._id);
      should.not.exist(res.body[0].refused);
      should.not.exist(res.headers.warning);
    });

    it('API v1 PUT refuses the careportal double label with 400', async () => {
      const body = careportalDoubleLabel(600);
      await self.instance.put('/api/v1/treatments/')
        .set('api-secret', API_SECRET_HASH)
        .send(body).expect(400);
      (await storedV1(body.created_at)).length.should.equal(0);
    });
  });


  describe('log', function () {

    beforeEach(() => setMode('log'));

    it('logs invalid effective durations without normalising stored units or rejecting the patch', async () => {
      const doc = v3Target({ duration: 0, units: 'mmol' });
      await self.instance.post(self.url, self.jwt.create).send(doc).expect(201);
      const warnings = [], warn = console.warn;
      console.warn = function () { warnings.push(Array.from(arguments).join(' ')); };
      try {
        await self.instance.patch(`${self.url}/${doc.identifier}`, self.jwt.update)
          .send({ units: 'mmol/L', endmills: doc.date + 3600000 }).expect(200);
      } finally {
        console.warn = warn;
      }
      const stored = await storedV3(doc.identifier);
      stored.units.should.equal('mmol/L');
      stored.duration.should.equal(60);
      warnings.some(line => line.includes('tt-target:targetBottom')).should.be.true();
    });

    it('stores the record and logs the rule without the values', async () => {
      const warnings = [];
      const warn = console.warn;
      console.warn = function () { warnings.push(Array.from(arguments).join(' ')); };
      let doc;
      try {
        doc = v3Target({ targetTop: 99.085745, targetBottom: 99.085745, units: 'mmol' });
        await self.instance.post(self.url, self.jwt.create).send(doc).expect(201);
      } finally {
        console.warn = warn;
      }

      const stored = await storedV3(doc.identifier);
      stored.targetTop.should.equal(99.085745);
      stored.units.should.equal('mg/dl');
      const line = warnings.find(w => w.indexOf('WRITE_VALIDATION') > -1);
      should.exist(line);
      line.should.match(/tt-units-plausible:targetTop/);
      line.should.not.match(/99\.08/);
    });
  });
});
