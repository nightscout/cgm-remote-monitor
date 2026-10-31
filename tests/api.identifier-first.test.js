'use strict';

// ID-FIRST-MATCH slices 6 and 6a, API v1 and in-process creates: profile and
// food (slice 6) and activity (slice 6a, "item B") match on `identifier`
// first, then on `_id` as today (design note 2026-10-29 §1.2; decisions ID-Q4,
// ID-Q5, ID-Q7, ID-Q8, and the 2026-10-30 move of activity to 6a).
//
// Written test-first, before slice 6 is built. Each test states the decided
// behaviour; on slice 3 (c9b74404) each test fails, with the red reason next to
// it, except the guards, which pass before and after.
//
// - A create without `_id` whose `identifier` is stored merges into that
//   record (merge on match, ID-Q8 for food and activity; a profile's `store` is
//   replaced whole and its other fields merge, ID-Q7). The reply names the
//   stored record. Fields left out are kept.
// - One whose identifier names a soft-deleted record is acknowledged: 200,
//   nothing written, the record stays deleted (ID-Q4).
// - When the identifier names several records, the write lands on the one P4
//   picks and no further record is created (ID-Q5).
//
// Records are seeded straight to MongoDB with an old srvModified. Synthetic
// values only.

require('should');
const assert = require('node:assert/strict');

const OLD = 1557000000000;

describe('ID-FIRST-MATCH slices 6 and 6a: v1 and in-process profile, food and activity creates match on identifier', function ( ) {
  const self = this
    , instance = require('./fixtures/api3/instance')
    , HASH = 'b723e97aa97846eb92d5264f084b2823f57c4aa1'
    , TAG = 'idfirst-v1-' + Date.now()
    ;

  self.timeout(30000);

  let n = 0;
  const tag = ( ) => TAG + '-' + (++n);
  const col = (name) => self.instance.ctx.store.collection(self.instance.env[name + '_collection'] || name);
  const iso = (ms) => new Date(ms).toISOString();
  const v1 = (method, url) => self.instance[method]('/api/v1' + url).set('api-secret', HASH);
  const uuid = ( ) => require('crypto').randomUUID();
  const plain = (value) => JSON.parse(JSON.stringify(value));

  async function seed (name, doc, deleted) {
    const copy = Object.assign({ srvCreated: OLD, srvModified: OLD }, doc, deleted ? { isValid: false } : { });
    const result = await col(name).insertOne(copy);
    return Object.assign({ _id: result.insertedId }, copy);
  }

  const find = (name, query) => col(name).find(query).toArray();

  async function shouldStayDeleted (name, seeded) {
    const now = await col(name).findOne({ _id: seeded._id });
    plain(now).should.eql(plain(seeded));
    now.isValid.should.equal(false);
  }

  function inProcess (name, docs) {
    return new Promise((resolve, reject) => self.instance.ctx[name].create(docs
      , (err, result) => err ? reject(err) : resolve(result)));
  }

  before(async ( ) => {
    self.instance = await instance.create({ useHttps: false });
    self.instance.app.use('/api/v1', require('../lib/api/')(self.instance.env, self.instance.ctx));
  });

  after(async ( ) => {
    const mark = { $regex: '^' + TAG };
    await Promise.all(['profile', 'food', 'activity'].map((name) =>
      col(name).deleteMany({ $or: [{ notes: mark }, { name: mark }, { defaultProfile: mark }] })));
    self.instance.ctx.bus.teardown();
  });

  const forms = {
    profile: {
      slice: '6',
      route: '/profile/',
      mark: 'defaultProfile',
      doc: (mark, identifier, extra) => Object.assign({ defaultProfile: mark, startDate: iso(Date.now() - 86400000), units: 'mg/dl'
        , store: { [mark]: { dia: 3 }, other: { dia: 4 } }, identifier }, extra),
      // A re-send at another startDate (tconnectsync's add mode sends a new one).
      resend: (mark, identifier) => ({ defaultProfile: mark, startDate: iso(Date.now() - 3600000), store: { [mark]: { dia: 5 } }
        , identifier }),
      // ID-Q7: store replaced whole; units left out, kept.
      check: (now, mark) => {
        plain(now.store).should.eql({ [mark]: { dia: 5 } });
        now.units.should.equal('mg/dl');
      }
    },
    food: {
      slice: '6',
      route: '/food/',
      mark: 'name',
      doc: (mark, identifier, extra) => Object.assign({ type: 'food', name: mark, carbs: 10, gi: 2, identifier }, extra),
      resend: (mark, identifier) => ({ type: 'food', name: mark, carbs: 12, identifier }),
      check: (now) => { now.carbs.should.equal(12); now.gi.should.equal(2); }
    },
    activity: {
      slice: '6a',
      route: '/activity/',
      mark: 'notes',
      doc: (mark, identifier, extra) => Object.assign({ created_at: iso(Date.now() - 3600000), steps: 10, heartrate: 60, notes: mark
        , identifier }, extra),
      resend: (mark, identifier) => ({ created_at: iso(Date.now() - 3600000), steps: 12, notes: mark, identifier }),
      check: (now) => { now.steps.should.equal(12); now.heartrate.should.equal(60); }
    }
  };

  for (const [name, form] of Object.entries(forms)) {
    describe(`slice ${form.slice}: ${name}`, function ( ) {

      // Red on c9b74404: a second record (no _id sent, so the create inserts).
      it(`API v1 ${name}: a create with a stored identifier merges into that record; the reply names it`, async ( ) => {
        const mark = tag();
        const identifier = uuid();
        const seeded = await seed(name, form.doc(mark, identifier));
        const res = await v1('post', form.route).send([form.resend(mark, identifier)]).expect(200);
        const stored = await find(name, { [form.mark]: mark });
        stored.length.should.equal(1, 'one record for the identifier');
        form.check(stored[0], mark);
        String(res.body[0]._id).should.equal(String(seeded._id));
      });

      // Red on c9b74404: a second record.
      it(`in-process ${name}: the same, through ctx.${name}.create`, async ( ) => {
        const mark = tag();
        const identifier = uuid();
        const seeded = await seed(name, form.doc(mark, identifier));
        const docs = await inProcess(name, [form.resend(mark, identifier)]);
        const stored = await find(name, { [form.mark]: mark });
        stored.length.should.equal(1, 'one record for the identifier');
        form.check(stored[0], mark);
        String(docs[0]._id).should.equal(String(seeded._id));
      });

      // Red on c9b74404: a second record beside the deleted one.
      it(`API v1 ${name}: a create whose identifier names a deleted record is acknowledged; it stays deleted`, async ( ) => {
        const mark = tag();
        const identifier = uuid();
        const seeded = await seed(name, form.doc(mark, identifier), true);
        const res = await v1('post', form.route).send([form.resend(mark, identifier)]).expect(200);
        await shouldStayDeleted(name, seeded);
        (await find(name, { [form.mark]: mark })).length.should.equal(1);
        String(res.body[0]._id).should.equal(String(seeded._id));
      });

      // Red on c9b74404: a third record. ID-Q5.
      it(`API v1 ${name}: two records share the identifier: the write lands on one of them, no third record`, async ( ) => {
        const mark = tag();
        const identifier = uuid();
        const first = await seed(name, form.doc(mark, identifier));
        const second = await seed(name, form.doc(mark, identifier));
        const res = await v1('post', form.route).send([form.resend(mark, identifier)]).expect(200);
        (await find(name, { [form.mark]: mark })).length.should.equal(2);
        assert([String(first._id), String(second._id)].includes(String(res.body[0]._id)), 'the reply names a stored record');
      });

      // Guard, green before and after: `_id` still matches when no identifier
      // is sent (the order is identifier, then _id).
      it(`API v1 ${name}: guard: a create by a stored _id without an identifier still lands on that record`, async ( ) => {
        const mark = tag();
        const seeded = await seed(name, form.doc(mark, undefined));
        delete seeded.identifier;
        await col(name).updateOne({ _id: seeded._id }, { $unset: { identifier: '' } });
        const resend = Object.assign(form.resend(mark, undefined), { _id: String(seeded._id) });
        delete resend.identifier;
        await v1('post', form.route).send([resend]).expect(200);
        (await find(name, { [form.mark]: mark })).length.should.equal(1);
      });
    });
  }
});
