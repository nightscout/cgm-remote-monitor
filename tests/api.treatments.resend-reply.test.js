'use strict';

// A treatment re-sent without `_id` and matched by its fallback key (created_at
// + eventType, with the client's identity or the amounts) is answered with the
// `_id` it is stored under (BF-165).
//
// The reply to a write that matched by `identifier` already carried the
// stored `_id`, and so did an insert. A write matched by the fallback key was
// answered with the document as sent, without `_id`, and its data-update
// event lacked it too. Loop's NightscoutKit keeps the reply's `_id` to edit or
// delete the record later, and records a missing one as "NA".
//
// Synthetic values only; every record is dated in March 2019.

var request = require('supertest');
require('should');
var language = require('../lib/language')();

describe('A treatment re-sent without _id is answered with its stored _id (BF-165)', function () {
  this.timeout(15000);
  var self = this;
  var hash = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
  var FROM = '2019-03-01T00:00:00.000Z';
  var TO = '2019-04-01T00:00:00.000Z';
  var minute = 0;

  function col () {
    return self.ctx.store.collection(self.env.treatments_collection);
  }

  function nextTime () {
    minute += 1;
    return new Date(Date.UTC(2019, 2, 10, 7, minute)).toISOString();
  }

  function post (body) {
    return request(self.app).post('/api/treatments/').set('api-secret', hash).send(body).expect(200);
  }

  function put (body) {
    return request(self.app).put('/api/treatments/').set('api-secret', hash).send(body).expect(200);
  }

  function loopCarb (at, carbs) {
    return { eventType: 'Carb Correction', created_at: at, carbs: carbs, absorptionTime: 180
      , enteredBy: 'loop://iPhone', syncIdentifier: 'resend-reply-' + at };
  }

  function careportal (at, carbs) {
    return { eventType: 'Meal Bolus', created_at: at, carbs: carbs, enteredBy: 'careportal' };
  }

  async function storedIds (at) {
    return (await col().find({ created_at: at }).toArray()).map(function (doc) { return String(doc._id); });
  }

  // The data-update events emitted while fn runs.
  async function updates (fn) {
    var seen = [];
    function listener (ev) {
      if (ev && ev.type === 'treatments' && ev.op === 'update') seen.push(ev);
    }
    self.ctx.bus.on('data-update', listener);
    try {
      await fn();
    } finally {
      self.ctx.bus.removeListener('data-update', listener);
    }
    return seen;
  }

  before(function (done) {
    process.env.API_SECRET = 'this is my long pass phrase';
    self.env = require('../lib/server/env')();
    self.env.settings.authDefaultRoles = 'readable';
    self.env.settings.enable = ['careportal', 'api'];
    self.app = require('express')();
    self.app.enable('api');
    require('../lib/server/bootevent')(self.env, language).boot(function booted (ctx) {
      self.ctx = ctx;
      self.ctx.ddata = require('../lib/data/ddata')();
      self.app.use('/api', require('../lib/api/')(self.env, ctx));
      done();
    });
  });

  after(function () {
    return col().deleteMany({ created_at: { $gte: FROM, $lt: TO } });
  });

  [
    { label: 'a Loop carb entry (syncIdentifier)', make: loopCarb }
    , { label: 'a careportal entry (no client identity)', make: careportal }
  ].forEach(function (shape) {
    [false, true].forEach(function (batch) {
      var how = batch ? 'in an array' : 'as one object';

      it(shape.label + ' re-sent ' + how + ' is answered with the stored _id', async function () {
        var at = nextTime();
        var first = await post(batch ? [shape.make(at, 20)] : shape.make(at, 20));
        var id = String(first.body[0]._id);
        id.should.match(/^[0-9a-f]{24}$/);

        var again = await post(batch ? [shape.make(at, 20)] : shape.make(at, 20));
        again.body.should.have.length(1);
        again.body[0].should.have.property('_id');
        String(again.body[0]._id).should.equal(id);
        (await storedIds(at)).should.eql([id]);
      });
    });
  });

  it('each item of a batch that re-sends one record and adds another gets its own _id', async function () {
    var at = nextTime();
    var later = nextTime();
    var first = await post([careportal(at, 15)]);
    var id = String(first.body[0]._id);

    var res = await post([careportal(at, 15), careportal(later, 25)]);
    res.body.should.have.length(2);
    String(res.body[0]._id).should.equal(id);
    String(res.body[1]._id).should.match(/^[0-9a-f]{24}$/);
    String(res.body[1]._id).should.not.equal(id);
    (await storedIds(later)).should.eql([String(res.body[1]._id)]);
  });

  it('the data-update event of a re-send carries the stored _id', async function () {
    var at = nextTime();
    var first = await post([loopCarb(at, 30)]);
    var id = String(first.body[0]._id);

    var events = await updates(function () { return post([loopCarb(at, 30)]); });
    events.should.have.length(1);
    events[0].changes.should.have.length(1);
    String(events[0].changes[0]._id).should.equal(id);
  });

  it('an in-process re-send answers its callback with the stored _id', async function () {
    var at = nextTime();
    var first = await post([careportal(at, 12)]);
    var id = String(first.body[0]._id);

    var created = await new Promise(function (resolve, reject) {
      self.ctx.treatments.create(careportal(at, 12), function (err, docs) {
        if (err) return reject(err);
        resolve(docs);
      });
    });
    String(created[0]._id).should.equal(id);
  });

  it('a PUT without _id that matches by time and amounts is answered with the stored _id', async function () {
    var at = nextTime();
    var first = await post([careportal(at, 18)]);
    var id = String(first.body[0]._id);

    var res = await put(Object.assign(careportal(at, 18), { notes: 'edited' }));
    String(res.body._id).should.equal(id);
    (await storedIds(at)).should.eql([id]);
  });
});
