'use strict';

// The websocket stores and finds a record by a 24-hex `_id` as the v1 routes do.
//
// dbAdd inserted `_id` exactly as sent, so a 24-hex `_id` was stored as the
// string, while dbUpdate, dbUpdateUnset and dbRemove looked a 24-hex `_id` up
// as the ObjectId only. A record added over the socket with its own `_id` -
// or stored as a string by v1 before it converted - could then not be edited
// or removed over the socket (the reply still said success), and re-sending a
// record stored with an ObjectId `_id` added a string copy beside it.
//
// A custom, non-hex string `_id` is still kept as given
// (tests/websocket.shape-handling.test.js).

var should = require('should');
var ObjectID = require('mongodb').ObjectId;
var language = require('../lib/language')();

describe('websocket: a 24-hex _id is stored as an ObjectId and matched in either form', function () {
  this.timeout(15000);
  var self = this;
  var http = require('http');
  var io = require('socket.io-client');

  var HEX = {
    addFood: '5f41abcdef0000000000a001'
    , addStatusUpper: '5F41ABCDEF0000000000A002'
    , resendOid: '5f41abcdef0000000000b003'
    , resendString: '5f41abcdef0000000000b004'
    , resendUpperString: '5F41ABCDEF0000000000B005'
    , updateString: '5f41abcdef0000000000b006'
    , unsetUpperString: '5F41ABCDEF0000000000B007'
    , removeString: '5f41abcdef0000000000b008'
    , removeTwins: '5f41abcdef0000000000b009'
    , similarString: '5f41abcdef0000000000b00a'
    , updateOid: '5f41abcdef0000000000b00b'
    , updateTwins: '5f41abcdef0000000000b00c'
    , unsetTwins: '5f41abcdef0000000000b00d'
  };

  function col (name) {
    return self.ctx.store.collection(self.env[name + '_collection']);
  }

  function storedFor (name, hex) {
    return col(name).find({ _id: { $in: [new ObjectID(hex), hex, hex.toLowerCase()] } }).toArray();
  }

  function emit (event, data) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error('no reply to ' + event)); }, 5000);
      self.socket.emit(event, data, function (reply) {
        clearTimeout(timer);
        resolve(reply);
      });
    });
  }

  // Synthetic values only.
  function food (extra) {
    return Object.assign({ type: 'food', category: 'ws-object-id-test', name: 'a food', carbs: 10 }, extra || {});
  }

  function dropAll () {
    var ids = [];
    Object.keys(HEX).forEach(function (k) {
      ids.push(new ObjectID(HEX[k]), HEX[k], HEX[k].toLowerCase());
    });
    return Promise.all(['food', 'devicestatus', 'treatments', 'activity', 'entries'].map(function (name) {
      return col(name).deleteMany({ _id: { $in: ids } });
    }));
  }

  before(function (done) {
    process.env.API_SECRET = 'this is my long pass phrase';
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
          self.socket.emit('authorize', { client: 'test', secret: 'b723e97aa97846eb92d5264f084b2823f57c4aa1' }, function (auth) {
            if (!auth || !auth.write || !auth.write_treatment) return done(new Error('not authorized to write'));
            dropAll().then(function () { done(); }, done);
          });
        });
        self.socket.on('connect_error', done);
      });
    });
  });

  after(function (done) {
    if (self.socket) self.socket.disconnect();
    dropAll().then(function () {
      if (self.server) return self.server.close(function () { done(); });
      done();
    }, done);
  });

  describe('dbAdd', function () {

    it('stores a 24-hex _id as the ObjectId it names', async function () {
      await emit('dbAdd', { collection: 'food', data: food({ _id: HEX.addFood }) });
      var docs = await storedFor('food', HEX.addFood);
      docs.length.should.equal(1);
      (docs[0]._id instanceof ObjectID).should.equal(true);
    });

    it('stores an upper-case 24-hex _id as the ObjectId it names', async function () {
      await emit('dbAdd', { collection: 'devicestatus', data: { _id: HEX.addStatusUpper, device: 'ws-object-id-test', created_at: '2021-05-07T01:00:00.000Z' } });
      var docs = await storedFor('devicestatus', HEX.addStatusUpper);
      docs.length.should.equal(1);
      (docs[0]._id instanceof ObjectID).should.equal(true);
    });

    it('re-sending a record stored with an ObjectId _id adds no string copy', async function () {
      await col('food').insertOne(food({ _id: new ObjectID(HEX.resendOid) }));
      await emit('dbAdd', { collection: 'food', data: food({ _id: HEX.resendOid, carbs: 20 }) });
      var docs = await storedFor('food', HEX.resendOid);
      docs.length.should.equal(1);
      (docs[0]._id instanceof ObjectID).should.equal(true);
    });

    it('re-sending a record stored with the string _id adds no ObjectId copy (control)', async function () {
      await col('food').insertOne(food({ _id: HEX.resendString }));
      await emit('dbAdd', { collection: 'food', data: food({ _id: HEX.resendString, carbs: 20 }) });
      var docs = await storedFor('food', HEX.resendString);
      docs.length.should.equal(1);
      docs[0]._id.should.equal(HEX.resendString);
    });

    it('re-sending a record stored with an upper-case string _id, in upper case, adds no ObjectId copy', async function () {
      await col('activity').insertOne({ _id: HEX.resendUpperString, created_at: '2021-05-07T02:00:00.000Z', steps: 1 });
      await emit('dbAdd', { collection: 'activity', data: { _id: HEX.resendUpperString, created_at: '2021-05-07T02:00:00.000Z', steps: 2 } });
      var docs = await storedFor('activity', HEX.resendUpperString);
      docs.length.should.equal(1);
      docs[0]._id.should.equal(HEX.resendUpperString);
    });

    it('a similar treatment stored with a string _id gets the new created_at', async function () {
      await col('treatments').insertOne({ _id: HEX.similarString, eventType: 'Correction Bolus', insulin: 1.5, created_at: '2021-05-07T03:00:00.000Z' });
      await emit('dbAdd', { collection: 'treatments', data: { eventType: 'Correction Bolus', insulin: 1.5, created_at: '2021-05-07T03:00:01.000Z' } });
      var docs = await storedFor('treatments', HEX.similarString);
      docs.length.should.equal(1);
      docs[0].created_at.should.equal('2021-05-07T03:00:01.000Z');
    });
  });

  describe('dbUpdate, dbUpdateUnset, dbRemove', function () {

    it('dbUpdate edits a record stored with the string _id', async function () {
      await col('treatments').insertOne({ _id: HEX.updateString, eventType: 'Note', notes: 'before', created_at: '2021-05-07T04:00:00.000Z' });
      var reply = await emit('dbUpdate', { collection: 'treatments', _id: HEX.updateString, data: { notes: 'after' } });
      reply.result.should.equal('success');
      var docs = await storedFor('treatments', HEX.updateString);
      docs.length.should.equal(1);
      docs[0].notes.should.equal('after');
    });

    it('dbUpdate edits both an ObjectId copy and a string copy of one id', async function () {
      await col('treatments').insertMany([
        { _id: HEX.updateTwins, eventType: 'Note', notes: 'before', created_at: '2021-05-07T04:30:00.000Z' }
        , { _id: new ObjectID(HEX.updateTwins), eventType: 'Note', notes: 'before', created_at: '2021-05-07T04:30:00.000Z' }
      ]);
      await emit('dbUpdate', { collection: 'treatments', _id: HEX.updateTwins, data: { notes: 'after' } });
      var docs = await storedFor('treatments', HEX.updateTwins);
      docs.length.should.equal(2);
      docs.forEach(function (d) { d.notes.should.equal('after'); });
    });

    it('dbUpdate edits a record stored with an ObjectId _id (control)', async function () {
      await col('treatments').insertOne({ _id: new ObjectID(HEX.updateOid), eventType: 'Note', notes: 'before', created_at: '2021-05-07T05:00:00.000Z' });
      await emit('dbUpdate', { collection: 'treatments', _id: HEX.updateOid, data: { notes: 'after' } });
      var docs = await storedFor('treatments', HEX.updateOid);
      docs.length.should.equal(1);
      docs[0].notes.should.equal('after');
    });

    it('dbUpdateUnset edits a record stored with an upper-case string _id', async function () {
      await col('devicestatus').insertOne({ _id: HEX.unsetUpperString, device: 'ws-object-id-test', created_at: '2021-05-07T06:00:00.000Z', extra: 1 });
      await emit('dbUpdateUnset', { collection: 'devicestatus', _id: HEX.unsetUpperString, data: { extra: 1 } });
      var docs = await storedFor('devicestatus', HEX.unsetUpperString);
      docs.length.should.equal(1);
      should.not.exist(docs[0].extra);
    });

    it('dbUpdateUnset edits both an ObjectId copy and a string copy of one id', async function () {
      await col('devicestatus').insertMany([
        { _id: HEX.unsetTwins, device: 'ws-object-id-test', created_at: '2021-05-07T06:30:00.000Z', extra: 1 }
        , { _id: new ObjectID(HEX.unsetTwins), device: 'ws-object-id-test', created_at: '2021-05-07T06:30:00.000Z', extra: 1 }
      ]);
      await emit('dbUpdateUnset', { collection: 'devicestatus', _id: HEX.unsetTwins, data: { extra: 1 } });
      var docs = await storedFor('devicestatus', HEX.unsetTwins);
      docs.length.should.equal(2);
      docs.forEach(function (d) { should.not.exist(d.extra); });
    });

    it('dbRemove removes a record stored with the string _id', async function () {
      await col('entries').insertOne({ _id: HEX.removeString, type: 'sgv', sgv: 100, date: 1620357600000 });
      var reply = await emit('dbRemove', { collection: 'entries', _id: HEX.removeString });
      reply.result.should.equal('success');
      (await storedFor('entries', HEX.removeString)).length.should.equal(0);
    });

    it('dbRemove removes both an ObjectId copy and a string copy of one id', async function () {
      await col('food').insertMany([food({ _id: HEX.removeTwins }), food({ _id: new ObjectID(HEX.removeTwins) })]);
      await emit('dbRemove', { collection: 'food', _id: HEX.removeTwins });
      (await storedFor('food', HEX.removeTwins)).length.should.equal(0);
    });
  });
});
