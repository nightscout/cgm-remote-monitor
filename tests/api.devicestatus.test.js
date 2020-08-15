'use strict';

var _ = require('lodash');
var request = require('supertest');
var should = require('should');
var language = require('../lib/language')();

describe('Devicestatus API', function ( ) {
  this.timeout(10000);
  var self = this;

  var api = require('../lib/api/');
  beforeEach(function (done) {
    process.env.API_SECRET = 'this is my long pass phrase';
    self.env = require('../env')();
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

  it('post a devicestatus, query, delete, verify gone', function (done) {
    // insert a devicestatus - needs to be unique from example data
    console.log('Inserting devicestatus entry');
    request(self.app)
      .post('/api/devicestatus/')
      .set('api-secret', self.env.api_secret || '')
      .send({
        device: 'xdripjs://rigName'
        , xdripjs: {
          state: 6
          , stateString: 'OK'
          , txStatus: 0
          , txStatusString: 'OK'
        }
        , created_at: '2018-12-16T01:00:52Z'
      })
      .expect(200)
      .end(function (err) {
        if (err) {
          done(err);
        } else {
          // make sure devicestatus was inserted successfully
          console.log('Ensuring devicestatus entry was inserted successfully');
          request(self.app)
            .get('/api/devicestatus/')
            .query('find[created_at][$gte]=2018-12-16')
            .set('api-secret', self.env.api_secret || '')
            .expect(200)
            .expect(function (response) {
              response.body[0].xdripjs.state.should.equal(6);
              response.body[0].utcOffset.should.equal(0);
            })
            .end(function (err) {
              if (err) {
                done(err);
              } else {
                // delete the treatment
                console.log('Deleting test treatment entry');
                request(self.app)
                  .delete('/api/devicestatus/')
                  .query('find[created_at][$gte]=2018-12-16')
                  .set('api-secret', self.env.api_secret || '')
                  .expect(200)
                  .end(function (err) {
                    if (err) {
                      done(err);
                    } else {
                      // make sure it was deleted
                      console.log('Testing if devicestatus was deleted');
                      request(self.app)
                        .get('/api/devicestatus/')
                        .query('find[created_at][$lte]=2018-12-16')
                        .set('api-secret', self.env.api_secret || '')
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
