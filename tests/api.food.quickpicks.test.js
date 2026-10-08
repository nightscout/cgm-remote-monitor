'use strict';

/*
 * GET /api/v1/food/quickpicks, against a live database.
 *
 * `hidden` and `position` have no settled type on disk. The built-in food
 * editor posts with `$.ajax({data: foodrec})` and no `contentType`, so jQuery
 * form-encodes and every leaf arrives as a STRING; a client that sends
 * application/json stores a real boolean and a real number. Both spellings
 * are already on disk wherever a non-jQuery client has ever written.
 *
 * The endpoint used to ask `{ hidden: 'false' }` - the string only - which
 * hid every quick pick a JSON client had written and every record saved
 * before the field existed, and it sorted `{position: 1}` in the query,
 * which orders '10' between '1' and '2' when the value is a string.
 */

var request = require('supertest');
var should = require('should');
var language = require('../lib/language')();

describe('Food quickpicks API', function ( ) {
  this.timeout(10000);
  var self = this;
  var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';

  var api = require('../lib/api/');

  before(function (done) {
    process.env.API_SECRET = 'this is my long pass phrase';
    self.env = require('../lib/server/env')();
    self.env.settings.authDefaultRoles = 'readable';
    self.env.settings.enable = ['careportal', 'api'];
    this.wares = require('../lib/middleware/')(self.env);
    self.app = require('express')();
    self.app.enable('api');
    require('../lib/server/bootevent')(self.env, language).boot(function booted(ctx) {
      self.ctx = ctx;
      self.ctx.ddata = require('../lib/data/ddata')();
      self.app.use('/api', api(self.env, ctx));
      done();
    });
  });

  // Every document this suite writes carries the same marker, so it can clean
  // up after itself without touching anything else in the collection.
  var MARKER = 'quickpick-suite-' + Date.now();
  var written = [];

  function writeJSON (doc) {
    doc.notes = MARKER;
    return request(self.app)
      .post('/api/food/')
      .set('api-secret', known)
      .set('Content-Type', 'application/json')
      .send(doc)
      .expect(200)
      .then(function (res) { written.push(res.body[0]._id); return res.body[0]; });
  }

  function writeFormEncoded (pairs) {
    return request(self.app)
      .post('/api/food/')
      .set('api-secret', known)
      .send(pairs + '&notes=' + MARKER)
      .expect(200)
      .then(function (res) { written.push(res.body[0]._id); return res.body[0]; });
  }

  function mine (body) {
    return body.filter(function (r) { return r.notes === MARKER; });
  }

  after(function ( ) {
    return Promise.all(written.map(function (id) {
      return request(self.app).delete('/api/food/' + id).set('api-secret', known);
    }));
  });

  it('stores what the transport gives it — the premise of this entry', function ( ) {
    // Not an assertion about the fix; an assertion about WHY the fix is
    // needed. If this ever stops holding, the filter below can be simplified.
    return writeFormEncoded('type=quickpick&name=FormEncoded&carbs=5&hidden=false&position=1')
      .then(function ( ) {
        return writeJSON({ type: 'quickpick', name: 'JsonWritten', carbs: 5, hidden: false, position: 2 });
      })
      .then(function ( ) {
        return request(self.app).get('/api/food/').set('api-secret', known).expect(200);
      })
      .then(function (res) {
        var byName = { };
        mine(res.body).forEach(function (r) { byName[r.name] = r; });
        byName.FormEncoded.hidden.should.equal('false');
        byName.FormEncoded.position.should.equal('1');
        byName.JsonWritten.hidden.should.equal(false);
        byName.JsonWritten.position.should.equal(2);
      });
  });

  it('returns quick picks hidden in neither spelling, including those with no flag', function ( ) {
    return writeJSON({ type: 'quickpick', name: 'BooleanHidden', carbs: 5, hidden: true, position: 3 })
      .then(function ( ) {
        return writeFormEncoded('type=quickpick&name=StringHidden&carbs=5&hidden=true&position=4');
      })
      .then(function ( ) {
        return writeJSON({ type: 'quickpick', name: 'NoFlag', carbs: 5, position: 5 });
      })
      .then(function ( ) {
        return writeJSON({ type: 'food', name: 'PlainFood', carbs: 5, position: 6 });
      })
      .then(function ( ) {
        return request(self.app).get('/api/food/quickpicks').set('api-secret', known).expect(200);
      })
      .then(function (res) {
        var names = mine(res.body).map(function (r) { return r.name; });
        names.should.containEql('FormEncoded');
        names.should.containEql('JsonWritten');
        names.should.containEql('NoFlag');
        names.should.not.containEql('BooleanHidden');
        names.should.not.containEql('StringHidden');
        names.should.not.containEql('PlainFood');
      });
  });

  it('orders by position numerically, not lexicographically', function ( ) {
    // A string sort puts '10' between '1' and '2'. Write them out of order so
    // insertion order cannot be mistaken for the answer.
    return writeFormEncoded('type=quickpick&name=Pos10&carbs=5&hidden=false&position=10')
      .then(function ( ) {
        return writeFormEncoded('type=quickpick&name=Pos9&carbs=5&hidden=false&position=9');
      })
      .then(function ( ) {
        return writeJSON({ type: 'quickpick', name: 'Pos11', carbs: 5, hidden: false, position: 11 });
      })
      .then(function ( ) {
        return request(self.app).get('/api/food/quickpicks').set('api-secret', known).expect(200);
      })
      .then(function (res) {
        var positions = mine(res.body).map(function (r) { return parseInt(r.position, 10); });
        var sorted = positions.slice().sort(function (a, b) { return a - b; });
        positions.should.eql(sorted, 'returned order: ' + JSON.stringify(positions));
        // and the specific inversion the string sort produces
        positions.indexOf(10).should.be.above(positions.indexOf(9));
      });
  });
});
