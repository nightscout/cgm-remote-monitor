'use strict';

// The socket's dbUpdate, dbUpdateUnset and dbRemove addressed by `identifier`
// when no `_id` is sent (ID-FIRST-MATCH slice 1, decision 4 and ID-Q10 of the
// design note 2026-10-29). Written first against 9919f8ef, where every such
// request is refused with { result: 'Missing or invalid _id' } and writes
// nothing (checkConditions in lib/server/websocket.js).
//
// Each fixture asserts the reply, the stored records and the bus events. A
// request that sends an `_id` is addressed by it exactly as before, whatever
// `identifier` it also carries.
//
// Synthetic values only; every record is dated in May 2019.

var should = require('should');
var language = require('../lib/language')();

describe('websocket: dbUpdate, dbUpdateUnset and dbRemove addressed by identifier', function () {
  this.timeout(15000);
  var self = this;
  var http = require('http');
  var io = require('socket.io-client');
  var hash = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
  var FROM = '2019-05-01T00:00:00.000Z';
  var TO = '2019-06-01T00:00:00.000Z';
  var TAG = 'ws-identifier-address';
  var T_MS = Date.parse('2019-05-11T07:40:00.000Z');
  var ID = 'f1d2c3b4-0000-4000-8000-00000000a001';
  var OTHER = 'f1d2c3b4-0000-4000-8000-00000000a002';

  function at (offset) {
    return new Date(T_MS + (offset || 0)).toISOString();
  }

  function col (name) {
    return self.ctx.store.collection(self.env[(name || 'treatments') + '_collection']);
  }

  function stored (name) {
    return col(name).find({ created_at: { $gte: FROM, $lt: TO } }).sort({ created_at: 1, _id: 1 }).toArray();
  }

  function dropAll () {
    return Promise.all(['treatments', 'food'].map(function (name) {
      return col(name).deleteMany({ created_at: { $gte: FROM, $lt: TO } });
    }));
  }

  function plain (doc) {
    return JSON.parse(JSON.stringify(doc));
  }

  function send (event, data) {
    var events = [];
    function onUpdate (payload) {
      events.push({ event: 'data-update', payload: JSON.parse(JSON.stringify(payload)) });
    }
    function onReceived () {
      events.push({ event: 'data-received' });
    }
    self.ctx.bus.on('data-update', onUpdate);
    self.ctx.bus.on('data-received', onReceived);
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error('no reply to ' + event)); }, 5000);
      self.socket.emit(event, data, function (reply) {
        clearTimeout(timer);
        setTimeout(function () { resolve(reply); }, 50);
      });
    }).then(function (reply) {
      return { reply: reply, events: events };
    }).finally(function () {
      self.ctx.bus.removeListener('data-update', onUpdate);
      self.ctx.bus.removeListener('data-received', onReceived);
    });
  }

  async function seed (name, doc) {
    var copy = Object.assign({ srvModified: 1557000000000, srvCreated: 1557000000000 }, doc);
    var result = await col(name).insertOne(copy);
    return Object.assign({ _id: result.insertedId }, copy);
  }

  function treatment (offset, fields) {
    return Object.assign({ eventType: 'Meal Bolus', created_at: at(offset), enteredBy: TAG }, fields);
  }

  // A refused request: its reply, no event, nothing written.
  async function shouldBeRefused (result, reason, before, name) {
    result.reply.should.eql({ result: reason });
    result.events.should.eql([]);
    (await stored(name)).map(plain).should.eql(before.map(plain));
  }

  // The fields of a record that the step stamps on every write.
  function withoutServerTime (doc) {
    var copy = plain(doc);
    delete copy.srvModified;
    return copy;
  }

  before(function (done) {
    process.env.API_SECRET = 'this is my long pass phrase';
    delete process.env.WRITE_VALIDATION;
    self.env = require('../lib/server/env')();
    self.env.settings.authDefaultRoles = 'readable';
    self.env.settings.enable = ['careportal', 'api'];
    require('../lib/server/bootevent')(self.env, language).boot(function booted (ctx) {
      self.ctx = ctx;
      self.ctx.ddata = require('../lib/data/ddata')();
      var server = http.createServer(require('express')());
      require('../lib/server/websocket')(self.env, ctx, server);
      server.listen(0, function () {
        self.server = server;
        self.socket = io('http://localhost:' + server.address().port, { transports: ['websocket'], reconnection: false });
        self.socket.on('connect', function () {
          self.socket.emit('authorize', { client: 'test', secret: hash }, function (auth) {
            if (!auth || !auth.read || !auth.write || !auth.write_treatment) return done(new Error('not authorized to read and write'));
            done();
          });
        });
        self.socket.on('connect_error', done);
      });
    });
  });

  beforeEach(function () {
    self.env.writeValidation = 'off';
    return dropAll();
  });

  after(function (done) {
    if (self.socket) self.socket.disconnect();
    dropAll().then(function () {
      if (self.server) return self.server.close(function () { done(); });
      done();
    }, done);
  });

  describe('requests that stay as they were', function () {

    ['dbUpdate', 'dbUpdateUnset', 'dbRemove'].forEach(function (event) {
      var data = event === 'dbRemove' ? undefined : (event === 'dbUpdate' ? { notes: 'x' } : { notes: 1 });

      it(event + ' with neither _id nor identifier is refused: Missing or invalid _id', async function () {
        var before = [await seed('treatments', treatment(0, { carbs: 20, identifier: ID, notes: 'a' }))];
        var request = { collection: 'treatments' };
        if (data) request.data = data;
        await shouldBeRefused(await send(event, request), 'Missing or invalid _id', before, 'treatments');
      });

      it(event + ' with an _id that is not an id and a stored identifier is refused: Missing or invalid _id', async function () {
        var before = [await seed('treatments', treatment(0, { carbs: 20, identifier: ID, notes: 'a' }))];
        var request = { collection: 'treatments', _id: { $ne: null }, identifier: ID };
        if (data) request.data = data;
        await shouldBeRefused(await send(event, request), 'Missing or invalid _id', before, 'treatments');
      });

      ['', 'undefined', 'null', 'invalid', 'NaN', 'x'.repeat(257), { $ne: null }, 42].forEach(function (value) {
        var label = typeof value === 'string' && value.length > 20 ? '257 characters' : JSON.stringify(value);
        it(event + ' with no _id and the identifier ' + label + ' is refused: Missing or invalid _id', async function () {
          var before = [await seed('treatments', treatment(0, { carbs: 20
            , identifier: typeof value === 'string' ? value : ID, notes: 'a' }))];
          var request = { collection: 'treatments', identifier: value };
          if (data) request.data = data;
          await shouldBeRefused(await send(event, request), 'Missing or invalid _id', before, 'treatments');
        });
      });
    });

    it('dbUpdate with an _id and an identifier of another record is addressed by the _id', async function () {
      var a = await seed('treatments', treatment(0, { carbs: 20, identifier: ID, notes: 'a' }));
      var b = await seed('treatments', treatment(60000, { carbs: 30, identifier: OTHER, notes: 'b' }));
      var result = await send('dbUpdate', { collection: 'treatments', _id: String(a._id), identifier: OTHER, data: { notes: 'edited' } });
      result.reply.should.eql({ result: 'success' });
      var after = await stored('treatments');
      withoutServerTime(after[0]).should.eql(withoutServerTime(Object.assign({}, a, { notes: 'edited' })));
      plain(after[1]).should.eql(plain(b));
    });

    it('dbRemove with an _id and an identifier of another record removes only the _id', async function () {
      var a = await seed('treatments', treatment(0, { carbs: 20, identifier: ID }));
      var b = await seed('treatments', treatment(60000, { carbs: 30, identifier: OTHER }));
      var result = await send('dbRemove', { collection: 'treatments', _id: String(a._id), identifier: OTHER });
      result.reply.should.eql({ result: 'success' });
      (await stored('treatments')).map(plain).should.eql([plain(b)]);
    });
  });

  describe('addressed by identifier when no _id is sent (decision 4)', function () {

    it('dbUpdate with an identifier and no _id is refused: Missing or invalid _id', async function () {
      var before = [await seed('treatments', treatment(0, { carbs: 20, identifier: ID, notes: 'a' }))];
      await shouldBeRefused(await send('dbUpdate', { collection: 'treatments', identifier: ID, data: { notes: 'edited' } })
        , 'Missing or invalid _id', before, 'treatments');
    });

    it('dbUpdateUnset with an identifier and no _id is refused: Missing or invalid _id', async function () {
      var before = [await seed('treatments', treatment(0, { carbs: 20, identifier: ID, notes: 'a' }))];
      await shouldBeRefused(await send('dbUpdateUnset', { collection: 'treatments', identifier: ID, data: { notes: 1 } })
        , 'Missing or invalid _id', before, 'treatments');
    });

    it('dbUpdate with an identifier and _id null is refused: Missing or invalid _id', async function () {
      var before = [await seed('treatments', treatment(0, { carbs: 20, identifier: ID, notes: 'a' }))];
      await shouldBeRefused(await send('dbUpdate', { collection: 'treatments', _id: null, identifier: ID, data: { notes: 'edited' } })
        , 'Missing or invalid _id', before, 'treatments');
    });

    it('dbRemove with an identifier and no _id is refused: Missing or invalid _id', async function () {
      var before = [await seed('treatments', treatment(0, { carbs: 20, identifier: ID }))];
      await shouldBeRefused(await send('dbRemove', { collection: 'treatments', identifier: ID })
        , 'Missing or invalid _id', before, 'treatments');
    });
  });
});
