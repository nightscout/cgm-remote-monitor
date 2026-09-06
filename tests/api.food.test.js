'use strict';

var request = require('supertest');
var should = require('should');
var language = require('../lib/language')();

describe('Food API', function ( ) {
  this.timeout(10000);
  var self = this;
  var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';

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

  it('put a food, query, delete, verify gone', function (done) {
    // insert a sample food - needs to be unique from example data
    var sample_food = "type=food&category=snack&subcategory=fast&name=a+food&portion=0&carbs=10&fat=0&protein=0&energy=0&gi=2&unit=g"
    console.log('Inserting food entry');
    request(self.app)
      .put('/api/food/')
      .set('api-secret', known || '')
      .send(sample_food)
      .expect(200)
      .end(function (err) {
        if (err) {
          done(err);
        } else {
          // make sure devicestatus was inserted successfully
          console.log('Ensuring food was inserted successfully');
          request(self.app)
            .get('/api/food/')
            .query('find[created_at][$gte]=2024-10-27T20:32&find[created_at][$lte]=2024-10-25T20:322')
            .set('api-secret', known || '')
            .expect(200)
            .expect(function (response) {
              console.log(JSON.stringify(response.body[0]));
            })
            .end(function (err, res) {
              if (err) {
                done(err);
              } else {
                // delete the treatment
                console.log('Deleting test food entry', res.body.length);
                var food_to_delete = res.body[0]._id;
                var total_foods_available = res.body.length;
                request(self.app)
                  .delete('/api/food/' + food_to_delete)
                  .set('api-secret', known || '')
                  .expect(200)
                  .end(function (err) {
                    if (err) {
                      done(err);
                    } else {
                      // make sure it was deleted
                      console.log('Testing if food was deleted');
                      request(self.app)
                        // .get('/api/food/' + food_to_delete)
                        .get('/api/food/')
                        // TODO: apparently food does not accept search params
                        .query('find[created_at][$gte]=2024-10-27T20:32&find[created_at][$lte]=2024-10-25T20:322')
                        .set('api-secret', known || '')
                        .expect(200)
                        .expect(function (response) {
                          response.body.length.should.equal(total_foods_available - 1);
                        })
                        .end(done);
                    }
                  });
              }
            });
        }
      });
  });
  it('post a food, query, delete, verify gone', function (done) {
    // insert a sample food - needs to be unique from example data
    var sample_food = "type=food&category=snack&subcategory=fast&name=a+food&portion=0&carbs=10&fat=0&protein=0&energy=0&gi=2&unit=g"
    console.log('Inserting food entry');
    request(self.app)
      .post('/api/food/')
      .set('api-secret', known || '')
      .send(sample_food)
      .expect(200)
      .end(function (err) {
        if (err) {
          done(err);
        } else {
          // make sure devicestatus was inserted successfully
          console.log('Ensuring food was inserted successfully');
          request(self.app)
            .get('/api/food/')
            .query('find[created_at][$gte]=2024-10-27T20:32&find[created_at][$lte]=2024-10-25T20:322')
            .set('api-secret', known || '')
            .expect(200)
            .expect(function (response) {
              console.log(JSON.stringify(response.body[0]));
            })
            .end(function (err, res) {
              if (err) {
                done(err);
              } else {
                // delete the treatment
                console.log('Deleting test food entry', res.body.length);
                var food_to_delete = res.body[0]._id;
                var total_foods_available = res.body.length;
                request(self.app)
                  .delete('/api/food/' + food_to_delete)
                  .set('api-secret', known || '')
                  .expect(200)
                  .end(function (err) {
                    if (err) {
                      done(err);
                    } else {
                      // make sure it was deleted
                      console.log('Testing if food was deleted');
                      request(self.app)
                        // .get('/api/food/' + food_to_delete)
                        .get('/api/food/')
                        // TODO: apparently food does not accept search params
                        .query('find[created_at][$gte]=2024-10-27T20:32&find[created_at][$lte]=2024-10-25T20:322')
                        .set('api-secret', known || '')
                        .expect(200)
                        .expect(function (response) {
                          response.body.length.should.equal(total_foods_available - 1);
                        })
                        .end(done);
                    }
                  });
              }
            });
        }
      });
  });

  // ============================================================
  // Array input tests - validates ef7bff3d fix
  // ============================================================

  it('post a food array', function (done) {
    var now = (new Date()).toISOString();
    request(self.app)
      .post('/api/food/')
      .set('api-secret', known || '')
      .send([
        { type: 'food', category: 'snack', subcategory: 'chips', name: 'Test Chips', portion: 30, carbs: 15, fat: 5, protein: 1, energy: 120, gi: 3, unit: 'g', created_at: now },
        { type: 'food', category: 'snack', subcategory: 'fruit', name: 'Test Apple', portion: 150, carbs: 20, fat: 0, protein: 0, energy: 80, gi: 2, unit: 'g', created_at: now }
      ])
      .expect(200)
      .end(function (err, res) {
        if (err) {
          return done(err);
        }
        // Response should be an array with 2 items
        res.body.should.be.an.Array();
        res.body.length.should.equal(2);
        // Both items should have _id assigned
        res.body[0].should.have.property('_id');
        res.body[1].should.have.property('_id');
        res.body[0].name.should.equal('Test Chips');
        res.body[1].name.should.equal('Test Apple');
        
        // Clean up - delete both
        request(self.app)
          .delete('/api/food/' + res.body[0]._id)
          .set('api-secret', known || '')
          .expect(200)
          .end(function (err) {
            if (err) return done(err);
            request(self.app)
              .delete('/api/food/' + res.body[1]._id)
              .set('api-secret', known || '')
              .expect(200)
              .end(done);
          });
      });
  });

  it('put a food array', function (done) {
    var now = (new Date()).toISOString();
    request(self.app)
      .put('/api/food/')
      .set('api-secret', known || '')
      .send([
        { type: 'food', category: 'meal', subcategory: 'pasta', name: 'Test Pasta', portion: 200, carbs: 60, fat: 3, protein: 8, energy: 300, gi: 3, unit: 'g', created_at: now },
        { type: 'food', category: 'meal', subcategory: 'rice', name: 'Test Rice', portion: 180, carbs: 55, fat: 1, protein: 5, energy: 250, gi: 3, unit: 'g', created_at: now }
      ])
      .expect(200)
      .end(function (err, res) {
        if (err) {
          return done(err);
        }
        res.body.should.be.an.Array();
        res.body.length.should.equal(2);
        res.body[0].should.have.property('_id');
        res.body[1].should.have.property('_id');
        res.body[0].name.should.equal('Test Pasta');
        res.body[1].name.should.equal('Test Rice');
        
        // Clean up
        request(self.app)
          .delete('/api/food/' + res.body[0]._id)
          .set('api-secret', known || '')
          .expect(200)
          .end(function (err) {
            if (err) return done(err);
            request(self.app)
              .delete('/api/food/' + res.body[1]._id)
              .set('api-secret', known || '')
              .expect(200)
              .end(done);
          });
      });
  });

  it('post empty array returns empty array', function (done) {
    request(self.app)
      .post('/api/food/')
      .set('api-secret', known || '')
      .send([])
      .expect(200)
      .end(function (err, res) {
        if (err) {
          return done(err);
        }
        res.body.should.be.an.Array();
        res.body.length.should.equal(0);
        done();
      });
  });
});
