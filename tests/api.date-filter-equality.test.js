'use strict';

// BF-224: a plain value under the date field, with no operator
// (find[created_at]=<date>), means equality. It answers exactly what the
// $eq form answers, for GET and for DELETE. It used to answer 500 and do
// nothing, because the date normalizer expected an operator object.

var request = require('supertest');
require('should');
var language = require('../lib/language')();

describe('API v1 date filter with a plain value (BF-224)', function () {
  this.timeout(15000);
  var self = this;
  var hash = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';

  // Older than the default window (four days), so a plain value that was not
  // counted as a date filter would be replaced by that window and miss T.
  var T = '2020-01-15T12:00:00.000Z';
  var OTHERS = ['2020-01-15T11:00:00.000Z', '2020-01-15T13:00:00.000Z'];

  var PLAIN = [
    ['with milliseconds', T],
    ['without milliseconds', '2020-01-15T12:00:00Z'],
    ['with a +00:00 offset', '2020-01-15T12:00:00.000+00:00']
  ];

  before(function (done) {
    process.env.API_SECRET = 'this is my long pass phrase';
    self.env = require('../lib/server/env')();
    self.env.settings.authDefaultRoles = 'readable';
    self.env.settings.enable = ['careportal', 'api'];
    self.app = require('express')();
    require('../lib/middleware/configure-request')(self.app);
    self.app.enable('api');
    require('../lib/server/bootevent')(self.env, language).boot(function booted (ctx) {
      self.ctx = ctx;
      self.ctx.ddata = require('../lib/data/ddata')();
      self.app.use('/api', require('../lib/api/')(self.env, ctx));
      done();
    });
  });

  function collection (name) {
    return self.ctx.store.collection(name);
  }

  function filter (value, op) {
    return 'find[created_at]' + (op ? '[' + op + ']' : '') + '=' + encodeURIComponent(value);
  }

  async function storedDates (name) {
    var docs = await collection(name).find({}).toArray();
    return docs.map(function (d) { return d.created_at; }).sort();
  }

  // The three old records, plus one made now, which the default window holds.
  async function seed (path, name, body) {
    await collection(name).deleteMany({});
    var all = [T].concat(OTHERS, [new Date().toISOString()]);
    for (var i = 0; i < all.length; i++) {
      await request(self.app).post('/api/' + path + '/').set('api-secret', hash)
        .send(Object.assign({ created_at: all[i] }, body)).expect(200);
    }
    return storedDates(name);
  }

  async function get (path, qs) {
    var res = await request(self.app).get('/api/' + path + '/?' + qs).set('api-secret', hash);
    res.status.should.equal(200, res.text);
    return res.body.map(function (d) { return d.created_at; }).sort();
  }

  async function remove (path, name, body, qs) {
    var before = await seed(path, name, body);
    var res = await request(self.app).delete('/api/' + path + '/?' + qs).set('api-secret', hash);
    res.status.should.equal(200, res.text);
    var after = await storedDates(name);
    return before.filter(function (d) { return after.indexOf(d) < 0; });
  }

  describe('treatments', function () {
    var NOTE = { eventType: 'Note', notes: 'BF-224' };

    PLAIN.forEach(function (c) {
      it('GET with a plain value ' + c[0] + ' returns what $eq returns', async function () {
        await seed('treatments', 'treatments', NOTE);
        var eq = await get('treatments', filter(T, '$eq'));
        eq.should.eql([T]);
        (await get('treatments', filter(c[1]))).should.eql(eq);
      });

      it('DELETE with a plain value ' + c[0] + ' removes what $eq removes', async function () {
        var eq = await remove('treatments', 'treatments', NOTE, filter(T, '$eq'));
        eq.should.eql([T]);
        (await remove('treatments', 'treatments', NOTE, filter(c[1]))).should.eql(eq);
      });
    });

    it('GET with $gte is unchanged', async function () {
      await seed('treatments', 'treatments', NOTE);
      var all = await storedDates('treatments');
      (await get('treatments', filter(T, '$gte'))).should.eql(all.filter(function (d) { return d >= T; }));
    });

    it('GET with an $in list is unchanged', async function () {
      await seed('treatments', 'treatments', NOTE);
      var qs = 'find[created_at][$in][]=' + encodeURIComponent('2020-01-15T11:00:00Z') +
        '&find[created_at][$in][]=' + encodeURIComponent('2020-01-15T13:00:00.000+00:00');
      (await get('treatments', qs)).should.eql(OTHERS);
    });
  });

  describe('devicestatus', function () {
    var STATUS = { device: 'bf224-probe' };

    it('GET and DELETE with a plain created_at answer what $eq answers', async function () {
      await seed('devicestatus', 'devicestatus', STATUS);
      var eq = await get('devicestatus', filter(T, '$eq'));
      eq.should.eql([T]);
      (await get('devicestatus', filter('2020-01-15T12:00:00Z'))).should.eql(eq);
      (await remove('devicestatus', 'devicestatus', STATUS, filter('2020-01-15T12:00:00Z'))).should.eql([T]);
    });
  });
});
