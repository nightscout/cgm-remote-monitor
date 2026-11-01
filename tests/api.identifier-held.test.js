'use strict';

// identifier-held (ID-RULE1-EDIT, decided by the maintainer 2026-10-30) on
// API v1, in-process callers and the socket: an edit that names record X by
// its _id and carries an `identifier` another stored record Y holds (Y soft
// deleted included) is refused, 409, and nothing is written: no write, no
// data-update, no data-received. An edit carrying X's own identifier, or none,
// is written as before, and so is v1 treatments PUT, whose identifier decides
// the record (ID-Q10). The same under WRITE_IDENTIFIER=lenient and strict.
// The answer never names the identifier or Y's _id. API v3 PATCH is in
// tests/api3.identifier-held.test.js.
//
// Synthetic values only; every record is dated in May 2019.

var request = require('supertest');
var should = require('should');
var language = require('../lib/language')();

var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
var TAG = 'identifier-held-test';
var MESSAGE = 'identifier is held by another record';
var ID_X = 'f1d2c3b4-0000-4000-8000-00000000d001';
var ID_Y = 'f1d2c3b4-0000-4000-8000-00000000d002';
var T_MS = Date.parse('2019-05-13T07:40:00.000Z');

function at (minutes) {
  return new Date(T_MS + minutes * 60000).toISOString();
}

function plain (doc) {
  return JSON.parse(JSON.stringify(doc));
}

describe('identifier-held: an edit by _id carrying another record\'s identifier is refused 409 (API v1, in-process, socket)', function () {
  this.timeout(15000);
  var self = this;
  var http = require('http');
  var io = require('socket.io-client');
  var events;

  function col (name) {
    return self.ctx.store.collection(self.env[name + '_collection']);
  }

  function dropAll () {
    return Promise.all(['treatments', 'food', 'activity', 'profile'].map(function (name) {
      return col(name).deleteMany({ heldTest: TAG });
    }));
  }

  // The fields every seeded and sent record of `name` has.
  function body (name, minutes, fields) {
    var base = { heldTest: TAG, created_at: at(minutes) };
    if (name === 'food') Object.assign(base, { type: 'food', name: 'held food', carbs: 10 });
    if (name === 'activity') Object.assign(base, { steps: 100 });
    if (name === 'profile') Object.assign(base, { defaultProfile: 'Default', startDate: at(minutes), units: 'mg/dl'
      , store: { Default: { dia: 3, units: 'mg/dl', timezone: 'UTC' } } });
    if (name === 'treatments') Object.assign(base, { eventType: 'Note', notes: 'held', enteredBy: TAG });
    return Object.assign(base, fields);
  }

  // X (ID_X) and Y (ID_Y), stored straight to MongoDB.
  async function seed (name, yFields) {
    var x = body(name, 0, { identifier: ID_X, srvCreated: 1557000000000, srvModified: 1557000000000 });
    var y = body(name, 5, Object.assign({ identifier: ID_Y, srvCreated: 1557000000000, srvModified: 1557000000000 }, yFields));
    await col(name).insertOne(x);
    await col(name).insertOne(y);
    return { x: x, y: y };
  }

  async function both (name, pair) {
    return {
      x: plain(await col(name).findOne({ _id: pair.x._id }))
      , y: plain(await col(name).findOne({ _id: pair.y._id }))
    };
  }

  function put (name, doc) {
    return request(self.app).put('/api/' + name + '/').set('api-secret', known).send(doc);
  }

  function emit (event, data) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error('no reply to ' + event)); }, 5000);
      self.socket.emit(event, data, function (reply) {
        clearTimeout(timer);
        setTimeout(function () { resolve(reply); }, 50);
      });
    });
  }

  function save (name, doc) {
    return new Promise(function (resolve) {
      self.ctx[name].save(doc, function (err, result) { resolve({ err: err, result: result }); });
    });
  }

  function setMode (identifier) {
    self.env.write = Object.freeze({ validation: self.env.write.validation, identifier: identifier });
  }

  function sentAs (pair, fields) {
    return Object.assign(plain(pair.x), { _id: String(pair.x._id) }, fields);
  }

  before(function (done) {
    process.env.API_SECRET = 'this is my long pass phrase';
    delete process.env.WRITE_IDENTIFIER;
    self.env = require('../lib/server/env')();
    self.env.settings.authDefaultRoles = 'readable';
    self.env.settings.enable = ['careportal', 'api'];
    self.app = require('express')();
    self.app.enable('api');
    self.app.enable('careportal');
    require('../lib/server/bootevent')(self.env, language).boot(function booted (ctx) {
      self.ctx = ctx;
      self.ctx.ddata = require('../lib/data/ddata')();
      self.ctx.bus.on('data-update', function (e) { if (events) events.push('data-update ' + e.type); });
      self.ctx.bus.on('data-received', function () { if (events) events.push('data-received'); });
      self.app.use('/api', require('../lib/api/')(self.env, ctx));
      var server = http.createServer(require('express')());
      require('../lib/server/websocket')(self.env, ctx, server);
      server.listen(0, function () {
        self.server = server;
        self.socket = io('http://localhost:' + server.address().port, { transports: ['websocket'], reconnection: false });
        self.socket.on('connect', function () {
          self.socket.emit('authorize', { client: 'test', secret: known }, function (auth) {
            if (!auth || !auth.write) return done(new Error('not authorized to write'));
            dropAll().then(function () { done(); }, done);
          });
        });
        self.socket.on('connect_error', done);
      });
    });
  });

  beforeEach(function () {
    setMode('lenient');
    events = [];
    return dropAll();
  });

  after(function (done) {
    setMode('lenient');
    if (self.socket) self.socket.disconnect();
    dropAll().then(function () {
      if (self.server) return self.server.close(function () { done(); });
      done();
    }, done);
  });

  ['food', 'activity', 'profile'].forEach(function (name) {
    describe(name + ', API v1 PUT and in-process save', function () {

      ['lenient', 'strict'].forEach(function (mode) {
        it('PUT X with Y\'s identifier (' + mode + '): 409, the one message, X and Y unchanged', async function () {
          setMode(mode);
          var pair = await seed(name);
          var before = await both(name, pair);
          var res = await put(name, sentAs(pair, { identifier: ID_Y, changed: true }));
          res.status.should.equal(409);
          res.body.should.eql({ status: 409, message: MESSAGE });
          JSON.stringify(res.body).should.not.containEql(ID_Y);
          JSON.stringify(res.body).should.not.containEql(String(pair.y._id));
          (await both(name, pair)).should.eql(before);
        });
      });

      it('PUT X with the identifier of a soft-deleted Y: 409, nothing written', async function () {
        var pair = await seed(name, { isValid: false });
        var before = await both(name, pair);
        var res = await put(name, sentAs(pair, { identifier: ID_Y, changed: true }));
        res.status.should.equal(409);
        (await both(name, pair)).should.eql(before);
      });

      it('PUT X with its own identifier: written', async function () {
        var pair = await seed(name);
        var res = await put(name, sentAs(pair, { identifier: ID_X, changed: true }));
        res.status.should.equal(200);
        var after = await both(name, pair);
        after.x.changed.should.equal(true);
        after.x.identifier.should.equal(ID_X);
        should.not.exist(after.y.changed);
      });

      it('PUT X with no identifier: written', async function () {
        var pair = await seed(name);
        var doc = sentAs(pair, { changed: true });
        delete doc.identifier;
        var res = await put(name, doc);
        res.status.should.equal(200);
        (await both(name, pair)).x.changed.should.equal(true);
      });

      it('in-process save of X with Y\'s identifier: an IdentifierConflictError (409), nothing written', async function () {
        var pair = await seed(name);
        var before = await both(name, pair);
        var saved = await save(name, sentAs(pair, { identifier: ID_Y, changed: true }));
        should.exist(saved.err);
        saved.err.name.should.equal('IdentifierConflictError');
        saved.err.status.should.equal(409);
        saved.err.message.should.equal(MESSAGE);
        (await both(name, pair)).should.eql(before);
      });
    });
  });

  it('food: a PUT batch with one held identifier writes none of it', async function () {
    var pair = await seed('food');
    var before = await both('food', pair);
    var res = await put('food', [sentAs(pair, { identifier: ID_X, changed: true }), Object.assign(plain(pair.y)
      , { _id: String(pair.y._id), identifier: ID_X, changed: true })]);
    res.status.should.equal(409);
    (await both('food', pair)).should.eql(before);
  });

  it('treatments: API v1 PUT keeps its identifier routing (ID-Q10): no conflict, the write lands on Y', async function () {
    var pair = await seed('treatments');
    var res = await put('treatments', sentAs(pair, { identifier: ID_Y, changed: true }));
    res.status.should.equal(200);
    var after = await both('treatments', pair);
    after.y.changed.should.equal(true);
    should.not.exist(after.x.changed);
  });

  describe('the socket\'s dbUpdate by _id', function () {
    ['lenient', 'strict'].forEach(function (mode) {
      it('with Y\'s identifier (' + mode + '): the refusal slot, 409, no event, X and Y unchanged', async function () {
        setMode(mode);
        var pair = await seed('treatments');
        var before = await both('treatments', pair);
        var reply = await emit('dbUpdate', { collection: 'treatments', _id: String(pair.x._id)
          , data: { identifier: ID_Y, notes: 'changed' } });
        reply.should.eql([{ identifier: ID_Y, notes: 'changed'
          , refused: { status: 409, message: MESSAGE, rules: [{ rule: 'identifier-held', field: 'identifier' }] } }]);
        reply[0].refused.message.should.not.containEql(ID_Y);
        events.should.eql([]);
        (await both('treatments', pair)).should.eql(before);
      });
    });

    it('with the identifier of a soft-deleted Y: refused, nothing written', async function () {
      var pair = await seed('food', { isValid: false });
      var before = await both('food', pair);
      var reply = await emit('dbUpdate', { collection: 'food', _id: String(pair.x._id), data: { identifier: ID_Y } });
      reply[0].refused.status.should.equal(409);
      (await both('food', pair)).should.eql(before);
    });

    it('with its own identifier, or none: success, written', async function () {
      var pair = await seed('treatments');
      (await emit('dbUpdate', { collection: 'treatments', _id: String(pair.x._id), data: { identifier: ID_X, notes: 'own' } }))
        .should.eql({ result: 'success' });
      (await both('treatments', pair)).x.notes.should.equal('own');
      (await emit('dbUpdate', { collection: 'treatments', _id: String(pair.x._id), data: { notes: 'none' } }))
        .should.eql({ result: 'success' });
      (await both('treatments', pair)).x.notes.should.equal('none');
    });
  });
});
