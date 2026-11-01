'use strict';

// The socket's dbUpdate, dbUpdateUnset and dbRemove addressed by `identifier`
// when no `_id` is sent (ID-FIRST-MATCH slice 1, decision 4 and ID-Q10 of the
// design note 2026-10-29). Written first against 9919f8ef, where every such
// request is refused with { result: 'Missing or invalid _id' } and writes
// nothing (checkConditions in lib/server/websocket.js); the fixtures that
// decision 4 changed are marked CHANGED EXPECTATION. An edit lands on the
// record P4 names; a remove reaches every record sharing the identifier.
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
    // Records sharing an identifier are stored as before the unique index
    // (ID-UNIQUE-INDEX).
    return require('./fixtures/identifier-index').dropIdentifierIndex(self.ctx.store, self.env).then(dropAll);
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

      // Slice 2 (ID-Q6, ID-PLACEHOLDER-LIST): the shared identifier-format list
      // adds `unknown`, whitespace-only values and case variants of a placeholder.
      ['', 'undefined', 'null', 'invalid', 'NaN', 'x'.repeat(257), { $ne: null }, 42
        , '   ', 'unknown', 'Undefined', 'NULL', 'nan'].forEach(function (value) {
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

    // The events of an edit that left these records as stored.
    function updateEvents (docs) {
      return [
        { event: 'data-update', payload: { type: 'treatments', op: 'update', changes: self.ctx.ddata.processRawDataForRuntime(docs.map(plain)) } }
        , { event: 'data-received' }
      ];
    }

    // CHANGED EXPECTATION (ID-FIRST-MATCH slice 1, decision 4): was refused, Missing or invalid _id.
    it('dbUpdate with an identifier and no _id edits the record it names', async function () {
      var a = await seed('treatments', treatment(0, { carbs: 20, identifier: ID, notes: 'a' }));
      var b = await seed('treatments', treatment(60000, { carbs: 30, identifier: OTHER, notes: 'b' }));
      var result = await send('dbUpdate', { collection: 'treatments', identifier: ID, data: { notes: 'edited', carbs: null } });
      result.reply.should.eql({ result: 'success' });
      var after = await stored('treatments');
      var edited = Object.assign({}, a, { notes: 'edited' });
      delete edited.carbs;
      withoutServerTime(after[0]).should.eql(withoutServerTime(edited));
      after[0].srvModified.should.be.above(a.srvModified);
      plain(after[1]).should.eql(plain(b));
      result.events.should.eql(updateEvents([after[0]]));
    });

    // CHANGED EXPECTATION (ID-FIRST-MATCH slice 1, decision 4): was refused, Missing or invalid _id.
    it('dbUpdateUnset with an identifier and no _id removes the fields from the record it names', async function () {
      var a = await seed('treatments', treatment(0, { carbs: 20, identifier: ID, notes: 'a' }));
      var b = await seed('treatments', treatment(60000, { carbs: 30, identifier: OTHER, notes: 'b' }));
      var result = await send('dbUpdateUnset', { collection: 'treatments', identifier: ID, data: { notes: 1 } });
      result.reply.should.eql({ result: 'success' });
      var after = await stored('treatments');
      var edited = Object.assign({}, a);
      delete edited.notes;
      withoutServerTime(after[0]).should.eql(withoutServerTime(edited));
      plain(after[1]).should.eql(plain(b));
      result.events.should.eql(updateEvents([after[0]]));
    });

    // CHANGED EXPECTATION (ID-FIRST-MATCH slice 1, decision 4): was refused, Missing or invalid _id.
    it('dbUpdate with an identifier and _id null edits the record it names', async function () {
      var a = await seed('treatments', treatment(0, { carbs: 20, identifier: ID, notes: 'a' }));
      var result = await send('dbUpdate', { collection: 'treatments', _id: null, identifier: ID, data: { notes: 'edited' } });
      result.reply.should.eql({ result: 'success' });
      withoutServerTime((await stored('treatments'))[0]).should.eql(withoutServerTime(Object.assign({}, a, { notes: 'edited' })));
    });

    // CHANGED EXPECTATION (ID-FIRST-MATCH slice 1, decision 4): was refused, Missing or invalid _id.
    it('dbRemove with an identifier and no _id removes the record it names, and announces its _id', async function () {
      var a = await seed('treatments', treatment(0, { carbs: 20, identifier: ID }));
      var b = await seed('treatments', treatment(60000, { carbs: 30, identifier: OTHER }));
      var result = await send('dbRemove', { collection: 'treatments', identifier: ID });
      result.reply.should.eql({ result: 'success' });
      (await stored('treatments')).map(plain).should.eql([plain(b)]);
      // The removed record by its _id, as dbRemove by _id announces it: a
      // remove that names no record would drop the collection's cache.
      result.events.should.eql([
        { event: 'data-update', payload: { type: 'treatments', op: 'remove', count: 1, changes: [a._id.toHexString()] } }
        , { event: 'data-received' }
      ]);
    });

    it('two records share the identifier: dbUpdate lands on the one at the created_at it sends (P4)', async function () {
      var a = await seed('treatments', treatment(0, { carbs: 20, identifier: ID, notes: 'a' }));
      var b = await seed('treatments', treatment(120000, { carbs: 30, identifier: ID, notes: 'b' }));
      var result = await send('dbUpdate', { collection: 'treatments', identifier: ID, data: { created_at: a.created_at, notes: 'edited' } });
      result.reply.should.eql({ result: 'success' });
      var after = await stored('treatments');
      withoutServerTime(after[0]).should.eql(withoutServerTime(Object.assign({}, a, { notes: 'edited' })));
      plain(after[1]).should.eql(plain(b));
    });

    it('two records share the identifier: dbUpdate without a matching time lands on the newest by _id (P4)', async function () {
      var a = await seed('treatments', treatment(0, { carbs: 20, identifier: ID, notes: 'a' }));
      var b = await seed('treatments', treatment(120000, { carbs: 30, identifier: ID, notes: 'b' }));
      var result = await send('dbUpdate', { collection: 'treatments', identifier: ID, data: { notes: 'edited' } });
      result.reply.should.eql({ result: 'success' });
      var after = await stored('treatments');
      plain(after[0]).should.eql(plain(a));
      withoutServerTime(after[1]).should.eql(withoutServerTime(Object.assign({}, b, { notes: 'edited' })));
    });

    it('two records share the identifier: dbUpdateUnset lands on the newest by _id (P4)', async function () {
      var a = await seed('treatments', treatment(0, { carbs: 20, identifier: ID, notes: 'a' }));
      var b = await seed('treatments', treatment(120000, { carbs: 30, identifier: ID, notes: 'b' }));
      var result = await send('dbUpdateUnset', { collection: 'treatments', identifier: ID, data: { notes: 1 } });
      result.reply.should.eql({ result: 'success' });
      var after = await stored('treatments');
      plain(after[0]).should.eql(plain(a));
      var edited = Object.assign({}, b);
      delete edited.notes;
      withoutServerTime(after[1]).should.eql(withoutServerTime(edited));
    });

    it('two records share the identifier: dbRemove removes both and announces both _ids (ID-Q10)', async function () {
      var a = await seed('treatments', treatment(0, { carbs: 20, identifier: ID }));
      var b = await seed('treatments', treatment(120000, { carbs: 30, identifier: ID }));
      var c = await seed('treatments', treatment(240000, { carbs: 40, identifier: OTHER }));
      var result = await send('dbRemove', { collection: 'treatments', identifier: ID });
      result.reply.should.eql({ result: 'success' });
      (await stored('treatments')).map(plain).should.eql([plain(c)]);
      result.events.length.should.equal(2);
      result.events[0].payload.count.should.equal(2);
      result.events[0].payload.changes.slice().sort().should.eql([a._id.toHexString(), b._id.toHexString()].sort());
    });

    it('an identifier that names no record: dbUpdate and dbRemove answer success and write nothing', async function () {
      var before = [await seed('treatments', treatment(0, { carbs: 20, identifier: OTHER, notes: 'a' }))];
      var update = await send('dbUpdate', { collection: 'treatments', identifier: ID, data: { notes: 'edited' } });
      update.reply.should.eql({ result: 'success' });
      update.events.should.eql([{ event: 'data-received' }]);
      var remove = await send('dbRemove', { collection: 'treatments', identifier: ID });
      remove.reply.should.eql({ result: 'success' });
      // Nothing removed: no remove is announced at all, never one without changes.
      remove.events.should.eql([{ event: 'data-received' }]);
      (await stored('treatments')).map(plain).should.eql(before.map(plain));
    });

    // CHANGED EXPECTATION (ID-FIRST-MATCH slice 3, ID-Q3): an edit of a
    // soft-deleted record, by identifier as by _id, is answered success and
    // not applied (WRITE_DELETED_EDIT=ignore); the record stays deleted and
    // nothing is announced. It was applied.
    it('a soft-deleted record is edited by identifier as it is by _id today', async function () {
      var a = await seed('treatments', treatment(0, { carbs: 20, identifier: ID, notes: 'a', isValid: false }));
      var result = await send('dbUpdate', { collection: 'treatments', identifier: ID, data: { notes: 'edited' } });
      result.reply.should.eql({ result: 'success' });
      result.events.should.eql([]);
      withoutServerTime((await stored('treatments'))[0]).should.eql(withoutServerTime(a));
      var byId = await send('dbUpdate', { collection: 'treatments', _id: String(a._id), data: { notes: 'edited' } });
      byId.reply.should.eql({ result: 'success' });
      withoutServerTime((await stored('treatments'))[0]).should.eql(withoutServerTime(a));
    });

    it('food: dbUpdate and dbRemove by identifier', async function () {
      var f = await seed('food', { created_at: at(0), name: 'apple', carbs: 15, identifier: ID });
      var update = await send('dbUpdate', { collection: 'food', identifier: ID, data: { carbs: 16 } });
      update.reply.should.eql({ result: 'success' });
      withoutServerTime((await stored('food'))[0]).should.eql(withoutServerTime(Object.assign({}, f, { carbs: 16 })));
      var remove = await send('dbRemove', { collection: 'food', identifier: ID });
      remove.reply.should.eql({ result: 'success' });
      remove.events.should.eql([
        { event: 'data-update', payload: { type: 'food', op: 'remove', count: 1, changes: [f._id.toHexString()] } }
        , { event: 'data-received' }
      ]);
      (await stored('food')).should.eql([]);
    });
  });

  // WC-STEP-PATCH release 2 (write-contract Q-A; the owner's condition 3): one
  // socket input that reaches several records is announced through the
  // WriteResult's removed / updated: every record it reached, once, and
  // nothing else; and a merged socket insert (ID-FIRST-MATCH 6a) is announced
  // once, by its own handler, not again by the step.
  describe('several records reached by one socket input', function () {
    function ids (docs) { return docs.map(function (d) { return String(d._id); }).sort(); }

    it('dbRemove by an identifier three records share: one remove naming exactly those three', async function () {
      var a = await seed('treatments', treatment(1, { identifier: ID }));
      var b = await seed('treatments', treatment(2, { identifier: ID }));
      var c = await seed('treatments', treatment(3, { identifier: ID }));
      var other = await seed('treatments', treatment(4, { identifier: OTHER }));
      var result = await send('dbRemove', { collection: 'treatments', identifier: ID });
      result.reply.should.eql({ result: 'success' });
      var removes = result.events.filter(function (e) { return e.event === 'data-update'; });
      removes.length.should.equal(1);
      removes[0].payload.op.should.equal('remove');
      removes[0].payload.changes.slice().sort().should.eql(ids([a, b, c]));
      (await stored()).map(plain).should.eql([plain(other)]);
    });

    it('dbUpdate by an identifier whose record is stored in two forms: one update naming both', async function () {
      var ObjectID = require('mongodb').ObjectId;
      var oid = new ObjectID();
      await seed('treatments', treatment(1, { _id: oid, identifier: ID }));
      await seed('treatments', treatment(1, { _id: oid.toHexString(), identifier: ID }));
      await seed('treatments', treatment(5, { identifier: OTHER }));
      var result = await send('dbUpdate', { collection: 'treatments', identifier: ID, data: { notes: 'both forms' } });
      result.reply.should.eql({ result: 'success' });
      var updates = result.events.filter(function (e) { return e.event === 'data-update'; });
      updates.length.should.equal(1);
      updates[0].payload.op.should.equal('update');
      updates[0].payload.changes.map(function (d) { return d.notes; }).should.eql(['both forms', 'both forms']);
      updates[0].payload.changes.map(function (d) { return String(d._id); }).should.eql([oid.toHexString(), oid.toHexString()]);
      (await col().countDocuments({ identifier: ID, notes: 'both forms' })).should.equal(2);
    });

    // CHANGED EXPECTATION (maintainer 2026-10-31, compat card B, extended): the
    // socket insert matched by its identifier (6a) replaces the stored record
    // (it was merged); it is still announced once, as the record now stored.
    it('a socket insert replaced by its identifier (6a) is announced once', async function () {
      await seed('food', { name: 'apple', identifier: ID, created_at: at(0) });
      var result = await send('dbAdd', { collection: 'food', data: { name: 'apple pie', identifier: ID, created_at: at(0) } });
      result.reply.length.should.equal(1);
      var updates = result.events.filter(function (e) { return e.event === 'data-update'; });
      updates.length.should.equal(1);
      updates[0].payload.op.should.equal('update');
      updates[0].payload.changes.length.should.equal(1);
      updates[0].payload.changes[0].name.should.equal('apple pie');
    });
  });

  // WC-STEP-PATCH release 2 (write-contract Q-A): a dbRemove by an identifier
  // that more than the step's resolve cap of records share cannot be named
  // (WriteResult.removed is null), so the handler reloads the collection's
  // cache, as a delete by query always did, instead of naming nothing.
  describe('dbRemove by an identifier over the resolve cap', function () {
    it('removes every record that shares it and reloads the treatments cache', async function () {
      this.timeout(30000);
      var CAP = require('../lib/storage/write-intent').RESOLVE_CAP;
      var docs = [];
      for (var i = 0; i <= CAP; i += 1) docs.push(treatment(i, { identifier: ID, srvModified: 1557000000000 }));
      await col().insertMany(docs);
      // two recent records the identifier does not name, in the cache before
      var recent = [new Date(Date.now() - 3600000).toISOString(), new Date(Date.now() - 1800000).toISOString()];
      var kept = (await col().insertMany(recent.map(function (t) {
        return { eventType: 'Note', created_at: t, enteredBy: TAG + '-kept', srvModified: Date.now(), srvCreated: Date.now() };
      }))).insertedIds;
      var keptIds = Object.keys(kept).map(function (k) { return String(kept[k]); });
      function cachedKept () {
        return self.ctx.cache.getData('treatments').filter(function (d) { return keptIds.indexOf(String(d._id)) !== -1; }).length;
      }
      async function until (ok, ms) {
        var t0 = Date.now();
        while (!ok() && Date.now() - t0 < ms) await new Promise(function (r) { setTimeout(r, 50); });
        return ok();
      }
      try {
        self.ctx.bus.emit('data-received');
        (await until(function () { return cachedKept() === 2; }, 8000)).should.equal(true, 'the recent records are cached before');
        var result = await send('dbRemove', { collection: 'treatments', identifier: ID });
        result.reply.should.eql({ result: 'success' });
        (await col().countDocuments({ identifier: ID })).should.equal(0);
        var removes = result.events.filter(function (e) { return e.event === 'data-update' && e.payload.op === 'remove'; });
        removes.should.eql([{ event: 'data-update', payload: { type: 'treatments', op: 'remove', count: CAP + 1, changes: null } }]);
        // the reload is asked for after the invalidate, so the cache (and the
        // IOB and COB computed from it) is refilled, not left blank
        var invalidated = result.events.findIndex(function (e) { return e.event === 'data-update' && e.payload.op === 'remove'; });
        var reload = result.events.findIndex(function (e) { return e.event === 'data-received'; });
        reload.should.be.above(invalidated, 'data-received after the invalidate');
        (await until(function () { return cachedKept() === 2; }, 8000)).should.equal(true, 'the cache holds the records again after the reload');
      } finally {
        await col().deleteMany({ enteredBy: TAG + '-kept' });
      }
    });
  });
});
