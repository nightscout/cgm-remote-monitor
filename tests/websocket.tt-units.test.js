'use strict';

// BF-194 on the realtime socket: dbAdd and dbUpdate store a Temporary Target
// in mg/dL labelled `units: mg/dl` (lib/treatmentTargetUnits.js), as API v1
// and v3 do (tests/api.treatments-tt-units.test.js). WRITE_VALIDATION off;
// synthetic values only.

var should = require('should');
var ObjectID = require('mongodb').ObjectId;
var language = require('../lib/language')();
var MMOL = require('../lib/constants.json').MMOL_TO_MGDL;

describe('websocket: Temporary Target units at write time (BF-194)', function () {
  this.timeout(15000);
  var self = this;
  var http = require('http');
  var io = require('socket.io-client');
  var TAG = 'ws-tt-units-test';
  var seq = 0;

  function col () {
    return self.ctx.store.collection(self.env.treatments_collection);
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

  function target (extra) {
    seq += 1;
    return Object.assign({
      eventType: 'Temporary Target'
      , created_at: new Date(Date.now() - 7200000 - seq * 60000).toISOString()
      , enteredBy: TAG
      , reason: 'Eating Soon'
      , duration: 60
    }, extra || {});
  }

  async function stored (createdAt) {
    var docs = await col().find({ created_at: createdAt, enteredBy: TAG }).toArray();
    docs.length.should.equal(1);
    return docs[0];
  }

  function shouldBeMgdl (doc, want) {
    ({ targetTop: doc.targetTop, targetBottom: doc.targetBottom, units: doc.units })
      .should.eql({ targetTop: want[0], targetBottom: want[1], units: 'mg/dl' });
  }

  var RULES = [
    { name: 'labelled mmol', units: 'mmol', top: 6, bottom: 5, want: [6 * MMOL, 5 * MMOL] }
    , { name: 'labelled mmol/L', units: 'mmol/L', top: 6.5, bottom: 5.5, want: [6.5 * MMOL, 5.5 * MMOL] }
    , { name: 'unlabelled with a target below 20', top: 6, bottom: 5, want: [6 * MMOL, 5 * MMOL] }
    , { name: 'unlabelled with targets of 20 or more', top: 120, bottom: 20, want: [120, 20] }
    , { name: 'labelled mg/dL', units: 'mg/dL', top: 120, bottom: 100, want: [120, 100] }
  ];

  function fields (rule) {
    var f = { targetTop: rule.top, targetBottom: rule.bottom };
    if (rule.units !== undefined) f.units = rule.units;
    return f;
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
          self.socket.emit('authorize', { client: 'test', secret: 'b723e97aa97846eb92d5264f084b2823f57c4aa1' }, function (auth) {
            if (!auth || !auth.write || !auth.write_treatment) return done(new Error('not authorized to write'));
            col().deleteMany({ enteredBy: TAG }).then(function () { done(); }, done);
          });
        });
        self.socket.on('connect_error', done);
      });
    });
  });

  after(function (done) {
    if (self.socket) self.socket.disconnect();
    col().deleteMany({ enteredBy: TAG }).then(function () {
      if (self.server) return self.server.close(function () { done(); });
      done();
    }, done);
  });

  describe('dbAdd, one treatment', function () {
    RULES.forEach(function (rule) {
      it(rule.name, async function () {
        var doc = target(fields(rule));
        var reply = await emit('dbAdd', { collection: 'treatments', data: doc });
        reply.length.should.equal(1);
        shouldBeMgdl(await stored(doc.created_at), rule.want);
        reply[0].units.should.equal('mg/dl');
      });
    });

    it('does not touch another event type', async function () {
      var doc = target({ eventType: 'Note', notes: 'tt-units', targetTop: 6, targetBottom: 5, units: 'mmol' });
      await emit('dbAdd', { collection: 'treatments', data: doc });
      var s = await stored(doc.created_at);
      s.targetTop.should.equal(6);
      s.units.should.equal('mmol');
    });
  });

  describe('dbAdd, an array', function () {
    it('applies each rule to its own item', async function () {
      var docs = RULES.map(function (rule) { return target(fields(rule)); });
      var reply = await emit('dbAdd', { collection: 'treatments', data: docs });
      reply.length.should.equal(RULES.length);
      for (var i = 0; i < RULES.length; i++) {
        shouldBeMgdl(await stored(docs[i].created_at), RULES[i].want);
      }
    });
  });

  describe('dbUpdate', function () {
    async function seed (doc) {
      var result = await col().insertOne(Object.assign({}, doc));
      return result.insertedId;
    }

    it('converts targets sent in mmol onto a stored mg/dl record', async function () {
      var doc = target({ targetTop: 150, targetBottom: 140, units: 'mg/dl' });
      var id = await seed(doc);
      var reply = await emit('dbUpdate', { collection: 'treatments', _id: id.toHexString(), data: { targetTop: 7, targetBottom: 6, units: 'mmol' } });
      reply.result.should.equal('success');
      shouldBeMgdl(await stored(doc.created_at), [7 * MMOL, 6 * MMOL]);
    });

    it('keeps mg/dL targets of a stored mg/dl record', async function () {
      var doc = target({ targetTop: 150, targetBottom: 140, units: 'mg/dl' });
      var id = await seed(doc);
      await emit('dbUpdate', { collection: 'treatments', _id: id.toHexString(), data: { targetTop: 160 } });
      shouldBeMgdl(await stored(doc.created_at), [160, 140]);
    });

    it('converts both targets of an unlabelled stored record when one is edited', async function () {
      var doc = target({ targetTop: 6, targetBottom: 5 });
      var id = await seed(doc);
      await emit('dbUpdate', { collection: 'treatments', _id: id.toHexString(), data: { targetTop: 7 } });
      shouldBeMgdl(await stored(doc.created_at), [7 * MMOL, 5 * MMOL]);
    });

    it('leaves a stored record alone when the update does not touch targets or units', async function () {
      var doc = target({ targetTop: 6, targetBottom: 5, units: 'mmol' });
      var id = await seed(doc);
      await emit('dbUpdate', { collection: 'treatments', _id: id.toHexString(), data: { notes: 'checked' } });
      var s = await stored(doc.created_at);
      s.targetTop.should.equal(6);
      s.units.should.equal('mmol');
    });

    it('does not touch another event type', async function () {
      var doc = target({ eventType: 'Note', notes: 'tt-units', targetTop: 6, targetBottom: 5, units: 'mg/dl' });
      var id = await seed(doc);
      await emit('dbUpdate', { collection: 'treatments', _id: id.toHexString(), data: { units: 'mmol' } });
      var s = await stored(doc.created_at);
      s.targetTop.should.equal(6);
      s.units.should.equal('mmol');
      should.exist(new ObjectID(id));
    });
  });
});
