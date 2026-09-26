'use strict';

// A numeric `date` or `sgv` filter on /api/v1/activity, and a numeric `sgv`
// filter on /api/v1/devicestatus, match the records stored with those numbers
// (BF-106).
//
// Every query-string value arrives as text. A storage module that sets no
// `walker` has always had `date` and `sgv` read as numbers by query.js. The
// schema-driven coercion (BF-03) names a collection on each storage and types
// fields from its schema; the activity schema declares neither field and the
// devicestatus schema declares only `date`, so without the numeric default the
// bound stays a string, matches no stored number, and the request answers 200
// with no records.
//
// The other half of BF-03 must still hold: a field typed as text is not turned
// into a number, and profile, which never had the default, still does not.
//
// Records are seeded straight into the collections with a marker field, so
// each test sees only its own documents. Synthetic values only.

var request = require('supertest');
require('should');
var language = require('../lib/language')();

describe('numeric date and sgv filters on activity and devicestatus (BF-106)', function () {
  this.timeout(15000);
  var self = this;
  var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
  var api = require('../lib/api/');

  var MARK = 'bf106-date-coercion-test';
  var NOW = Date.now();
  var MINUTE = 60 * 1000;
  // Five records one minute apart, the newest one minute ago.
  var DATES = [5, 4, 3, 2, 1].map(function (m) { return NOW - m * MINUTE; });
  var SGVS = [80, 100, 120, 140, 160];

  function collection (name) {
    return self.ctx.store.collection(self.env[name + '_collection']);
  }

  function dropAll () {
    return Promise.all([
      collection('activity').deleteMany({ activitylevel: MARK })
      , collection('devicestatus').deleteMany({ device: { $in: [MARK, '12345'] } })
      , collection('profile').deleteMany({ defaultProfile: MARK })
    ]);
  }

  function seed () {
    var created = new Date(NOW).toISOString();
    var activity = DATES.map(function (date, i) {
      return { created_at: created, date: date, sgv: SGVS[i], steps: 10 * i, activitylevel: MARK };
    });
    var devicestatus = DATES.map(function (date, i) {
      return { created_at: created, date: date, sgv: SGVS[i], device: MARK };
    });
    // A device name made of digits, to show a text field stays text.
    devicestatus.push({ created_at: created, date: NOW, device: '12345' });
    // profile has never had `date` read as a number; one stored as text is
    // still found by the same text.
    var profile = { startDate: created, date: '20210304', defaultProfile: MARK, store: { } };
    return Promise.all([
      collection('activity').insertMany(activity)
      , collection('devicestatus').insertMany(devicestatus)
      , collection('profile').insertOne(profile)
    ]);
  }

  function get (path, query) {
    return request(self.app)
      .get(path)
      .query(query)
      .set('api-secret', known)
      .expect(200);
  }

  function activity (query) {
    return get('/api/activity', Object.assign({ 'find[activitylevel]': MARK }, query));
  }

  function devicestatus (query) {
    return get('/api/devicestatus/', Object.assign({ 'find[device]': MARK, count: 100 }, query));
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
      self.app.use('/api', api(self.env, ctx));
      dropAll().then(seed).then(function () { done(); }, done);
    });
  });

  after(function () {
    return dropAll();
  });

  describe('activity', function () {

    it('finds all seeded records by created_at (control: the records are there)', async function () {
      var res = await activity({ 'find[created_at][$gte]': new Date(NOW - MINUTE).toISOString() });
      res.body.length.should.equal(5);
    });

    it('finds records by a numeric date lower bound', async function () {
      var res = await activity({ 'find[date][$gte]': String(DATES[0]) });
      res.body.length.should.equal(5, 'records matched by find[date][$gte]');
    });

    it('splits the records by a numeric date window', async function () {
      var res = await activity({ 'find[date][$gt]': String(DATES[1]), 'find[date][$lte]': String(DATES[3]) });
      res.body.map(function (r) { return r.date; }).sort().should.eql([DATES[2], DATES[3]]);
    });

    it('finds a record by an exact numeric date', async function () {
      var res = await activity({ 'find[date]': String(DATES[2]) });
      res.body.length.should.equal(1);
      res.body[0].date.should.equal(DATES[2]);
    });

    it('finds records by a numeric sgv bound', async function () {
      var res = await activity({ 'find[sgv][$gte]': '120' });
      res.body.map(function (r) { return r.sgv; }).sort().should.eql([120, 140, 160]);
    });
  });

  describe('devicestatus', function () {

    it('finds records by a numeric sgv bound', async function () {
      var res = await devicestatus({ 'find[sgv][$gte]': '120' });
      res.body.map(function (r) { return r.sgv; }).sort().should.eql([120, 140, 160]);
    });

    it('still finds records by a numeric date bound (typed by the schema)', async function () {
      var res = await devicestatus({ 'find[date][$gte]': String(DATES[3]) });
      res.body.length.should.equal(2);
    });

    it('keeps a text field as text: a digits-only device name is matched as a string', async function () {
      var res = await get('/api/devicestatus/', { 'find[device]': '12345' });
      res.body.length.should.equal(1);
      res.body[0].device.should.equal('12345');
    });

    it('DELETE by a numeric sgv bound removes the matching records only', async function () {
      await request(self.app)
        .delete('/api/devicestatus/')
        .query({ 'find[device]': MARK, 'find[sgv][$gte]': '140' })
        .set('api-secret', known)
        .expect(200);
      var left = await collection('devicestatus').find({ device: MARK }).toArray();
      left.map(function (r) { return r.sgv; }).sort().should.eql([100, 120, 80]);
    });
  });

  describe('profile', function () {

    it('still compares a date filter as text, as it always has', async function () {
      var res = await get('/api/profiles/', { 'find[defaultProfile]': MARK, 'find[date]': '20210304' });
      res.body.length.should.equal(1, 'profiles matched by find[date]=20210304');
      res.body[0].date.should.equal('20210304');
    });
  });
});
