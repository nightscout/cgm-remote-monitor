
var request = require('supertest');
var should = require('should');

describe('Status REST api', function ( ) {
  var api = require('../lib/api/');
  before(function (done) {
    var env = require('../env')( );
    env.enable = "careportal rawbg";
    env.api_secret = 'this is my long pass phrase';
    this.wares = require('../lib/middleware/')(env);
    var store = require('../lib/storage')(env);
    this.app = require('express')( );
    this.app.enable('api');
    var self = this;
    store(function ( ) {
      var entriesStorage = require('../lib/entries').storage(env.mongo_collection, store);
      self.app.use('/api', api(env, entriesStorage));
      done();
    });
  });

  it('should be a module', function ( ) {
    api.should.be.ok;
  });

  it('/status.json', function (done) {
    request(this.app)
      .get('/api/status.json')
      .expect(200)
      .end(function (err, res)  {
        res.body.apiEnabled.should.equal(true);
        res.body.careportalEnabled.should.equal(true);
        res.body.enabledOptions.should.equal('careportal rawbg');
        done( );
      });
  });


});

