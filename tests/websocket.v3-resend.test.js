'use strict';

// BF-225: a treatment first written through API v3, then re-sent over the
// socket (dbAdd) without its `identifier`, is the stored record, not a second
// one.
//
// API v3 computes an `identifier` for a record sent without one, from its
// device, date and eventType (calculateIdentifier in
// lib/api3/shared/operationTools.js). Since BF-209 (#8877) the socket's
// similar match takes a write with no client identity only for a record with
// no `identifier`, so the re-send of a v3 record missed it and was stored a
// second time: a duplicated carb or insulin entry. The similar match now also
// accepts a record whose `identifier` is the one API v3 would compute for the
// incoming body. Everything else is as BF-209 left it:
// - a stored identifier that is not the computed one (a client's own, such as
//   AndroidAPS sends) still keeps the record apart, so a nearby upload with no
//   id is a second record, not dropped into it;
// - the identifier is computed only for a body that carries a numeric `date`,
//   the form API v3 stores and computes it from, and only with the body's own
//   device: a re-send whose device or date differs is a second record (the
//   limit of this rule).
//
// Synthetic values only; every record is dated in June 2019.

require('should');
const { onlyIn } = require('./fixtures/api3/role');
const opTools = require('../lib/api3/shared/operationTools');

onlyIn('single', 'needs API v3 and the websocket in the process').describe('BF-225: a socket re-send of an API v3 treatment', function () {
  const self = this
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    , io = require('socket.io-client')
    , HASH = 'b723e97aa97846eb92d5264f084b2823f57c4aa1'
    , DEVICE = 'bf225-lab-' + Date.now()
    , FROM = '2019-06-01T00:00:00.000Z'
    , TO = '2019-07-01T00:00:00.000Z'
    ;

  self.timeout(30000);

  const col = () => self.instance.ctx.store.collection(self.instance.env.treatments_collection);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const stored = () => col().find({ created_at: { $gte: FROM, $lt: TO } }).sort({ created_at: 1 }).toArray();

  // The body a client sends through API v3 and re-sends over the socket.
  function body (t, extra) {
    return Object.assign({ eventType: 'Carb Correction', carbs: 12, date: t, utcOffset: 0, app: 'bf225-lab'
      , device: DEVICE, enteredBy: 'bf225-lab', created_at: new Date(t).toISOString() }, extra || {});
  }

  function dbAdd (data) {
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () { reject(new Error('no reply to dbAdd')); }, 5000);
      self.socket.emit('dbAdd', { collection: 'treatments', data: data }, function (reply) {
        clearTimeout(timer);
        resolve(reply);
      });
    });
  }

  // The treatments data-updates emitted while `step` runs, as the client
  // sees them: each one announces a record the chart adds.
  async function dataUpdatesDuring (step) {
    const seen = [];
    const onUpdate = (ev) => { if (ev && ev.type === 'treatments') seen.push(ev); };
    self.instance.ctx.bus.on('data-update', onUpdate);
    let reply;
    try {
      reply = await step();
      await sleep(100);
    } finally {
      self.instance.ctx.bus.removeListener('data-update', onUpdate);
    }
    return { reply, seen };
  }

  async function v3Create (doc) {
    const res = await self.instance.post('/api/v3/treatments', self.jwt.all).send(doc);
    res.status.should.be.oneOf([200, 201]);
    return res.body;
  }

  before(async () => {
    self.instance = await instance.create({ useHttps: false });
    const authResult = await authSubject(self.instance.ctx.authorization.storage, ['all'], self.instance.app);
    self.jwt = authResult.jwt;
    self.socket = io(self.instance.baseUrl, { transports: ['websocket'], reconnection: false });
    await new Promise((resolve, reject) => {
      self.socket.on('connect', function () {
        self.socket.emit('authorize', { client: 'test', secret: HASH }, function (auth) {
          if (!auth || !auth.write_treatment) return reject(new Error('socket not authorized to write treatments'));
          resolve();
        });
      });
      self.socket.on('connect_error', reject);
    });
  });

  beforeEach(() => col().deleteMany({ created_at: { $gte: FROM, $lt: TO } }));

  after(async () => {
    if (self.socket) self.socket.close();
    await col().deleteMany({ created_at: { $gte: FROM, $lt: TO } });
    self.instance.ctx.bus.teardown();
  });

  it('takes the identical re-send for the stored record: one record, its _id in the reply, no new-record update', async () => {
    const t = Date.parse('2019-06-10T07:40:00.000Z');
    await v3Create(body(t));
    const before = await stored();
    before.length.should.equal(1, 'the API v3 create should store one record');
    before[0].identifier.should.equal(opTools.calculateIdentifier(body(t)), 'API v3 should have computed the identifier');

    const { reply, seen } = await dataUpdatesDuring(() => dbAdd(body(t)));

    const after = await stored();
    after.length.should.equal(1, 'the socket re-send of the API v3 record should be recognised, not stored a second time');
    String(after[0]._id).should.equal(String(before[0]._id));
    reply.should.be.an.Array().and.have.length(1);
    String(reply[0]._id).should.equal(String(before[0]._id), 'the reply should name the stored record');
    seen.length.should.equal(0, 'no data-update should announce a new record');
  });

  it('keeps a socket write whose device differs as a second record (the limit of the computed-identifier rule)', async () => {
    const t = Date.parse('2019-06-11T07:40:00.000Z');
    await v3Create(body(t));
    await dbAdd(body(t, { device: DEVICE + '-other' }));
    (await stored()).length.should.equal(2, 'another device computes another identifier, so it is a second record');
  });

  it('keeps a socket write without a numeric date as a second record (the identifier is not computed for it)', async () => {
    const t = Date.parse('2019-06-12T07:40:00.000Z');
    await v3Create(body(t));
    const resent = body(t);
    delete resent.date;
    await dbAdd(resent);
    (await stored()).length.should.equal(2, 'without a date API v3 would not compute the stored identifier from this body');
  });

  it('keeps a write with no id next to a record whose own identifier is not the computed one (BF-209)', async () => {
    const t = Date.parse('2019-06-13T07:40:00.000Z');
    await col().insertOne(body(t, { identifier: 'bf225-client-identifier' }));
    await dbAdd(body(t + 1000));
    (await stored()).length.should.equal(2, 'a client identifier is not a re-send of this body, so both records stay');
  });
});
