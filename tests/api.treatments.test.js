'use strict';

var request = require('supertest');
var should = require('should');
var language = require('../lib/language')();
var _moment = require('moment');

describe('Treatment API', function ( ) {
  this.timeout(10000);
  var self = this;

  var api_secret_hash = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';

  var api = require('../lib/api/');
  
  // Use before() instead of beforeEach() for app setup - boots once for all tests
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

  after(function () {
    // delete process.env.API_SECRET;
  });

  it('post single treatments', function (done) {

    self.ctx.treatments.remove({ find: { created_at: { '$gte': '1999-01-01T00:00:00.000Z' } } }, function ( ) {
      var now = (new Date()).toISOString();
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash || '')
        .send({eventType: 'Meal Bolus', created_at: now, carbs: '30', insulin: '2.00', preBolus: '15', glucose: 100, glucoseType: 'Finger', units: 'mg/dl', notes: '<IMG SRC="javascript:alert(\'XSS\');">'})
        .expect(200)
        .end(function (err) {
          if (err) {
            done(err);
          } else {
            self.ctx.treatments.list({}, function (err, list) {
              var sorted = list.sort((a, b) => a.created_at.localeCompare(b.created_at));
              sorted.length.should.equal(2);
              sorted[0].glucose.should.equal(100);
              // Sanitizer behavior: the dangerous IMG payload sent in
              // `notes` must have its javascript: URL stripped while
              // preserving the (now harmless) <img> shell, matching the
              // previous DOMPurify-based behavior. The exact normalized
              // form is `<img />` (XHTML self-closing under sanitize-html);
              // DOMPurify produced `<img>`. We assert the normalized form
              // AND the security invariants (no javascript:, no alert,
              // no XSS, no surviving src attribute) so any future
              // sanitizer swap that still satisfies the invariants is
              // accepted. See tests/sanitizer-differential.test.js for
              // the cross-sanitizer behavior matrix.
              sorted[0].notes.should.equal('<img />');
              sorted[0].notes.should.not.match(/javascript:/i);
              sorted[0].notes.should.not.match(/alert/i);
              sorted[0].notes.should.not.match(/XSS/i);
              sorted[0].notes.should.not.match(/\bsrc\s*=/i);
              should.not.exist(sorted[0].eventTime);
              sorted[0].insulin.should.equal(2);
              sorted[1].carbs.should.equal(30);
              done();
            });
          }
        });

    });
  });

  /*
  it('saving entry without created_at should fail', function (done) {

    self.ctx.treatments().remove({ }, function ( ) {
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', self.env.api_secret || '')
        .send({eventType: 'Meal Bolus', carbs: '30', insulin: '2.00', preBolus: '15', glucose: 100, glucoseType: 'Finger', units: 'mg/dl'})
        .expect(422)
        .end(function (err) {
          if (err) {
            done(err);
          } else {
              done();
          }
        });
    });
  });
*/

  it('post single treatments in zoned time format', function (done) {

    var current_time = Date.now();
    console.log('Testing date with local format: ', _moment(current_time).format("YYYY-MM-DDTHH:mm:ss.SSSZZ"));

    self.ctx.treatments.remove({ find: { created_at: { '$gte': '1999-01-01T00:00:00.000Z' } } }, function ( ) {
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash || '')
        .send({eventType: 'Meal Bolus', created_at: _moment(current_time).format("YYYY-MM-DDTHH:mm:ss.SSSZZ"), carbs: '30', insulin: '2.00', glucose: 100, glucoseType: 'Finger', units: 'mg/dl'})
        .expect(200)
        .end(function (err) {
          if (err) {
            done(err);
          } else {
            self.ctx.treatments.list({}, function (err, list) {
              var sorted = list.sort((a, b) => a.created_at.localeCompare(b.created_at));
              console.log(sorted);
              sorted.length.should.equal(1);
              sorted[0].glucose.should.equal(100);
              should.not.exist(sorted[0].eventTime);
              sorted[0].insulin.should.equal(2);
              sorted[0].carbs.should.equal(30);
              var zonedTime = _moment(current_time).utc().format("YYYY-MM-DDTHH:mm:ss.SSS") + "Z";
              sorted[0].created_at.should.equal(zonedTime);
              sorted[0].utcOffset.should.equal(-1* new Date().getTimezoneOffset());
              done();
            });
          }
        });

    });
  });


  it('post a treatment array', function (done) {
    self.ctx.treatments.remove({ find: { created_at: { '$gte': '1999-01-01T00:00:00.000Z' } } }, function ( ) {
      var now = (new Date()).toISOString();
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash || '')
        .send([
          {eventType: 'BG Check', created_at: now, glucose: 100, preBolus: '0', glucoseType: 'Finger', units: 'mg/dl', notes: ''}
          , {eventType: 'Meal Bolus', created_at: now, carbs: '30', insulin: '2.00', preBolus: '15', glucose: 100, glucoseType: 'Finger', units: 'mg/dl'}
         ])
        .expect(200)
        .end(function (err) {
          if (err) {
            done(err);
          } else {
            self.ctx.treatments.list({}, function (err, list) {
              list.length.should.equal(3);
              should.not.exist(list[0].eventTime);
              should.not.exist(list[1].eventTime);

              done();
            });
          }
        });
    });
  });

  it('post a treatment array and dedupe', function (done) {
    self.ctx.treatments.remove({ find: { created_at: { '$gte': '1999-01-01T00:00:00.000Z' } } }, function ( ) {
      var now = (new Date()).toISOString();
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash || '')
        .send([
          {eventType: 'BG Check', glucose: 100, units: 'mg/dl', created_at: now}
          , {eventType: 'BG Check', glucose: 100, units: 'mg/dl', created_at: now}
          , {eventType: 'BG Check', glucose: 100, units: 'mg/dl', created_at: now}
          , {eventType: 'BG Check', glucose: 100, units: 'mg/dl', created_at: now}
          , {eventType: 'BG Check', glucose: 100, units: 'mg/dl', created_at: now}
          , {eventType: 'BG Check', glucose: 100, units: 'mg/dl', created_at: now}
          , {eventType: 'BG Check', glucose: 100, units: 'mg/dl', created_at: now}
          , {eventType: 'BG Check', glucose: 100, units: 'mg/dl', created_at: now}
          , {eventType: 'Meal Bolus', created_at: now, carbs: '30', insulin: '2.00', preBolus: '15', glucose: 100, glucoseType: 'Finger', units: 'mg/dl'}
        ])
        .expect(200)
        .end(function (err) {
          if (err) {
            done(err);
          } else {
            self.ctx.treatments.list({}, function (err, list) {
              var sorted = list.sort((a, b) => a.created_at.localeCompare(b.created_at));

              if (sorted.length !== 3) {
                console.info('unexpected result length, sorted treatments:', sorted);
              }
              sorted.length.should.equal(3);
              sorted[0].glucose.should.equal(100);

              done();
            });
          }
        });
    });
  });

  it('post a treatment, query, delete, verify gone', function (done) {
    // insert a treatment - needs to be unique from example data
    console.log('Inserting treatment entry');
    var now = (new Date()).toISOString();
    request(self.app)
      .post('/api/treatments/')
      .set('api-secret', api_secret_hash || '')
      .send({eventType: 'Meal Bolus', created_at: now, carbs: '99', insulin: '2.00', preBolus: '15', glucose: 100, glucoseType: 'Finger', units: 'mg/dl'})
      .expect(200)
      .end(function (err) {
        if (err) {
          done(err);
        } else {
          // make sure treatment was inserted successfully
          console.log('Ensuring treatment entry was inserted successfully');
          request(self.app)
            .get('/api/treatments/')
            .query('find[carbs]=99')
            .set('api-secret', api_secret_hash || '')
            .expect(200)
            .expect(function (response) {
              response.body[0].carbs.should.equal(99);
            })
            .end(function (err) {
              if (err) {
                done(err);
              } else {
                // delete the treatment
                console.log('Deleting test treatment entry');
                request(self.app)
                  .delete('/api/treatments/')
                  .query('find[carbs]=99')
                  .set('api-secret', api_secret_hash || '')
                  .expect(200)
                  .end(function (err) {
                    if (err) {
                      done(err);
                    } else {
                      // make sure it was deleted
                      console.log('Testing if entry was deleted');
                      request(self.app)
                        .get('/api/treatments/')
                        .query('find[carbs]=99')
                        .set('api-secret', api_secret_hash || '')
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

  it('supports UUID treatment ids for post, put, and delete', function (done) {
    var treatmentId = '69F15FD2-8075-4DEB-AEA3-4352F455840D';
    // Use recent dates to avoid default query time filter (4 days window)
    var now = new Date();
    var originalCreatedAt = new Date(now.getTime() - 3600000).toISOString();  // 1 hour ago
    var repostedCreatedAt = new Date(now.getTime() - 1800000).toISOString();  // 30 min ago
    var updatedCreatedAt = new Date(now.getTime() - 900000).toISOString();    // 15 min ago

    self.ctx.treatments.remove({ find: { created_at: { '$gte': '1999-01-01T00:00:00.000Z' } } }, function () {
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash || '')
        .send({
          _id: treatmentId,
          eventType: 'Temporary Override',
          created_at: originalCreatedAt,
          durationType: 'indefinite',
          correctionRange: [90, 110],
          insulinNeedsScaleFactor: 1.2,
          reason: 'test override'
        })
        .expect(200)
        .end(function (err, res) {
          if (err) {
            return done(err);
          }

          // REQ-SYNC-072: UUID _id is moved to identifier, _id is server-generated ObjectId
          var createdTreatment = res.body[0];
          createdTreatment.identifier.should.equal(treatmentId);
          createdTreatment._id.should.match(/^[0-9a-f]{24}$/);  // ObjectId format
          var serverId = createdTreatment._id;

          request(self.app)
            .post('/api/treatments/')
            .set('api-secret', api_secret_hash || '')
            .send({
              _id: treatmentId,
              eventType: 'Temporary Override',
              created_at: repostedCreatedAt,
              duration: 60,
              correctionRange: [90, 110],
              insulinNeedsScaleFactor: 1.2,
              reason: 'reposted override'
            })
            .expect(200)
            .end(function (err) {
              if (err) {
                return done(err);
              }

              // REQ-SYNC-072: Lookup by identifier
              self.ctx.treatments.list({ find: { identifier: treatmentId } }, function (err, list) {
                if (err) {
                  return done(err);
                }

                list.length.should.equal(1);
                list[0].identifier.should.equal(treatmentId);
                list[0].created_at.should.equal(repostedCreatedAt);
                list[0].duration.should.equal(60);
                should.not.exist(list[0].durationType);

                request(self.app)
                  .put('/api/treatments/')
                  .set('api-secret', api_secret_hash || '')
                  .send({
                    _id: treatmentId,
                    eventType: 'Temporary Override',
                    created_at: updatedCreatedAt,
                    duration: 30,
                    correctionRange: [90, 110],
                    insulinNeedsScaleFactor: 1.2,
                    reason: 'updated override'
                  })
                  .expect(200)
                  .end(function (err) {
                    if (err) {
                      return done(err);
                    }

                    self.ctx.treatments.list({ find: { identifier: treatmentId } }, function (err, updatedList) {
                      if (err) {
                        return done(err);
                      }

                      updatedList.length.should.equal(1);
                      updatedList[0].identifier.should.equal(treatmentId);
                      updatedList[0].created_at.should.equal(updatedCreatedAt);
                      updatedList[0].duration.should.equal(30);
                      updatedList[0].reason.should.equal('updated override');

                      // Delete by server-assigned _id (or could use identifier)
                      request(self.app)
                        .delete('/api/treatments/' + encodeURIComponent(serverId))
                        .set('api-secret', api_secret_hash || '')
                        .expect(200)
                        .end(function (err) {
                          if (err) {
                            return done(err);
                          }

                          self.ctx.treatments.list({ find: { identifier: treatmentId } }, function (err, deletedList) {
                            if (err) {
                              return done(err);
                            }

                            deletedList.length.should.equal(0);
                            done();
                          });
                        });
                    });
                  });
              });
            });
        });
    });
  });

  // ============================================================
  // REQ-SYNC-072: identifier-based CRUD (AAPS pattern)
  // AAPS sends explicit `identifier` field, not UUID as `_id`
  // ============================================================

  it('supports identifier field for AAPS-style treatments', function (done) {
    var identifier = 'AAPS-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    var now = new Date();
    var createdAt = new Date(now.getTime() - 3600000).toISOString();

    self.ctx.treatments.remove({ find: { created_at: { '$gte': '1999-01-01T00:00:00.000Z' } } }, function () {
      // POST with explicit identifier (AAPS pattern)
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash || '')
        .send({
          identifier: identifier,
          eventType: 'Bolus',
          insulin: 2.5,
          created_at: createdAt
        })
        .expect(200)
        .end(function (err, res) {
          if (err) {
            return done(err);
          }

          var createdTreatment = res.body[0];
          createdTreatment.identifier.should.equal(identifier);
          createdTreatment._id.should.match(/^[0-9a-f]{24}$/);  // Server-assigned ObjectId
          createdTreatment.insulin.should.equal(2.5);

          // Query by identifier
          self.ctx.treatments.list({ find: { identifier: identifier } }, function (err, list) {
            if (err) {
              return done(err);
            }

            list.length.should.equal(1);
            list[0].identifier.should.equal(identifier);
            done();
          });
        });
    });
  });

  it('deduplicates by identifier on re-upload', function (done) {
    var identifier = 'DEDUP-' + Date.now();
    var now = new Date();
    var createdAt = new Date(now.getTime() - 3600000).toISOString();

    self.ctx.treatments.remove({ find: { created_at: { '$gte': '1999-01-01T00:00:00.000Z' } } }, function () {
      // First POST
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash || '')
        .send({
          identifier: identifier,
          eventType: 'Carb Correction',
          carbs: 30,
          created_at: createdAt
        })
        .expect(200)
        .end(function (err, res) {
          if (err) {
            return done(err);
          }

          var firstId = res.body[0]._id;

          // Second POST with same identifier - should upsert
          request(self.app)
            .post('/api/treatments/')
            .set('api-secret', api_secret_hash || '')
            .send({
              identifier: identifier,
              eventType: 'Carb Correction',
              carbs: 45,  // Updated value
              created_at: createdAt
            })
            .expect(200)
            .end(function (err, res) {
              if (err) {
                return done(err);
              }

              var secondId = res.body[0]._id;

              // Should be same document (upserted)
              secondId.should.equal(firstId);
              res.body[0].carbs.should.equal(45);

              // Verify only one document exists
              self.ctx.treatments.list({ find: { identifier: identifier } }, function (err, list) {
                if (err) {
                  return done(err);
                }

                list.length.should.equal(1);
                done();
              });
            });
        });
    });
  });

  it('supports batch upload with identifiers', function (done) {
    var identifiers = [
      'BATCH-1-' + Date.now(),
      'BATCH-2-' + Date.now(),
      'BATCH-3-' + Date.now()
    ];
    var now = new Date();

    self.ctx.treatments.remove({ find: { created_at: { '$gte': '1999-01-01T00:00:00.000Z' } } }, function () {
      var treatments = identifiers.map(function (id, idx) {
        return {
          identifier: id,
          eventType: 'Bolus',
          insulin: 1.0 + idx * 0.5,
          created_at: new Date(now.getTime() - (3 - idx) * 3600000).toISOString()
        };
      });

      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash || '')
        .send(treatments)
        .expect(200)
        .end(function (err, res) {
          if (err) {
            return done(err);
          }

          res.body.length.should.equal(3);

          // Verify identifiers preserved in order
          res.body[0].identifier.should.equal(identifiers[0]);
          res.body[1].identifier.should.equal(identifiers[1]);
          res.body[2].identifier.should.equal(identifiers[2]);

          // All should have ObjectId _id
          res.body.forEach(function (t) {
            t._id.should.match(/^[0-9a-f]{24}$/);
          });

          done();
        });
    });
  });
});
