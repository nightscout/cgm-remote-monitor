'use strict';

// ID-FIRST-MATCH slices 6 and 6a, the socket's dbAdd: identifier first where
// it is new (design note 2026-10-29 §1.2 and §3; decisions ID-Q1, ID-Q2, ID-Q4,
// ID-Q5, ID-Q9 with the 2026-10-30 move of activity to 6a).
//
// Written test-first, before slice 6 is built. Each test states the decided
// behaviour; on slice 3 (c9b74404) every test in the "slice 6" blocks fails,
// and the guards pass. The expected red reason is next to each test.
//
// - A dbAdd that carries a valid `identifier` matches a stored record with
//   that identifier first, before NSCLIENT_ID and the collection's other keys,
//   on treatments, devicestatus, profile, entries and food (slice 6) and
//   activity (slice 6a).
// - A live match merges (merge on match, RFC 7386; ID-Q1 for treatments,
//   ID-Q2 for device status). The reply names the stored record. Fields the
//   re-send leaves out are kept. A profile's `store` is replaced whole (ID-Q7).
// - A soft-deleted match by identifier is acknowledged: nothing is written and
//   the record stays deleted (ID-Q4: the identifier is an identity).
// - When the identifier names several records, the write lands on the one P4
//   picks (its time key, else the newest), and no further record is created
//   (ID-Q5).
//
// Records are seeded straight to MongoDB with an old srvModified. Synthetic
// values only.

require('should');
const assert = require('node:assert/strict');

const OLD = 1557000000000;

describe('ID-FIRST-MATCH slices 6 and 6a: the socket\'s dbAdd matches on identifier first', function ( ) {
  const self = this
    , instance = require('./fixtures/api3/instance')
    , io = require('socket.io-client')
    , HASH = 'b723e97aa97846eb92d5264f084b2823f57c4aa1'
    , TAG = 'idfirst-ws-' + Date.now()
    ;

  self.timeout(30000);

  let n = 0;
  const tag = ( ) => TAG + '-' + (++n);
  const col = (name) => self.instance.ctx.store.collection(self.instance.env[name + '_collection'] || name);
  const iso = (ms) => new Date(ms).toISOString();
  const uuid = ( ) => require('crypto').randomUUID();
  const plain = (value) => JSON.parse(JSON.stringify(value));

  function emit (event, data) {
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () { reject(new Error('no reply to ' + event)); }, 5000);
      self.socket.emit(event, data, function (reply) {
        clearTimeout(timer);
        resolve(reply);
      });
    });
  }

  const add = (collection, data) => emit('dbAdd', { collection, data });

  async function seed (name, doc, deleted) {
    const copy = Object.assign({ srvCreated: OLD, srvModified: OLD }, doc, deleted ? { isValid: false } : { });
    Object.keys(copy).forEach((key) => { if (copy[key] === undefined) delete copy[key]; });
    const result = await col(name).insertOne(copy);
    return Object.assign({ _id: result.insertedId }, copy);
  }

  const find = (name, query) => col(name).find(query).toArray();
  const byId = (name, _id) => col(name).findOne({ _id });

  // The record is exactly as seeded: not written, still deleted.
  async function shouldStayDeleted (name, seeded) {
    const now = await byId(name, seeded._id);
    plain(now).should.eql(plain(seeded));
    now.isValid.should.equal(false);
  }

  async function shouldBeAsSeeded (name, seeded) {
    plain(await byId(name, seeded._id)).should.eql(plain(seeded));
  }

  // The reply of a single dbAdd names the stored record.
  function shouldName (reply, seeded) {
    assert(Array.isArray(reply) && reply.length === 1, 'one reply item: ' + JSON.stringify(reply));
    String(reply[0]._id).should.equal(String(seeded._id));
  }

  before(async ( ) => {
    self.instance = await instance.create({ useHttps: false });
    self.socket = io(self.instance.baseUrl, { transports: ['websocket'], reconnection: false });
    await new Promise((resolve, reject) => {
      self.socket.on('connect', function ( ) {
        self.socket.emit('authorize', { client: 'test', secret: HASH }, function (auth) {
          if (!auth || !auth.write || !auth.write_treatment) return reject(new Error('socket not authorized to write'));
          resolve();
        });
      });
      self.socket.on('connect_error', reject);
    });
  });

  after(async ( ) => {
    if (self.socket) self.socket.close();
    const mark = { $regex: '^' + TAG };
    await Promise.all(['treatments', 'entries', 'devicestatus', 'profile', 'food', 'activity'].map((name) =>
      col(name).deleteMany({ $or: [{ notes: mark }, { device: mark }, { name: mark }, { defaultProfile: mark }] })));
    self.instance.ctx.bus.teardown();
  });

  // -------------------------------------------------------------------------
  // Collections the socket inserts without matching today (entries, food,
  // activity): `socketInsert`, so every re-send is a second record.

  const plainInsert = {
    entries: {
      slice: '6',
      mark: 'device',
      doc: (mark, identifier, extra) => Object.assign({ type: 'sgv', sgv: 120, date: OLD + 600000, dateString: iso(OLD + 600000)
        , device: mark, identifier }, extra),
      left: { noise: 1 },
      changed: { sgv: 125 }
    },
    food: {
      slice: '6',
      mark: 'name',
      doc: (mark, identifier, extra) => Object.assign({ type: 'food', name: mark, carbs: 10, created_at: iso(OLD + 600000)
        , identifier }, extra),
      left: { gi: 2 },
      changed: { carbs: 12 }
    },
    activity: {
      slice: '6a',
      mark: 'notes',
      doc: (mark, identifier, extra) => Object.assign({ created_at: iso(OLD + 600000), steps: 10, notes: mark, identifier }, extra),
      left: { heartrate: 60 },
      changed: { steps: 12 }
    }
  };

  for (const [name, form] of Object.entries(plainInsert)) {
    describe(`slice ${form.slice}: ${name}`, function ( ) {

      // Red on c9b74404: a second record (socketInsert stores every dbAdd).
      it(`${name}: a re-send with a stored identifier merges into that record; a field left out is kept`, async ( ) => {
        const mark = tag();
        const identifier = uuid();
        const seeded = await seed(name, form.doc(mark, identifier, form.left));
        const reply = await add(name, form.doc(mark, identifier, form.changed));
        const stored = await find(name, { [form.mark]: mark });
        stored.length.should.equal(1, 'one record for the identifier');
        shouldName(reply, seeded);
        const now = stored[0];
        Object.keys(form.changed).forEach((field) => now[field].should.equal(form.changed[field]));
        Object.keys(form.left).forEach((field) => now[field].should.equal(form.left[field]));
        now.identifier.should.equal(identifier);
      });

      // Red on c9b74404: a second record beside the deleted one.
      it(`${name}: a re-send whose identifier names a deleted record is acknowledged; it stays deleted`, async ( ) => {
        const mark = tag();
        const identifier = uuid();
        const seeded = await seed(name, form.doc(mark, identifier), true);
        const reply = await add(name, form.doc(mark, identifier, form.changed));
        shouldName(reply, seeded);
        await shouldStayDeleted(name, seeded);
        (await find(name, { [form.mark]: mark })).length.should.equal(1);
      });

      // Red on c9b74404: a third record. ID-Q5: the write lands on the record
      // P4 picks and never creates another with a stored identifier.
      it(`${name}: two records share the identifier: the write lands on one of them, no third record`, async ( ) => {
        const mark = tag();
        const identifier = uuid();
        await seed(name, form.doc(mark, identifier));
        await seed(name, form.doc(mark, identifier));
        await add(name, form.doc(mark, identifier, form.changed));
        (await find(name, { [form.mark]: mark })).length.should.equal(2);
      });

      // Guard, green before and after: a dbAdd with no identifier is inserted as today.
      it(`${name}: guard: a dbAdd without an identifier is still a new record`, async ( ) => {
        const mark = tag();
        await seed(name, form.doc(mark, undefined));
        const doc = form.doc(mark, undefined, form.changed);
        delete doc.identifier;
        await add(name, doc);
        (await find(name, { [form.mark]: mark })).length.should.equal(2);
      });
    });
  }

  // -------------------------------------------------------------------------
  // Treatments (slice 6; ID-Q1: merge on an identifier match, after the split
  // fix #8878). Today: NSCLIENT_ID, else the fallback key, else the +-2 s
  // similar match in which a sent identifier decides (#8877).

  describe('slice 6: treatments', function ( ) {
    function treatment (note, fields) {
      return Object.assign({ eventType: 'Carb Correction', created_at: iso(Date.now() - 3600000), carbs: 20, notes: note
        , enteredBy: TAG }, fields);
    }

    // Red on c9b74404: a second record (outside the similar match's window,
    // and the fallback key never matches a stored record with an identifier).
    // EXPECTATION CHANGED 2026-10-31: maintainer decision B, relayed via session -d1 (decisions.md): a socket
    // treatment create that matches a stored treatment by identifier REPLACES it, so treatments replace on every
    // path, socket included, for slice 4's reason (a client shows a cleared field by leaving it out). This
    // supersedes ID-Q1 (merge) for treatments. Was: merged, the left-out field kept.
    it('a re-send with a stored identifier at another time replaces it; a field left out is gone', async ( ) => {
      const note = tag();
      const identifier = uuid();
      const seeded = await seed('treatments', treatment(note, { identifier, foodType: 'synthetic' }));
      const later = iso(new Date(seeded.created_at).getTime() + 600000);
      const reply = await add('treatments', treatment(note, { identifier, created_at: later, carbs: 30 }));
      const stored = await find('treatments', { notes: note });
      stored.length.should.equal(1, 'one record for the identifier');
      shouldName(reply, seeded);
      stored[0].carbs.should.equal(30);
      stored[0].should.not.have.property('foodType');
      stored[0].created_at.should.equal(later);
    });

    // Red on c9b74404: a second record (the similar match requires equal
    // carbs, so an edited amount inside the window is a new record).
    it('a re-send with a stored identifier and another amount, same time: replaced, the amount applied (decision B)', async ( ) => {
      const note = tag();
      const identifier = uuid();
      const seeded = await seed('treatments', treatment(note, { identifier }));
      const reply = await add('treatments', treatment(note, { identifier, created_at: seeded.created_at, carbs: 25 }));
      const stored = await find('treatments', { notes: note });
      stored.length.should.equal(1);
      shouldName(reply, seeded);
      stored[0].carbs.should.equal(25);
    });

    // Red on c9b74404: a second record beside the deleted one.
    it('a re-send whose identifier names a deleted record, at another time: acknowledged, stays deleted', async ( ) => {
      const note = tag();
      const identifier = uuid();
      const seeded = await seed('treatments', treatment(note, { identifier }), true);
      const later = iso(new Date(seeded.created_at).getTime() + 600000);
      const reply = await add('treatments', treatment(note, { identifier, created_at: later }));
      shouldName(reply, seeded);
      await shouldStayDeleted('treatments', seeded);
      (await find('treatments', { notes: note })).length.should.equal(1);
    });

    // Red on c9b74404: the NSCLIENT_ID exact match answers B (unchanged) and A is not written.
    it('identifier before NSCLIENT_ID: the record with the identifier is matched, not the one with the NSCLIENT_ID', async ( ) => {
      const note = tag();
      const identifier = uuid();
      const a = await seed('treatments', treatment(note, { identifier, NSCLIENT_ID: 'nsc-a-' + note }));
      const b = await seed('treatments', treatment(note, { NSCLIENT_ID: 'nsc-b-' + note, created_at: iso(Date.now() - 1800000) }));
      const reply = await add('treatments', treatment(note, { identifier, NSCLIENT_ID: 'nsc-b-' + note, created_at: a.created_at, carbs: 35 }));
      shouldName(reply, a);
      (await byId('treatments', a._id)).carbs.should.equal(35);
      await shouldBeAsSeeded('treatments', b);
      (await find('treatments', { notes: note })).length.should.equal(2);
    });

    // Guard, green before and after: an identifier that names nothing falls
    // through to NSCLIENT_ID, as today.
    it('guard: an identifier that names nothing falls through to NSCLIENT_ID', async ( ) => {
      const note = tag();
      const c = await seed('treatments', treatment(note, { NSCLIENT_ID: 'nsc-c-' + note }));
      const reply = await add('treatments', treatment(note, { identifier: uuid(), NSCLIENT_ID: 'nsc-c-' + note, created_at: c.created_at }));
      shouldName(reply, c);
      (await find('treatments', { notes: note })).length.should.equal(1);
    });

    // Red on c9b74404: a third record (the similar match requires equal carbs).
    // P4: the record at the write's created_at, though another is newer.
    it('two records share the identifier: the re-send lands on the one at its created_at (P4), no third record', async ( ) => {
      const note = tag();
      const identifier = uuid();
      const t1 = Date.now() - 3600000;
      const older = await seed('treatments', treatment(note, { identifier, created_at: iso(t1) }));
      const newer = await seed('treatments', treatment(note, { identifier, created_at: iso(t1 + 120000), carbs: 40 }));
      const reply = await add('treatments', treatment(note, { identifier, created_at: iso(t1), carbs: 22 }));
      shouldName(reply, older);
      (await byId('treatments', older._id)).carbs.should.equal(22);
      await shouldBeAsSeeded('treatments', newer);
      (await find('treatments', { notes: note })).length.should.equal(2);
    });
  });

  // -------------------------------------------------------------------------
  // Device status (slice 6; ID-Q2: the same default as the other collections,
  // merge on an identifier match; WRITE_RESEND=acknowledge is the opt-out).
  // Today: NSCLIENT_ID, else created_at.

  describe('slice 6: devicestatus', function ( ) {
    function status (mark, fields) {
      return Object.assign({ device: mark, created_at: iso(Date.now() - 3600000), uploaderBattery: 50 }, fields);
    }

    // Red on c9b74404: a second record (created_at differs, no NSCLIENT_ID).
    it('a re-send with a stored identifier at another created_at: one record, merged (ID-Q2)', async ( ) => {
      const mark = tag();
      const identifier = uuid();
      const seeded = await seed('devicestatus', status(mark, { identifier, pump: { reservoir: 100 } }));
      const reply = await add('devicestatus', { device: mark, identifier, created_at: iso(Date.now() - 1800000), pump: { reservoir: 90 } });
      const stored = await find('devicestatus', { device: mark });
      stored.length.should.equal(1, 'one record for the identifier');
      shouldName(reply, seeded);
      stored[0].pump.reservoir.should.equal(90);
      stored[0].uploaderBattery.should.equal(50);
    });

    // Red on c9b74404: a second record beside the deleted one (created_at is a time key).
    it('a re-send whose identifier names a deleted record: acknowledged, stays deleted', async ( ) => {
      const mark = tag();
      const identifier = uuid();
      const seeded = await seed('devicestatus', status(mark, { identifier }), true);
      const reply = await add('devicestatus', status(mark, { identifier, created_at: iso(Date.now() - 1800000) }));
      shouldName(reply, seeded);
      await shouldStayDeleted('devicestatus', seeded);
      (await find('devicestatus', { device: mark })).length.should.equal(1);
    });

    // Red on c9b74404: the NSCLIENT_ID exact match answers B.
    it('identifier before NSCLIENT_ID', async ( ) => {
      const mark = tag();
      const identifier = uuid();
      const a = await seed('devicestatus', status(mark, { identifier }));
      const b = await seed('devicestatus', status(mark, { NSCLIENT_ID: 'nsc-b-' + mark, created_at: iso(Date.now() - 1800000) }));
      const reply = await add('devicestatus', status(mark, { identifier, NSCLIENT_ID: 'nsc-b-' + mark, created_at: iso(Date.now() - 900000) }));
      shouldName(reply, a);
      await shouldBeAsSeeded('devicestatus', b);
      (await find('devicestatus', { device: mark })).length.should.equal(2);
    });
  });

  // -------------------------------------------------------------------------
  // Profile (slice 6). Today: NSCLIENT_ID, else startDate; replaced.
  // Merged under slice 4, with `store` replaced whole (ID-Q7). A deleted
  // profile reached by identifier is not tested here: the design note's row
  // says acknowledged, while decisions row "slice 3, per collection" keeps
  // the socket profile's revive with Q-R (reported, not resolved).
  //
  // EXPECTATIONS CHANGED 2026-10-31: maintainer decision C, relayed via session -d1 (decisions.md): the slice 6
  // profile-copy rule extends to the socket's dbAdd. A profile whose identifier names a stored profile with
  // another startDate is stored as a new profile WITHOUT the copied identifier (a warning is logged), as on API v1
  // and in-process; at the same startDate it is a re-send and merges (`store` replaced whole, ID-Q7). The two
  // tests below re-send at another startDate and were written for a merge; a same-startDate test is added.

  describe('slice 6: profile', function ( ) {
    function profile (mark, fields) {
      return Object.assign({ defaultProfile: mark, startDate: iso(Date.now() - 86400000), units: 'mg/dl'
        , store: { [mark]: { dia: 3 }, other: { dia: 4 } } }, fields);
    }

    // EXPECTATION CHANGED (decision C): another startDate is a new profile without the identifier. Was: one record,
    // merged.
    it('a re-send with a stored identifier and another startDate: a new profile without the identifier', async ( ) => {
      const mark = tag();
      const identifier = uuid();
      const seeded = await seed('profile', profile(mark, { identifier, mills: 1 }));
      const resend = profile(mark, { identifier, startDate: iso(Date.now() - 3600000), store: { [mark]: { dia: 5 } } });
      delete resend.units;
      const reply = await add('profile', resend);
      const stored = await find('profile', { defaultProfile: mark });
      stored.length.should.equal(2, 'a new profile beside the stored one');
      await shouldBeAsSeeded('profile', seeded);
      const created = stored.find((doc) => String(doc._id) !== String(seeded._id));
      created.should.not.have.property('identifier');
      plain(created.store).should.eql({ [mark]: { dia: 5 } });
      String(reply[0]._id).should.equal(String(created._id));
    });

    // Added with decision C: at the same startDate the re-send lands on the stored profile.
    // CHANGED EXPECTATION (maintainer 2026-10-31, compat card B): it replaces the stored profile, so a field it
    // leaves out (units) is gone; it was merged, `store` whole, and kept units.
    it('a re-send with a stored identifier at the same startDate: one record, replaced; a field left out is gone', async ( ) => {
      const mark = tag();
      const identifier = uuid();
      const seeded = await seed('profile', profile(mark, { identifier, mills: 1 }));
      const resend = profile(mark, { identifier, startDate: seeded.startDate, store: { [mark]: { dia: 5 } } });
      delete resend.units;
      const reply = await add('profile', resend);
      const stored = await find('profile', { defaultProfile: mark });
      stored.length.should.equal(1, 'one record for the identifier');
      shouldName(reply, seeded);
      plain(stored[0].store).should.eql({ [mark]: { dia: 5 } });
      stored[0].should.not.have.property('units');
      stored[0].identifier.should.equal(identifier);
    });

    // EXPECTATION CHANGED (decision C): the re-send's startDate differs from A's, so the identifier is dropped and
    // today's order runs: NSCLIENT_ID names B, which is merged; A is untouched. Was: A matched first. The ordering
    // test at the same startDate below keeps the original intent (identifier before NSCLIENT_ID).
    it('identifier at another startDate is dropped; NSCLIENT_ID then matches', async ( ) => {
      const mark = tag();
      const identifier = uuid();
      const a = await seed('profile', profile(mark, { identifier }));
      const b = await seed('profile', profile(mark, { NSCLIENT_ID: 'nsc-b-' + mark, startDate: iso(Date.now() - 7200000) }));
      const reply = await add('profile', profile(mark, { identifier, NSCLIENT_ID: 'nsc-b-' + mark, startDate: iso(Date.now() - 3600000)
        , store: { [mark]: { dia: 6 } } }));
      shouldName(reply, b);
      const nowB = await byId('profile', b._id);
      nowB.store[mark].dia.should.equal(6);
      nowB.should.not.have.property('identifier');
      await shouldBeAsSeeded('profile', a);
      (await find('profile', { defaultProfile: mark })).length.should.equal(2);
    });

    // Added with decision C: at A's startDate, identifier is matched before NSCLIENT_ID.
    it('identifier before NSCLIENT_ID at the same startDate', async ( ) => {
      const mark = tag();
      const identifier = uuid();
      const a = await seed('profile', profile(mark, { identifier }));
      const b = await seed('profile', profile(mark, { NSCLIENT_ID: 'nsc-b-' + mark, startDate: iso(Date.now() - 7200000) }));
      const reply = await add('profile', profile(mark, { identifier, NSCLIENT_ID: 'nsc-b-' + mark, startDate: a.startDate
        , store: { [mark]: { dia: 6 } } }));
      shouldName(reply, a);
      (await byId('profile', a._id)).store[mark].dia.should.equal(6);
      await shouldBeAsSeeded('profile', b);
      (await find('profile', { defaultProfile: mark })).length.should.equal(2);
    });
  });
});
