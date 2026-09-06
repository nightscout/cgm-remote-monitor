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

  it('round-trips browser-form quick-pick order, portions and totals through MongoDB twice', async function () {
    const assert = require('node:assert/strict');
    const {ObjectId} = require('mongodb');
    const ids = [new ObjectId(), new ObjectId()];
    const foodId = new ObjectId().toHexString();
    try {
      for (let cycle = 0; cycle < 2; cycle++) {
        for (let index = 0; index < ids.length; index++) {
          const portions = index === 0 ? 2 : (cycle === 0 ? 0 : 3);
          const data = new URLSearchParams({_id: ids[index].toHexString(), type: 'quickpick',
            name: 'Owned meal ' + index, position: String(cycle === 0 ? 1 - index : index),
            hidden: 'false', hideafteruse: 'true', carbs: String(portions * 10)});
          if (portions) {
            for (const [key, value] of Object.entries({_id: foodId, type: 'food', name: 'Owned oats', carbs: 10, portions, portion: 25, unit: 'g'})) {
              data.set('foods[0][' + key + ']', String(value));
            }
          }
          await request(self.app).put('/api/food/').set('api-secret', known)
            .set('Content-Type', 'application/x-www-form-urlencoded').send(data.toString()).expect(200);
        }
        const stored = await self.ctx.food().find({_id: {$in: ids}}).toArray();
        assert.equal(stored.length, 2, 'Updates preserve exactly two owned records');
        const response = await request(self.app).get('/api/food/quickpicks').set('api-secret', known).expect(200);
        const owned = response.body.filter(row => ids.some(id => id.toHexString() === row._id));
        const expected = cycle === 0 ? [ids[1], ids[0]] : ids;
        assert.deepEqual(owned.map(row => row._id), expected.map(id => id.toHexString()));
        assert.deepEqual(owned.map(row => row.position), ['0', '1']);
        for (let index = 0; index < ids.length; index++) {
          const row = owned.find(row => row._id === ids[index].toHexString());
          const raw = stored.find(row => row._id.equals(ids[index]));
          const portions = index === 0 ? 2 : (cycle === 0 ? 0 : 3);
          assert.equal(row.carbs, String(portions * 10));
          assert.equal(raw.carbs, row.carbs);
          assert.equal(row.hidden, 'false');
          assert.equal(row.hideafteruse, 'true');
          if (portions) {
            assert.equal(row.foods.length, 1);
            assert.equal(row.foods[0]._id, foodId);
            assert.equal(row.foods[0].portions, String(portions));
            assert.equal(row.foods[0].carbs, '10');
            assert.deepEqual(raw.foods, row.foods);
          }
        }
      }
    } finally {
      for (const id of ids) await request(self.app).delete('/api/food/' + id.toHexString()).set('api-secret', known).expect(200);
    }
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
