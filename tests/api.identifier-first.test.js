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
// EXPECTATIONS CHANGED 2026-10-31 (profile only, coordinator relaying the
// maintainer's decision of 2026-10-30 that was recorded after these tests,
// releases/cgm-remote-monitor-16.0.0/decisions.md "Slice 6: a v1 or in-process
// profile create ... carries a different `startDate` is stored as a new profile
// without the copied identifier"): the four profile tests that re-send at
// another startDate now expect a new profile without the identifier; the
// deleted-record one follows the same rule, confirmed by the maintainer 2026-10-31.
// Same-startDate profile tests were added beside them. Food and activity are
// unchanged.
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

  async function shouldBeAsSeeded (name, seeded) {
    plain(await col(name).findOne({ _id: seeded._id })).should.eql(plain(seeded));
  }

  // decisions.md, slice 6 profile-copy rule (line 90): a new profile, no identifier; the stored one as seeded.
  async function shouldBeNewWithoutIdentifier (name, seeded, stored, replyId, deleted) {
    stored.length.should.equal(2, 'a new profile beside the stored one');
    if (deleted) await shouldStayDeleted(name, seeded);
    else await shouldBeAsSeeded(name, seeded);
    const created = stored.find((doc) => String(doc._id) !== String(seeded._id));
    String(replyId).should.equal(String(created._id));
    created.should.not.have.property('identifier');
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
      // EXPECTATION CHANGED after the tests were written (2026-10-31, coordinator): releases/cgm-remote-monitor-16.0.0/
      // decisions.md, "Slice 6: a v1 or in-process profile create that matches a stored profile by `identifier` but
      // carries a different `startDate` is stored as a new profile without the copied identifier" (maintainer,
      // 2026-10-30, recorded after these tests). `resend` above has another startDate, so the four profile tests
      // below that use it expect a new profile with no identifier, the stored one untouched. Was: merged into it.
      newProfileAtOtherStartDate: true,
      // The same startDate: a re-send, merged (store whole, ID-Q7). Added with the change above.
      sameStart: (seeded, mark, identifier) => ({ defaultProfile: mark, startDate: seeded.startDate, store: { [mark]: { dia: 5 } }
        , identifier }),
      // ID-Q7: store replaced whole; units left out, kept.
      // CHANGED EXPECTATION (maintainer 2026-10-31, compat card B, extended): the re-send
      // replaces the stored profile, so units, left out, is gone.
      check: (now, mark) => {
        plain(now.store).should.eql({ [mark]: { dia: 5 } });
        now.should.not.have.property('units');
      }
    },
    food: {
      slice: '6',
      route: '/food/',
      mark: 'name',
      doc: (mark, identifier, extra) => Object.assign({ type: 'food', name: mark, carbs: 10, gi: 2, identifier }, extra),
      resend: (mark, identifier) => ({ type: 'food', name: mark, carbs: 12, identifier }),
      // CHANGED EXPECTATION (maintainer 2026-10-31, compat card B, extended): replaced, so gi, left out, is gone (it was kept).
      check: (now) => { now.carbs.should.equal(12); now.should.not.have.property('gi'); }
    },
    activity: {
      slice: '6a',
      route: '/activity/',
      mark: 'notes',
      doc: (mark, identifier, extra) => Object.assign({ created_at: iso(Date.now() - 3600000), steps: 10, heartrate: 60, notes: mark
        , identifier }, extra),
      resend: (mark, identifier) => ({ created_at: iso(Date.now() - 3600000), steps: 12, notes: mark, identifier }),
      // CHANGED EXPECTATION (maintainer 2026-10-31, compat card B, extended): replaced, so heartrate, left out, is gone (it was kept).
      check: (now) => { now.steps.should.equal(12); now.should.not.have.property('heartrate'); }
    }
  };

  for (const [name, form] of Object.entries(forms)) {
    describe(`slice ${form.slice}: ${name}`, function ( ) {

      // Red on c9b74404: a second record (no _id sent, so the create inserts).
      it(`API v1 ${name}: a create with a stored identifier lands on that record (replaced since compat card B, extended); the reply names it`, async ( ) => {
        const mark = tag();
        const identifier = uuid();
        const seeded = await seed(name, form.doc(mark, identifier));
        const res = await v1('post', form.route).send([form.resend(mark, identifier)]).expect(200);
        const stored = await find(name, { [form.mark]: mark });
        if (form.newProfileAtOtherStartDate) return shouldBeNewWithoutIdentifier(name, seeded, stored, res.body[0]._id);
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
        if (form.newProfileAtOtherStartDate) return shouldBeNewWithoutIdentifier(name, seeded, stored, docs[0]._id);
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
        // EXPECTATION CHANGED (profile): line 90, the deleted case confirmed by the maintainer 2026-10-31. A deleted profile the
        // identifier names at another startDate is read as "new profile, identifier dropped"; it stays deleted.
        if (form.newProfileAtOtherStartDate) {
          return shouldBeNewWithoutIdentifier(name, seeded, await find(name, { [form.mark]: mark }), res.body[0]._id, true);
        }
        (await find(name, { [form.mark]: mark })).length.should.equal(1);
        String(res.body[0]._id).should.equal(String(seeded._id));
      });

      // Red on c9b74404: a third record. ID-Q5.
      it(`API v1 ${name}: two records share the identifier: the write lands on one of them, no third record`, async ( ) => {
        const mark = tag();
        const identifier = uuid();
        // Two records with one identifier are stored as before the unique index (ID-UNIQUE-INDEX).
        await require('./fixtures/identifier-index').dropIdentifierIndex(self.instance.ctx.store, self.instance.env);
        const first = await seed(name, form.doc(mark, identifier));
        const second = await seed(name, form.doc(mark, identifier));
        const res = await v1('post', form.route).send([form.resend(mark, identifier)]).expect(200);
        if (form.newProfileAtOtherStartDate) {
          // EXPECTATION CHANGED (profile, line 90): at another startDate a third profile, without the identifier.
          const all = await find(name, { [form.mark]: mark });
          all.length.should.equal(3);
          all.filter((doc) => doc.identifier === identifier).length.should.equal(2);
          await shouldBeAsSeeded(name, first);
          await shouldBeAsSeeded(name, second);
          return;
        }
        (await find(name, { [form.mark]: mark })).length.should.equal(2);
        assert([String(first._id), String(second._id)].includes(String(res.body[0]._id)), 'the reply names a stored record');
      });

      if (form.sameStart) {
        // Added with the line-90 change: at the stored startDate a profile create is a re-send and merges.
        it(`API v1 ${name}: a create with a stored identifier at the same startDate replaces it (compat card B, extended); the reply names it`, async ( ) => {
          const mark = tag();
          const identifier = uuid();
          const seeded = await seed(name, form.doc(mark, identifier));
          const res = await v1('post', form.route).send([form.sameStart(seeded, mark, identifier)]).expect(200);
          const stored = await find(name, { [form.mark]: mark });
          stored.length.should.equal(1, 'one record for the identifier');
          form.check(stored[0], mark);
          String(res.body[0]._id).should.equal(String(seeded._id));
        });

        it(`in-process ${name}: the same startDate, through ctx.${name}.create`, async ( ) => {
          const mark = tag();
          const identifier = uuid();
          const seeded = await seed(name, form.doc(mark, identifier));
          const docs = await inProcess(name, [form.sameStart(seeded, mark, identifier)]);
          const stored = await find(name, { [form.mark]: mark });
          stored.length.should.equal(1, 'one record for the identifier');
          form.check(stored[0], mark);
          String(docs[0]._id).should.equal(String(seeded._id));
        });

        it(`API v1 ${name}: a deleted profile named at the same startDate is acknowledged; it stays deleted`, async ( ) => {
          const mark = tag();
          const identifier = uuid();
          const seeded = await seed(name, form.doc(mark, identifier), true);
          const res = await v1('post', form.route).send([form.sameStart(seeded, mark, identifier)]).expect(200);
          await shouldStayDeleted(name, seeded);
          (await find(name, { [form.mark]: mark })).length.should.equal(1);
          String(res.body[0]._id).should.equal(String(seeded._id));
        });
      }

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
