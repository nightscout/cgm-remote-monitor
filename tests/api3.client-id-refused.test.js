'use strict';

// API v3 refuses a client-supplied `_id` on create (POST) and PUT with 400
// (BF-170).
//
// API v3 addresses records by `identifier`; `_id` is the storage key
// Nightscout assigns. Create used to store a 24-hex body `_id` as a string,
// in the case sent, and answered 500 for `{"$oid": ...}`. Now any body `_id`
// is refused and nothing is stored. The message names `identifier` as the
// field for the record's own id. API v1 keeps its own `_id` handling.

require('should');

describe('API3: a client-supplied _id is refused on create and PUT (BF-170)', function () {
  const self = this
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    , utils = require('./fixtures/api3/utils')
    , ObjectID = require('mongodb').ObjectId
    ;

  self.timeout(15000);

  const APP = 'client-id-refused-test';
  const HEX = '5f2600000000000000000d01';

  const ID_FORMS = [
    { label: 'lower-case 24-hex', value: HEX }
    , { label: 'upper-case 24-hex', value: HEX.toUpperCase() }
    , { label: '{"$oid": hex}', value: { $oid: HEX } }
    , { label: 'UUID', value: '53409478-105f-11e9-ab14-d663bd873d93' }
    , { label: 'other string', value: 'custom-id' }
    , { label: 'null', value: null }
    , { label: '0', value: 0 }
  ];

  let minute = 0;

  // Synthetic values only; each body at its own minute.
  const BODY = {
    treatments: () => ({ eventType: 'Note', notes: APP })
    , entries: () => ({ type: 'sgv', sgv: 120 })
    , devicestatus: () => ({ uploaderBattery: 50 })
    , food: () => ({ type: 'food', name: APP, carbs: 10 })
    , profile: () => ({ defaultProfile: 'Default', store: {} })
  };

  function body (colName, extra) {
    minute += 1;
    return Object.assign(BODY[colName](), {
      date: Date.UTC(2021, 8, 1, 0, minute), utcOffset: 0, app: APP, device: APP
    }, extra);
  }

  function colFor (colName) {
    return self.instance.ctx.store.collection(self.instance.env[colName + '_collection']);
  }

  function checkRefusal (res) {
    res.body.status.should.equal(400);
    res.body.message.should.containEql('_id');
    res.body.message.should.containEql('identifier');
    // AndroidAPS matches these in 400 bodies; this refusal must not look like them.
    res.body.message.should.not.containEql('utcOffset');
    res.body.message.should.not.containEql('cannot be modified');
  }

  before(async () => {
    self.instance = await instance.create({});
    let authResult = await authSubject(self.instance.ctx.authorization.storage, ['all'], self.instance.app);
    self.jwt = authResult.jwt;
  });

  after(async () => {
    for (const colName of Object.keys(BODY)) {
      await colFor(colName).deleteMany({ app: APP });
    }
    await utils.storageClear(self.instance.ctx);
    self.instance.ctx.bus.teardown();
  });

  Object.keys(BODY).forEach(function (colName) {
    ID_FORMS.forEach(function (form) {
      it(colName + ': POST with a ' + form.label + ' _id answers 400 and stores nothing', async () => {
        const doc = body(colName, { _id: form.value });
        const res = await self.instance.post('/api/v3/' + colName, self.jwt.all).send(doc).expect(400);
        checkRefusal(res);
        (await colFor(colName).countDocuments({ app: APP, date: doc.date })).should.equal(0);
      });
    });

    it(colName + ': PUT with a body _id answers 400 and stores nothing', async () => {
      const doc = body(colName, { _id: HEX, identifier: 'client-id-refused-put-' + colName });
      const res = await self.instance.put('/api/v3/' + colName + '/' + doc.identifier, self.jwt.all)
        .send(doc).expect(400);
      checkRefusal(res);
      (await colFor(colName).countDocuments({ app: APP, date: doc.date })).should.equal(0);
    });

    it(colName + ': the same POST without _id is created (control)', async () => {
      const doc = body(colName, {});
      await self.instance.post('/api/v3/' + colName, self.jwt.all).send(doc).expect(201);
      (await colFor(colName).countDocuments({ app: APP, date: doc.date })).should.equal(1);
    });
  });

  it('PUT of a stored record with a body _id leaves the record unchanged', async () => {
    const doc = body('treatments', { identifier: 'client-id-refused-stored' });
    await self.instance.post('/api/v3/treatments', self.jwt.all).send(doc).expect(201);
    const res = await self.instance.put('/api/v3/treatments/' + doc.identifier, self.jwt.all)
      .send(Object.assign({}, doc, { _id: new ObjectID().toHexString(), notes: 'changed' })).expect(400);
    checkRefusal(res);
    (await colFor('treatments').findOne({ identifier: doc.identifier })).notes.should.equal(APP);
  });
});
