'use strict';

var request = require('supertest');
var load = require('./fixtures/load');
var bootevent = require('../lib/server/bootevent');
var language = require('../lib/language')();
const _ = require('lodash');

require('should');

const FIVE_MINUTES=1000*60*5;
 
describe('Entries REST api', function ( ) {
  var entries = require('../lib/api/entries/');
  var self = this;
  var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';

  this.timeout(10000);
  before(function (done) {
    delete process.env.API_SECRET;
    process.env.API_SECRET = 'this is my long pass phrase';
    self.env = require('../lib/server/env')( );
    self.env.settings.authDefaultRoles = 'readable';
    self.wares = require('../lib/middleware/')(self.env);
    self.archive = null;
    self.app = require('express')( );
    self.app.enable('api');
    bootevent(self.env, language).boot(function booted (ctx) {
      self.app.use('/', entries(self.app, self.wares, ctx, self.env));
      self.archive = require('../lib/server/entries')(self.env, ctx);
      self.ctx = ctx;
      done();
    });
  });

  beforeEach(function (done) {
    var creating = load('json');

    for (let i = 0; i < 20; i++) {
      const e = {type: 'sgv', sgv: 100, date: Date.now()};
      e.date = e.date - FIVE_MINUTES * i;
      creating.push(e);
    }

    creating = _.sortBy(creating, function(item) {
      return item.date;
    });

    function setupDone() {
      console.log('Setup complete');
      done();
    }

    function waitForASecond() {
      // wait for event processing of cache entries to actually finish
      setTimeout(function() {
        setupDone();
       }, 100);
    }

    self.archive.create(creating, waitForASecond);

  });

  afterEach(function (done) {
    self.archive( ).deleteMany({ }, done);
  });

  after(function (done) {
    self.archive( ).deleteMany({ }, done);
  });

  // keep this test pinned at or near the top in order to validate all
  // entries successfully uploaded. if res.body.length is short of the
  // expected value, it may indicate a regression in the create
  // function callback logic in entries.js.
  it('gets requested number of entries', function (done) {
    var count = 30;
    request(self.app)
      .get('/entries.json?find[dateString][$gte]=2014-07-19&count=' + count)
      .expect(200)
      .end(function (err, res) {
        res.body.should.be.instanceof(Array).and.have.lengthOf(count);
        done();
      });
  });

  it('gets default number of entries', function (done) {
    var defaultCount = 10;
    request(self.app)
      .get('/entries/sgv.json?find[dateString][$gte]=2014-07-19&find[dateString][$lte]=2014-07-20')
      .expect(200)
      .end(function (err, res) {
        res.body.should.be.instanceof(Array).and.have.lengthOf(defaultCount);
        done( );
      });
  });

  it('gets entries in right order', function (done) {
    var defaultCount = 10;
    request(self.app)
      .get('/entries/sgv.json?find[dateString][$gte]=2014-07-19&find[dateString][$lte]=2014-07-20')
      .expect(200)
      .end(function (err, res) {
        res.body.should.be.instanceof(Array).and.have.lengthOf(defaultCount);
        
        var array = res.body;
        var firstEntry = array[0];
        var secondEntry = array[1];
        
        firstEntry.date.should.be.above(secondEntry.date);
        
        done( );
      });
  });

  it('gets entries in right order without type specifier', function (done) {
    var defaultCount = 10;
    request(self.app)
      .get('/entries.json')
      .expect(200)
      .end(function (err, res) {
        res.body.should.be.instanceof(Array).and.have.lengthOf(defaultCount);
        
        var array = res.body;
        var firstEntry = array[0];
        var secondEntry = array[1];
        
        firstEntry.date.should.be.above(secondEntry.date);
        
        done( );
      });
  });

  it('/echo/ api shows query', function (done) {
    request(self.app)
      .get('/echo/entries/sgv.json?find[dateString][$gte]=2014-07-19&find[dateString][$lte]=2014-07-20')
      .expect(200)
      .end(function (err, res) {
        res.body.should.be.instanceof(Object);
        res.body.query.should.be.instanceof(Object);
        res.body.input.should.be.instanceof(Object);
        res.body.input.find.should.be.instanceof(Object);
        res.body.storage.should.equal('entries');
        done( );
      });
  });

  it('/slice/ can slice time', function (done) {
    var app = self.app;
    request(app)
      .get('/slice/entries/dateString/sgv/2014-07.json?count=20')
      .expect(200)
      .end(function (err, res) {
        res.body.should.be.instanceof(Array).and.have.lengthOf(20);
        done( );
      });
  });


  it('/times/echo can describe query', function (done) {
    var app = self.app;
    request(app)
      .get('/times/echo/2014-07/.*T{00..05}:.json?count=20&find[sgv][$gte]=160')
      .expect(200)
      .end(function (err, res) {
        res.body.should.be.instanceof(Object);
        res.body.req.should.have.property('query');
        res.body.should.have.property('pattern').with.lengthOf(6);
        done( );
      });
  });

  it('/slice/ can slice with multiple prefix', function (done) {
    var app = self.app;
    request(app)
      .get('/slice/entries/dateString/sgv/2014-07-{17..20}.json?count=20')
      .expect(200)
      .end(function (err, res) {
        res.body.should.be.instanceof(Array).and.have.lengthOf(20);
        done( );
      });
  });

  it('/slice/ can slice time with prefix and no results', function (done) {
    var app = self.app;
    request(app)
      .get('/slice/entries/dateString/sgv/1999-07.json?count=20&find[sgv][$lte]=401')
      .expect(200)
      .end(function (err, res) {
        res.body.should.be.instanceof(Array).and.have.lengthOf(0);
        done( );
      });
  });

  it('/times/ can get modal times', function (done) {
    var app = self.app;
    request(app)
      .get('/times/2014-07-/{0..30}T.json?')
      .expect(200)
      .end(function (err, res) {
        res.body.should.be.instanceof(Array).and.have.lengthOf(10);
        done( );
      });
  });

  it('/times/ can get modal minutes and times', function (done) {
    var app = self.app;
    request(app)
      .get('/times/20{14..15}-07/T{09..10}.json?')
      .expect(200)
      .end(function (err, res) {
        res.body.should.be.instanceof(Array).and.have.lengthOf(10);
        done( );
      });
  });
  it('/times/ can get multiple prefixen and modal minutes and times', function (done) {
    var app = self.app;
    request(app)
      .get('/times/20{14..15}/T.*:{00..60}.json?')
      .expect(200)
      .end(function (err, res) {
        res.body.should.be.instanceof(Array).and.have.lengthOf(10);
        done( );
      });
  });

  it('/entries/current.json', function (done) {
    request(self.app)
      .get('/entries/current.json')
      .expect(200)
      .end(function (err, res) {
        res.body.should.be.instanceof(Array).and.have.lengthOf(1);
        res.body[0].sgv.should.equal(100);
        done();
      });
  });

  it('/entries/:id', function (done) {
    var app = self.app;
    self.archive.list({count: 10}, function(err, records) {
      var currentId = records.pop()._id.toString();
      request(app)
        .get('/entries/'+currentId+'.json')
        .expect(200)
        .end(function (err, res) {
          res.body.should.be.instanceof(Array).and.have.lengthOf(1);
          res.body[0]._id.should.equal(currentId);
          done( );
        });
      });
    });

  it('/entries/:model', function (done) {
    var app = self.app;
    request(app)
      .get('/entries/sgv/.json?count=10&find[dateString][$gte]=2014')
      .expect(200)
      .end(function (err, res) {
        res.body.should.be.instanceof(Array).and.have.lengthOf(10);
        done( );
      });
  });

  it('disallow POST by readable /entries/preview', function (done) {
    request(self.app)
      .post('/entries/preview.json')
      .send(load('json'))
      .expect(401)
      .end(function (err, res) {
        // res.body.should.be.instanceof(Array).and.have.lengthOf(30);
        done();
      });
  });

  it('disallow deletes unauthorized', function (done) {
    var app = self.app;

    request(app)
      .delete('/entries/sgv?find[dateString][$gte]=2014-07-19&find[dateString][$lte]=2014-07-20')
      .expect(401)
      .end(function (err) {
        if (err) {
          done(err);
        } else {
          request(app)
            .get('/entries/sgv.json?find[dateString][$gte]=2014-07-19&find[dateString][$lte]=2014-07-20')
            .expect(200)
            .end(function (err, res) {
              res.body.should.be.instanceof(Array).and.have.lengthOf(10);
              done();
            });
        }
      });
  });

  it('post an entry, query, delete, verify gone', function (done) {
    // insert a glucose entry - needs to be unique from example data
    console.log('Inserting glucose entry')
    request(self.app)
      .post('/entries/')
      .set('api-secret', known || '')
      .send({
        "type": "sgv", "sgv": "199", "dateString": "2014-07-20T00:44:15.000-07:00"
        , "date": 1405791855000, "device": "dexcom", "direction": "NOT COMPUTABLE"
      })
      .expect(200)
      .end(function (err) {
        if (err) {
          done(err);
        } else {
          // make sure treatment was inserted successfully
          console.log('Ensuring glucose entry was inserted successfully');
          request(self.app)
            .get('/entries.json?find[dateString][$gte]=2014-07-20&count=100')
            .set('api-secret', known || '')
            .expect(200)
            .expect(function (response) {
              var entry = response.body[0];
              entry.sgv.should.equal('199');
              entry.utcOffset.should.equal(-420);
            })
            .end(function (err) {
              if (err) {
                done(err);
              } else {
                // delete the glucose entry
                console.log('Deleting test glucose entry');
                request(self.app)
                  .delete('/entries.json?find[dateString][$gte]=2014-07-20&count=100')
                  .set('api-secret', known || '')
                  .expect(200)
                  .end(function (err) {
                    if (err) {
                      done(err);
                    } else {
                      // make sure it was deleted
                      console.log('Testing if glucose entry was deleted');
                      request(self.app)
                        .get('/entries.json?find[dateString][$gte]=2014-07-20&count=100')
                        .set('api-secret', known || '')
                        .expect(200)
                        .expect(function (response) {
                          response.body.length.should.equal(0);
                        })
                        .end(done);
                    }
                  });
              }
            });
        }
      });
  });

  it('post multiple entries, query, delete, verify gone', function (done) {
    // insert a glucose entry - needs to be unique from example data
    console.log('Inserting glucose entry')
    request(self.app)
      .post('/entries/')
      .set('api-secret', known || '')
      .send([{
        "type": "sgv", "sgv": "199", "dateString": "2014-07-20T00:44:15.000-07:00"
        , "date": 1405791855000, "device": "dexcom", "direction": "NOT COMPUTABLE"
      }, {
        "type": "sgv", "sgv": "200", "dateString": "2014-07-20T00:44:15.001-07:00"
        , "date": 1405791855001, "device": "dexcom", "direction": "NOT COMPUTABLE"
      }])
      .expect(200)
      .end(function (err) {
        if (err) {
          done(err);
        } else {
          // make sure treatment was inserted successfully
          console.log('Ensuring glucose entry was inserted successfully');
          request(self.app)
            .get('/entries.json?find[dateString][$gte]=2014-07-20&count=100')
            .set('api-secret', known || '')
            .expect(200)
            .expect(function (response) {
              var entry = response.body[0];
              response.body.length.should.equal(2);
              entry.sgv.should.equal('200');
              entry.utcOffset.should.equal(-420);
            })
            .end(function (err) {
              if (err) {
                done(err);
              } else {
                // delete the glucose entry
                console.log('Deleting test glucose entry');
                request(self.app)
                  .delete('/entries.json?find[dateString][$gte]=2014-07-20&count=100')
                  .set('api-secret', known || '')
                  .expect(200)
                  .end(function (err) {
                    if (err) {
                      done(err);
                    } else {
                      // make sure it was deleted
                      console.log('Testing if glucose entries were deleted');
                      request(self.app)
                        .get('/entries.json?find[dateString][$gte]=2014-07-20&count=100')
                        .set('api-secret', known || '')
                        .expect(200)
                        .expect(function (response) {
                          response.body.length.should.equal(0);
                        })
                        .end(done);
                    }
                  });
              }
            });
        }
      });
  });

});
