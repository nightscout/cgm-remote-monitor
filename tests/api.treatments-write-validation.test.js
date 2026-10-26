'use strict';

// WRITE_VALIDATION on API v1 and API v3 treatment writes
// (lib/server/write-validation.js). Default off: what each API stores is
// unchanged. Opt-in reject: a Temporary Target that breaks a domain rule is
// refused with 400 on both APIs and nothing is stored.

const should = require('should');

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

    it('API v3 stores a mislabelled Temporary Target as sent', async () => {
      const doc = v3Target({ targetTop: 99.085745, targetBottom: 99.085745, units: 'mmol' });
      await self.instance.post(self.url, self.jwt.create).send(doc).expect(201);

      const stored = await storedV3(doc.identifier);
      stored.targetTop.should.equal(99.085745);
      stored.targetBottom.should.equal(99.085745);
      stored.units.should.equal('mmol');
    });

    it('API v3 stores units spelled mmol/L as sent', async () => {
      const doc = v3Target({ targetTop: 6, targetBottom: 5.5, units: 'mmol/L' });
      await self.instance.post(self.url, self.jwt.create).send(doc).expect(201);
      (await storedV3(doc.identifier)).units.should.equal('mmol/L');
    });

    it('API v3 stores targetBottom above targetTop as sent', async () => {
      const doc = v3Target({ targetTop: 90, targetBottom: 140, units: 'mg/dl' });
      await self.instance.post(self.url, self.jwt.create).send(doc).expect(201);
      (await storedV3(doc.identifier)).targetBottom.should.equal(140);
    });

    it('API v1 stores the careportal double label as sent', async () => {
      const body = careportalDoubleLabel(200);
      await v1Post(body).expect(200);

      const stored = await storedV1(body.created_at);
      stored.length.should.equal(1);
      stored[0].targetTop.should.equal(99.085745);
      stored[0].units.should.equal('mmol');
    });
  });


  describe('reject', function () {

    beforeEach(() => setMode('reject'));

    it('API v3 refuses the mislabelled Temporary Target with 400', async () => {
      const doc = v3Target({ targetTop: 99.085745, targetBottom: 99.085745, units: 'mmol' });
      const res = await self.instance.post(self.url, self.jwt.create).send(doc).expect(400);

      res.body.status.should.equal(400);
      res.body.message.should.match(/targetTop is too high for units mmol; it looks like a mg\/dL value/);
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

    it('API v3 stores a valid mmol/L target with units spelled mmol', async () => {
      const doc = v3Target({ targetTop: 6, targetBottom: 5.5, units: 'mmol/L' });
      await self.instance.post(self.url, self.jwt.create).send(doc).expect(201);
      const stored = await storedV3(doc.identifier);
      stored.units.should.equal('mmol');
      stored.targetTop.should.equal(6);
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

    it('API v3 PATCH checks the record as it would be stored', async () => {
      setMode('off');
      const doc = v3Target({ targetTop: 6, targetBottom: 5.5, units: 'mmol' });
      await self.instance.post(self.url, self.jwt.create).send(doc).expect(201);
      setMode('reject');

      await self.instance.patch(`${self.url}/${doc.identifier}`, self.jwt.update)
        .send({ targetTop: 108 }).expect(400);
      (await storedV3(doc.identifier)).targetTop.should.equal(6);

      await self.instance.patch(`${self.url}/${doc.identifier}`, self.jwt.update)
        .send({ targetTop: 6.5 }).expect(200);
      (await storedV3(doc.identifier)).targetTop.should.equal(6.5);
    });

    it('API v3 PATCH of other fields leaves an already-stored invalid record editable', async () => {
      setMode('off');
      const doc = v3Target({ targetTop: 99.085745, targetBottom: 99.085745, units: 'mmol' });
      await self.instance.post(self.url, self.jwt.create).send(doc).expect(201);
      setMode('reject');

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
      (await storedV3(doc.identifier)).targetTop.should.equal(6);
    });

    it('API v1 refuses the careportal double label with 400 and stores nothing', async () => {
      const body = careportalDoubleLabel(300);
      const res = await v1Post(body).expect(400);

      res.body.status.should.equal(400);
      res.body.message.should.match(/too high for units mmol/);
      (await storedV1(body.created_at)).length.should.equal(0);
    });

    it('API v1 still stores the careportal mmol/L target without a glucose value', async () => {
      // v1 removes `units` from a treatment without glucose, so the mg/dL
      // numbers are stored unlabelled, which every reader takes as mg/dL.
      const body = careportalDoubleLabel(400);
      delete body.glucose;
      delete body.glucoseType;
      await v1Post(body).expect(200);
      const stored = await storedV1(body.created_at);
      stored.length.should.equal(1);
      should.not.exist(stored[0].units);
    });

    it('API v1 refuses a whole batch when one item breaks a rule', async () => {
      const good = careportalDoubleLabel(500);
      delete good.glucose;
      delete good.glucoseType;
      const bad = careportalDoubleLabel(501);
      await v1Post([good, bad]).expect(400);
      (await storedV1(good.created_at)).length.should.equal(0);
      (await storedV1(bad.created_at)).length.should.equal(0);
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

      (await storedV3(doc.identifier)).units.should.equal('mmol');
      const line = warnings.find(w => w.indexOf('WRITE_VALIDATION') > -1);
      should.exist(line);
      line.should.match(/tt-units-plausible:targetTop/);
      line.should.not.match(/99\.08/);
    });
  });
});
