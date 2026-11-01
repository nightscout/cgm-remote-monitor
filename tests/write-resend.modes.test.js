'use strict';

// ID-RESEND-SWITCH, the behaviour half: what WRITE_RESEND and
// WRITE_DELETED_RESEND make a re-send do, per path (API v1, in-process, API
// v3 POST, the socket's dbAdd) and per collection. Written before the wiring,
// against the decisions of 2026-10-31 (compatibility B, B extended and C) and
// the proposals marked below, which the maintainer has not confirmed yet:
//
//   WRITE_RESEND (a re-send matched to a stored LIVE record by an identity;
//   here always by `identifier`):
//     replace      16.0.0 (compatibility B, extended): the re-send replaces
//                  the record (a field it leaves out is gone), _id kept.
//                  API v1 / in-process entries keep merging (B extended).
//     merge        RFC 7386 merge (a field left out is kept), as #8879 was
//                  before card B. PROPOSAL Q-M1: treatments keep replacing
//                  (they replaced before card B: slice 4, 2026-10-30).
//     acknowledge  nothing written; the reply names the stored record.
//     refuse       nothing written; refused. PROPOSAL Q-R1: v1 and
//                  in-process answer the item's slot with refused.status
//                  409 (as BF-220), API v3 answers 409, the socket its
//                  refused slot with status 409.
//   WRITE_DELETED_RESEND (the same re-send, the record soft-deleted):
//     stay         acknowledged, stays deleted (ID-Q4).
//     revive       PROPOSAL Q-D1 (i): brought back, on every path, as one
//                  record (D2_REVIVE below; 'beside' is candidate (ii), a
//                  second record beside the deleted one, 15.0.9's value
//                  on the d2 paths).
//   Exempt under every mode: v1 / in-process entries matched by sysTime +
//   type, API v3 PATCH, socket dbUpdate, API v1 PUT.
//
// Records are seeded straight to MongoDB with an old srvModified (API v3:
// through POST), so "nothing written" is checked on the stored record.
// Synthetic values only.

require('should');
const assert = require('node:assert/strict');

const OLD = 1557000000000;
// Q-D1: 'revive' (candidate (i), recommended) or 'beside' (candidate (ii)).
const D2_REVIVE = 'revive';

const MODES = ['replace', 'merge', 'acknowledge', 'refuse'];
const PATHS = ['v1', 'inproc', 'v3', 'socket'];
const V1_COLLECTIONS = ['treatments', 'entries', 'devicestatus', 'profile', 'food', 'activity'];
const V3_COLLECTIONS = ['treatments', 'entries', 'devicestatus', 'profile', 'food', 'settings'];
const SOCKET_COLLECTIONS = ['treatments', 'entries', 'devicestatus', 'profile', 'food', 'activity'];
const V1_ROUTES = { treatments: '/treatments/', entries: '/entries/', devicestatus: '/devicestatus/', profile: '/profile/'
  , food: '/food/', activity: '/activity/' };

function collectionsOf (path) {
  if (path === 'v3') return V3_COLLECTIONS;
  if (path === 'socket') return SOCKET_COLLECTIONS;
  return V1_COLLECTIONS;
}

// What a live re-send does under a mode, on a path and collection.
function liveOutcome (mode, path, name) {
  if (mode === 'acknowledge' || mode === 'refuse') return mode;
  if (mode === 'replace') return (path === 'v1' || path === 'inproc') && name === 'entries' ? 'merge' : 'replace';
  return name === 'treatments' ? 'replace' : 'merge';
}

describe('ID-RESEND-SWITCH: WRITE_RESEND and WRITE_DELETED_RESEND, per path', function ( ) {
  const self = this
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    , io = require('socket.io-client')
    , HASH = 'b723e97aa97846eb92d5264f084b2823f57c4aa1'
    , TAG = 'resend-' + Date.now()
    ;

  self.timeout(30000);

  let n = 0;
  const tag = ( ) => TAG + '-' + (++n);
  const col = (name) => self.instance.ctx.store.collection(self.instance.env[name + '_collection'] || name);
  const iso = (ms) => new Date(ms).toISOString();
  const uuid = ( ) => require('crypto').randomUUID();
  const plain = (doc) => JSON.parse(JSON.stringify(doc));
  // A distinct, minute-aligned time per record, so time keys never collide.
  let clock = Date.UTC(2026, 9, 1, 8, 0, 0);
  const nextTime = ( ) => (clock += 60000);

  function setWrite (fields) {
    self.instance.env.write = Object.freeze(Object.assign({ }, self.instance.env.write, fields));
  }

  function emit (event, data) {
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () { reject(new Error('no reply to ' + event)); }, 5000);
      self.socket.emit(event, data, function (reply) {
        clearTimeout(timer);
        resolve(reply);
      });
    });
  }

  // Per collection: the stored record (`seed`), the re-send of it (`resend`:
  // the identifier and its time keys, one value changed, `keep` left out),
  // and whether a stored record carries the changed value. `v3` adds API v3's
  // required fields.
  const KINDS = {
    treatments: {
      seed: (t, id, ms) => ({ eventType: 'Carb Correction', created_at: iso(ms), carbs: 20, notes: t, enteredBy: TAG
        , foodType: 'keep-' + t, identifier: id }),
      resend: (t, id, ms) => ({ eventType: 'Carb Correction', created_at: iso(ms), carbs: 30, notes: t, enteredBy: TAG
        , identifier: id }),
      changed: (doc) => doc.carbs === 30,
      keep: 'foodType'
    },
    entries: {
      seed: (t, id, ms) => ({ type: 'sgv', sgv: 100, date: ms, dateString: iso(ms), sysTime: iso(ms), utcOffset: 0
        , direction: 'Flat', device: t, identifier: id }),
      resend: (t, id, ms) => ({ type: 'sgv', sgv: 110, date: ms, dateString: iso(ms), device: t, identifier: id }),
      changed: (doc) => doc.sgv === 110,
      keep: 'direction'
    },
    devicestatus: {
      seed: (t, id, ms) => ({ device: t, created_at: iso(ms), utcOffset: 0, uploaderBattery: 50
        , pump: { reservoir: 100 }, identifier: id }),
      resend: (t, id, ms) => ({ device: t, created_at: iso(ms), uploaderBattery: 60, identifier: id }),
      changed: (doc) => doc.uploaderBattery === 60,
      keep: 'pump'
    },
    profile: {
      seed: (t, id, ms) => ({ defaultProfile: t, startDate: iso(ms), created_at: iso(ms), units: 'mg/dl'
        , store: { [t]: { dia: 3 } }, identifier: id }),
      resend: (t, id, ms) => ({ defaultProfile: t, startDate: iso(ms), created_at: iso(ms), store: { [t]: { dia: 4 } }
        , identifier: id }),
      changed: (doc) => Boolean(doc.store && Object.values(doc.store)[0] && Object.values(doc.store)[0].dia === 4),
      keep: 'units'
    },
    food: {
      seed: (t, id) => ({ type: 'food', name: t, category: 'keep-' + t, carbs: 10, identifier: id }),
      resend: (t, id) => ({ type: 'food', name: t, carbs: 12, identifier: id }),
      changed: (doc) => doc.carbs === 12,
      keep: 'category'
    },
    activity: {
      seed: (t, id, ms) => ({ created_at: iso(ms), notes: t, steps: 100, heartrate: 60, identifier: id }),
      resend: (t, id, ms) => ({ created_at: iso(ms), notes: t, steps: 200, identifier: id }),
      changed: (doc) => doc.steps === 200,
      keep: 'heartrate'
    },
    settings: {
      seed: (t, id) => ({ name: t, value: 1, note: 'keep-' + t, identifier: id }),
      resend: (t, id) => ({ name: t, value: 2, identifier: id }),
      changed: (doc) => doc.value === 2,
      keep: 'note'
    }
  };

  // API v3's form of a record: date in ms, app and device, which v3 holds
  // immutable on a re-send, sent the same both times.
  function v3Form (name, doc, t, ms) {
    const form = Object.assign({ }, doc, { date: ms, app: 'synthetic-resend', device: t });
    delete form.dateString; delete form.sysTime; delete form.utcOffset;
    return form;
  }

  // Seed one live (or deleted) record for a path; answers the stored record
  // as read back, and the re-send body.
  async function seed (path, name, deleted) {
    const kind = KINDS[name];
    const t = tag();
    const id = uuid();
    const ms = nextTime();
    let body = kind.resend(t, id, ms);
    if (path === 'v3') {
      const first = v3Form(name, kind.seed(t, id, ms), t, ms);
      body = v3Form(name, body, t, ms);
      await self.instance.post('/api/v3/' + name, self.jwt.all).send(first).expect(201);
      if (deleted) await self.instance.delete('/api/v3/' + name + '/' + id, self.jwt.all).expect(200);
    } else {
      const copy = Object.assign({ srvCreated: OLD, srvModified: OLD }, kind.seed(t, id, ms));
      if (deleted) copy.isValid = false;
      await col(name).insertOne(copy);
    }
    const stored = await col(name).findOne({ identifier: id });
    assert(stored, 'seeded ' + name);
    return { id: id, t: t, stored: stored, body: body };
  }

  // Send the re-send on a path; answers { status, body } (body: the reply
  // array / object / callback result).
  async function resend (path, name, body) {
    if (path === 'v1') {
      const res = await self.instance.post('/api/v1' + V1_ROUTES[name]).set('api-secret', HASH).send([body]);
      return { status: res.status, body: res.body };
    }
    if (path === 'inproc') {
      return new Promise(function (resolve) {
        self.instance.ctx[name].create([body], function (err, docs) {
          resolve({ status: err ? 500 : 200, err: err, body: docs });
        });
      });
    }
    if (path === 'v3') {
      const res = await self.instance.post('/api/v3/' + name, self.jwt.all).send(body);
      return { status: res.status, body: res.body };
    }
    return { status: 200, body: await emit('dbAdd', { collection: name, data: body }) };
  }

  const all = (name, id) => col(name).find({ identifier: id }).toArray();
  const firstOf = (body) => Array.isArray(body) ? body[0] : body;

  function sameRecord (now, before) {
    plain(now).should.eql(plain(before));
  }

  // The reply names the stored record: its _id (v1, in-process, socket), or
  // on API v3 the deduplication reply with its identifier.
  function namesStored (path, reply, stored) {
    if (path === 'v3') {
      reply.status.should.equal(200);
      reply.body.isDeduplication.should.equal(true);
      reply.body.identifier.should.equal(stored.identifier);
      return;
    }
    reply.status.should.equal(200);
    const slot = firstOf(reply.body);
    assert(slot, 'a reply slot');
    assert.equal(slot.refused, undefined, 'not refused');
    String(slot._id).should.equal(String(stored._id));
  }

  // Q-R1: the refusal shape.
  function refused (path, reply) {
    if (path === 'v3') {
      reply.status.should.equal(409);
      return;
    }
    reply.status.should.equal(200);
    const slot = firstOf(reply.body);
    assert(slot && slot.refused, 'a refused slot: ' + JSON.stringify(reply.body));
    slot.refused.status.should.equal(409);
    assert.equal(slot._id, undefined, 'a refused slot carries no _id');
  }

  before(async ( ) => {
    self.instance = await instance.create({ useHttps: false });
    self.instance.app.use('/api/v1', require('../lib/api/')(self.instance.env, self.instance.ctx));
    const authResult = await authSubject(self.instance.ctx.authorization.storage, ['all'], self.instance.app);
    self.jwt = authResult.jwt;
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

  afterEach(( ) => setWrite({ resend: 'replace', deletedResend: 'stay' }));

  after(async ( ) => {
    if (self.socket) self.socket.close();
    const mine = { $regex: '^' + TAG };
    await Promise.all(['treatments', 'entries', 'devicestatus', 'profile', 'food', 'activity', 'settings'].map((name) =>
      col(name).deleteMany({ $or: [{ notes: mine }, { device: mine }, { name: mine }, { defaultProfile: mine }] })));
    self.instance.ctx.bus.teardown();
  });

  // -------------------------------------------------------------------------
  // A live record re-sent by its identifier.
  MODES.forEach(function (mode) {
    describe('WRITE_RESEND=' + mode + ': a re-send by identifier of a live record', function ( ) {
      PATHS.forEach(function (path) {
        collectionsOf(path).forEach(function (name) {
          const outcome = liveOutcome(mode, path, name);
          it(path + ' ' + name + ': ' + outcome, async ( ) => {
            const kind = KINDS[name];
            const seeded = await seed(path, name, false);
            setWrite({ resend: mode });
            const reply = await resend(path, name, seeded.body);
            const now = await all(name, seeded.id);
            now.length.should.equal(1, 'one record carries the identifier');
            const doc = now[0];
            String(doc._id).should.equal(String(seeded.stored._id));
            if (outcome === 'acknowledge' || outcome === 'refuse') {
              sameRecord(doc, seeded.stored);
              if (outcome === 'acknowledge') namesStored(path, reply, seeded.stored);
              else refused(path, reply);
              return;
            }
            if (path === 'v3') {
              reply.status.should.equal(200);
              reply.body.isDeduplication.should.equal(true);
            } else {
              namesStored(path, reply, seeded.stored);
            }
            assert(kind.changed(doc), 'the re-sent value is stored: ' + JSON.stringify(plain(doc)));
            // Activity has no server dates on any write (write-contract Q5 (a)).
            if (name !== 'activity') doc.srvModified.should.not.equal(seeded.stored.srvModified);
            if (outcome === 'replace') {
              assert.equal(doc[kind.keep], undefined, 'replace: a field the re-send leaves out is gone');
            } else {
              assert.notEqual(doc[kind.keep], undefined, 'merge: a field the re-send leaves out is kept');
              plain(doc[kind.keep]).should.eql(plain(seeded.stored[kind.keep]));
            }
            assert.notEqual(doc.isValid, false);
          });
        });
      });
    });
  });

  // -------------------------------------------------------------------------
  // A soft-deleted record re-sent by its identifier (WRITE_RESEND unset).
  ['stay', 'revive'].forEach(function (mode) {
    describe('WRITE_DELETED_RESEND=' + mode + ': a re-send by identifier of a deleted record', function ( ) {
      PATHS.forEach(function (path) {
        collectionsOf(path).forEach(function (name) {
          // The socket's profile dbAdd revives under either (Q-R, open; not this switch).
          if (path === 'socket' && name === 'profile') return;
          const revives = mode === 'revive';
          it(path + ' ' + name + ': ' + (revives ? (D2_REVIVE === 'revive' ? 'brought back' : 'per 15.0.9') : 'stays deleted'), async ( ) => {
            const kind = KINDS[name];
            const seeded = await seed(path, name, true);
            setWrite({ deletedResend: mode });
            const reply = await resend(path, name, seeded.body);
            const now = await all(name, seeded.id);
            if (!revives) {
              now.length.should.equal(1);
              sameRecord(now[0], seeded.stored);
              now[0].isValid.should.equal(false);
              namesStored(path, reply, seeded.stored);
              return;
            }
            if (D2_REVIVE === 'revive') {
              now.length.should.equal(1, 'one record carries the identifier');
              String(now[0]._id).should.equal(String(seeded.stored._id));
              assert.notEqual(now[0].isValid, false, 'brought back');
              assert(kind.changed(now[0]), 'the re-sent value is stored');
            } else {
              assert(now.some((doc) => doc.isValid !== false && kind.changed(doc)), 'a live record with the re-sent value');
            }
            reply.status.should.equal(200);
          });
        });
      });
    });
  });

  // Q-X1 (proposal): revive writes under WRITE_RESEND's outcome, so
  // acknowledge and refuse revive nothing.
  describe('WRITE_DELETED_RESEND=revive with WRITE_RESEND=acknowledge or refuse', function ( ) {
    ['acknowledge', 'refuse'].forEach(function (mode) {
      it('v1 food, ' + mode + ': the record stays deleted', async ( ) => {
        const seeded = await seed('v1', 'food', true);
        setWrite({ resend: mode, deletedResend: 'revive' });
        await resend('v1', 'food', seeded.body);
        const now = await all('food', seeded.id);
        now.length.should.equal(1);
        sameRecord(now[0], seeded.stored);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Exempt under every mode.
  describe('not re-sends: unchanged by WRITE_RESEND', function ( ) {
    ['acknowledge', 'refuse', 'merge'].forEach(function (mode) {

      it(mode + ': API v1 entries matched by sysTime + type merge, as on 15.0.9', async ( ) => {
        const t = tag();
        const ms = nextTime();
        const stored = Object.assign({ srvCreated: OLD, srvModified: OLD }
          , { type: 'sgv', sgv: 100, date: ms, dateString: iso(ms), sysTime: iso(ms), utcOffset: 0, direction: 'Flat', device: t });
        await col('entries').insertOne(stored);
        setWrite({ resend: mode });
        const res = await self.instance.post('/api/v1/entries/').set('api-secret', HASH)
          .send([{ type: 'sgv', sgv: 110, date: ms, dateString: iso(ms), device: t }]).expect(200);
        String(res.body[0]._id).should.equal(String(stored._id));
        const now = await col('entries').find({ device: t }).toArray();
        now.length.should.equal(1);
        now[0].sgv.should.equal(110);
        now[0].direction.should.equal('Flat');
      });

      it(mode + ': in-process entries matched by sysTime + type merge', async ( ) => {
        const t = tag();
        const ms = nextTime();
        await col('entries').insertOne({ type: 'sgv', sgv: 100, date: ms, dateString: iso(ms), sysTime: iso(ms), utcOffset: 0
          , direction: 'Flat', device: t, srvCreated: OLD, srvModified: OLD });
        setWrite({ resend: mode });
        await new Promise((resolve, reject) => self.instance.ctx.entries.create([{ type: 'sgv', sgv: 110, date: ms
          , dateString: iso(ms), device: t }], (err) => err ? reject(err) : resolve()));
        const now = await col('entries').find({ device: t }).toArray();
        now.length.should.equal(1);
        now[0].sgv.should.equal(110);
        now[0].direction.should.equal('Flat');
      });

      it(mode + ': API v3 PATCH merges', async ( ) => {
        const seeded = await seed('v3', 'food', false);
        setWrite({ resend: mode });
        await self.instance.patch('/api/v3/food/' + seeded.id, self.jwt.all).send({ carbs: 15 }).expect(200);
        const doc = await col('food').findOne({ identifier: seeded.id });
        doc.carbs.should.equal(15);
        doc.category.should.equal(seeded.stored.category);
      });

      it(mode + ': API v1 PUT replaces', async ( ) => {
        const seeded = await seed('v1', 'food', false);
        setWrite({ resend: mode });
        await self.instance.put('/api/v1/food/').set('api-secret', HASH)
          .send({ _id: String(seeded.stored._id), type: 'food', name: seeded.t, carbs: 14, identifier: seeded.id }).expect(200);
        const doc = await col('food').findOne({ _id: seeded.stored._id });
        doc.carbs.should.equal(14);
        assert.equal(doc.category, undefined);
      });

      it(mode + ': socket dbUpdate merges', async ( ) => {
        const seeded = await seed('socket', 'food', false);
        setWrite({ resend: mode });
        await emit('dbUpdate', { collection: 'food', _id: String(seeded.stored._id), data: { carbs: 16 } });
        const doc = await col('food').findOne({ _id: seeded.stored._id });
        doc.carbs.should.equal(16);
        doc.category.should.equal(seeded.stored.category);
      });
    });
  });
});
