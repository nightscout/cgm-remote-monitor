'use strict';

// ID-FIRST-MATCH slice 6c (BF-225): under UUID_HANDLING, a socket dbAdd of a
// treatment whose `_id` is a client UUID (Loop sends overrides so) and that
// carries no `identifier` is matched by identifier first with that value, as
// API v1 and in-process writes take it (DOC_ID_FORMS['treatment-uuid']: a
// non-hex string _id becomes the identifier when there is none).
//
// Before, a Loop override stored through API v1 (its UUID moved into
// `identifier`, a new ObjectId as _id) and re-sent over the socket with the
// UUID as _id was stored a second time, under the string _id: a duplicated
// treatment. Now the re-send lands on the stored record and, as every socket
// identifier match of a treatment does (decision B, 2026-10-31), replaces it.
//
// - The value is used to find the stored record only. A dbAdd whose UUID names
//   no stored identifier is written as before (a new record under its string
//   _id, no identifier added).
// - An `identifier` the write carries wins, as on API v1.
// - With UUID_HANDLING off nothing changes: the socket stores its copy under
//   the string _id as it did. (That is the behaviour this slice leaves alone
//   when the setting is off, not a behaviour it endorses.)
//
// Records are seeded straight to MongoDB, or through API v1. Synthetic values
// only.

require('should');
const assert = require('node:assert/strict');

describe('ID-FIRST-MATCH slice 6c: a socket treatment\'s UUID _id is its identifier under UUID_HANDLING', function ( ) {
  const self = this
    , instance = require('./fixtures/api3/instance')
    , io = require('socket.io-client')
    , HASH = 'b723e97aa97846eb92d5264f084b2823f57c4aa1'
    , TAG = 'idfirst-s6c-' + Date.now()
    , T = Date.parse('2019-05-10T07:40:00.000Z')
    ;

  self.timeout(30000);

  let n = 0;
  const tag = ( ) => TAG + '-' + (++n);
  const col = ( ) => self.instance.ctx.store.collection(self.instance.env.treatments_collection);
  const uuid = ( ) => require('crypto').randomUUID().toUpperCase();
  const mine = (mark) => col().find({ notes: mark }).toArray();

  // A Loop override as it is sent: its UUID as the _id, no identifier.
  function override (mark, id, extra) {
    return Object.assign({ _id: id, eventType: 'Temporary Override', created_at: new Date(T + n * 60000).toISOString()
      , duration: 60, reason: 'bf225 lab', notes: mark, enteredBy: 'bf225-lab' }, extra);
  }

  function emit (event, data) {
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function ( ) { reject(new Error('no reply to ' + event)); }, 5000);
      self.socket.emit(event, data, function (reply) {
        clearTimeout(timer);
        resolve(reply);
      });
    });
  }

  const add = (data) => emit('dbAdd', { collection: 'treatments', data });

  function shouldName (reply, stored) {
    assert(Array.isArray(reply) && reply.length === 1, 'one reply item: ' + JSON.stringify(reply));
    String(reply[0]._id).should.equal(String(stored._id), 'the reply should name the stored record');
  }

  before(async ( ) => {
    self.instance = await instance.create({ useHttps: false });
    self.instance.app.use('/api/v1', require('../lib/api/')(self.instance.env, self.instance.ctx));
    self.socket = io(self.instance.baseUrl, { transports: ['websocket'], reconnection: false });
    await new Promise((resolve, reject) => {
      self.socket.on('connect', function ( ) {
        self.socket.emit('authorize', { client: 'test', secret: HASH }, function (auth) {
          if (!auth || !auth.write_treatment) return reject(new Error('socket not authorized to write treatments'));
          resolve();
        });
      });
      self.socket.on('connect_error', reject);
    });
  });

  afterEach(( ) => { self.instance.env.uuidHandling = true; });

  after(async ( ) => {
    if (self.socket) self.socket.close();
    await col().deleteMany({ notes: { $regex: '^' + TAG } });
    self.instance.ctx.bus.teardown();
  });

  it('a Loop override stored through API v1 and re-sent over the socket: one record, replaced, the stored _id named', async ( ) => {
    self.instance.env.uuidHandling.should.equal(true);
    const mark = tag(); const id = uuid();
    await self.instance.post('/api/v1/treatments/').set('api-secret', HASH).send(override(mark, id)).expect(200);
    const [stored] = await mine(mark);
    stored.identifier.should.equal(id, 'API v1 should have moved the UUID into identifier');
    stored._id.constructor.name.should.equal('ObjectId');

    const reply = await add(override(mark, id, { duration: 30 }));

    const after = await mine(mark);
    after.length.should.equal(1, 'the socket re-send should land on the stored record, not be stored a second time');
    String(after[0]._id).should.equal(String(stored._id));
    after[0].identifier.should.equal(id, 'the replaced record keeps its identifier');
    after[0].duration.should.equal(30, 'an identifier match of a treatment replaces it (decision B)');
    shouldName(reply, stored);
  });

  it('a record stored with the UUID as identifier (in-process write): the socket re-send lands on it', async ( ) => {
    const mark = tag(); const id = uuid();
    const seeded = Object.assign(override(mark, id), { identifier: id });
    delete seeded._id;
    await col().insertOne(seeded);
    const reply = await add(override(mark, id));
    const after = await mine(mark);
    after.length.should.equal(1, 'the socket re-send should land on the record holding its UUID as identifier');
    String(after[0]._id).should.equal(String(seeded._id));
    shouldName(reply, seeded);
  });

  it('guard: a UUID _id that names no stored identifier is written as before (string _id, no identifier added)', async ( ) => {
    const mark = tag(); const id = uuid();
    await add(override(mark, id));
    const after = await mine(mark);
    after.length.should.equal(1);
    after[0]._id.should.equal(id);
    after[0].should.not.have.property('identifier');
  });

  it('guard: an identifier the write carries wins over its _id, as on API v1', async ( ) => {
    const mark = tag(); const id = uuid(); const other = uuid();
    const seeded = Object.assign(override(mark, id), { identifier: id });
    delete seeded._id;
    await col().insertOne(seeded);
    // the write names `other`, which nothing holds: identifier-first finds no
    // record, and the UUID _id is not used in its place
    await add(override(mark, id, { identifier: other, created_at: new Date(T + 3600000).toISOString() }));
    (await mine(mark)).length.should.equal(2);
  });

  it('UUID_HANDLING off: unchanged, the socket copy is stored under its string _id', async ( ) => {
    self.instance.env.uuidHandling = false;
    const mark = tag(); const id = uuid();
    const seeded = Object.assign(override(mark, id), { identifier: id });
    delete seeded._id;
    await col().insertOne(seeded);
    await add(override(mark, id));
    const after = await mine(mark);
    after.length.should.equal(2, 'with UUID_HANDLING off the _id is not taken as an identifier');
    after.filter((d) => d._id === id).length.should.equal(1);
    String(after.find((d) => d._id !== id)._id).should.equal(String(seeded._id));
  });
});
