'use strict';

const should = require('should');
const request = require('supertest');
const socketIoClient = require('socket.io-client');
const instance = require('./fixtures/api/instance');

// SHA1: 'this is my long pass phrase'
const SECRET_HASH = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';

describe('Websocket events', function() {
  this.timeout(10000);

  let baseUrl;
  let inst;
  let clientSocket;

  before(async function() {
    inst = await instance.create({
      apiSecret: 'this is my long pass phrase'
    , });
    baseUrl = inst.baseUrl;

    const api = require('../lib/api')(inst.env, inst.ctx);
    inst.app.use('/api/v1', api);

    require('../lib/server/websocket')(inst.env, inst.ctx, inst.server);
  })

  beforeEach(function(done) {
    // Reset treatments to achieve idempotence in test runs. Note that there is deduplication feature in websockets.js.
    inst.ctx.treatments.remove({ find: {} }, function() {
      inst.ctx.store.collection('food').remove({}, function() {
        inst.ctx.store.collection('devicestatus').remove({}, function() {
          inst.ctx.dataloader.update(inst.ctx.ddata, () => {
            inst.ctx.bus.emit('data-loaded')

            clientSocket = socketIoClient(baseUrl, {
              rejectUnauthorized: false
            });

            clientSocket.on('connect', () => {
              done();
            })
          })
        });
      });
    });
  });

  afterEach(function(done) {
    clientSocket.on('disconnect', () => done());
    clientSocket.close();
  });

  it('should not allow dbAdd without authentication', function(done) {
    clientSocket.emit('dbAdd', {
      collection: 'treatments'
      , data: {
        NSCLIENT_ID: 'asda'
        , insulin: 1
        , carbs: 10
        , percent: 95
        , absolute: 10
        , duration: 100
      , }
    }, result => {
      result.result.should.equal('Not authorized')

      request(inst.app)
        .get('/api/v1/treatments')
        .set('api-secret', SECRET_HASH)
        .expect(200)
        .end((err, res) => {
          if (err) return done(err);
          res.body.should.be.an.Array().and.be.empty();
          done();
        });
    })

  });

  it('should authenticate by authorize event', function(done) {
    clientSocket.emit('authorize', {
      secret: SECRET_HASH
      , status: true
    }, (authResponse) => {
      authResponse.should.have.property('read', true);
      authResponse.should.have.property('write', true);
      done();
    });

  });

  it('receives dataUpdate after auth', function(done) {
    clientSocket.on('dataUpdate', data => {
      data.status.status.should.equal('ok')
      done()
    })

    clientSocket.emit('authorize', {
      secret: SECRET_HASH
      , status: true
    });
  });

  describe('Authorized operations', function() {
    beforeEach(function websocketAuthorization (done) {
      clientSocket.emit('authorize', {
        secret: SECRET_HASH
        , status: true
      }, () => {
        done();
      });
    });

    ['treatments', 'devicestatus', 'food'].forEach(collection => {
      it(`Writes to ${collection} by dbAdd event`, function(done) {
        clientSocket.emit('dbAdd', {
          collection
          , data: { NSCLIENT_ID: 'qwerty' }
        , }, result => {
          result[0].should.have.property('created_at')

          request(inst.app)
            .get(`/api/v1/${collection}`)
            .set('api-secret', SECRET_HASH)
            .expect(200)
            .end((err, res) => {
              if (err) return done(err);
              res.body[0].NSCLIENT_ID.should.equal('qwerty');
              done();
            });
        })
      });
    });

    it('removes docs with dbRemove', function(done) {
      clientSocket.emit('dbAdd', {
        collection: 'treatments'
        , data: {
          eventType: 'Meal Bolus'
          , insulin: 1
          , notes: 'To Be Removed'
        , }
      }, (created) => {
        clientSocket.emit('dbRemove', {
          collection: 'treatments'
          , _id: created[0]._id
        , }, response => {
          response.result.should.equal('success');

          request(inst.app)
            .get('/api/v1/treatments')
            .set('api-secret', SECRET_HASH)
            .expect(200)
            .end((err, res) => {
              if (err) return done(err);
              res.body.should.be.an.Array().and.be.empty();
              done();
            });
        });
      });
    });

    it('updates docs with dbUpdate', function(done) {
      clientSocket.emit('dbAdd', {
        collection: 'treatments'
        , data: {
          eventType: 'Meal Bolus'
          , insulin: 1
          , notes: 'Original'
        , }
      }, (created) => {
        const id = created[0]._id;

        clientSocket.emit('dbUpdate', {
          collection: 'treatments'
          , _id: id
          , data: {
            insulin: 2
            , notes: 'Updated'
          }
        }, (response) => {
          response.result.should.equal('success');

          request(inst.app)
            .get('/api/v1/treatments')
            .set('api-secret', SECRET_HASH)
            .expect(200)
            .end((err, res) => {
              if (err) return done(err);
              res.body[0].insulin.should.equal(2);
              res.body[0].notes.should.equal('Updated');
              done();
            });
        });
      });
    });

    it('doesnt update docs with invalid collection', function(done) {
      clientSocket.emit('dbUpdate', {
        collection: 'non_existent_collection'
        , _id: 123231312312
      , }, response => {
        response.result.should.equal('Wrong collection');
        done()
      })
    });

    it('loads previous data with loadRetro', function(done) {
      clientSocket.emit('dbAdd', {
        collection: 'devicestatus'
        , data: {
          device: 'deviceNameAbc'
          , uploader: { battery: 77 }
        , }
      }, () => {
        inst.ctx.dataloader.update(inst.ctx.ddata, () => {
          inst.ctx.bus.emit('data-loaded')
          clientSocket.emit('loadRetro', {
            loadedMills: 123
          , }, response => {
            response.result.should.equal('success');
          })
        })
      });

      clientSocket.on('retroUpdate', (res) => {
        res.devicestatus[0].uploader.battery.should.equal(77);
        done();
      })
    });

    it('removes doc properties with dbUpdateUnset', function(done) {
      clientSocket.emit('dbAdd', {
        collection: 'treatments'
        , data: {
          eventType: 'Meal Bolus'
          , insulin: 1
          , carbs: 10
          , notes: 'To Be Removed'
        , }
      }, (created) => {
        clientSocket.emit('dbUpdateUnset', {
          collection: 'treatments'
          , _id: created[0]._id
          , data: {
            notes: 1
          }
        }, (response) => {
          response.result.should.equal('success');

          request(inst.app)
            .get('/api/v1/treatments')
            .set('api-secret', SECRET_HASH)
            .expect(200)
            .end((err, res) => {
              if (err) return done(err);
              res.body[0].insulin.should.equal(1);
              should.not.exist(res.body[0].notes);
              done();
            });
        });
      });
    });

    it('emits delta object to "DataReceivers" socket.io room', function(done) {
      clientSocket.once('dataUpdate', (data) => {
        data.treatments[0].eventType.should.equal('Meal Bolus')

        request(inst.app)
          .get('/api/v1/treatments')
          .set('api-secret', SECRET_HASH)
          .expect(200)
          .end((err, res) => {
            if (err) return done(err);
            res.body[0].eventType.should.equal('Meal Bolus');
            res.body[0].insulin.should.approximately(3.5, 0.01);
            res.body[0].notes.should.equal('Test Bolus');
            done();
          });
      })

      clientSocket.emit('dbAdd', {
        collection: 'treatments'
        , data: {
          eventType: 'Meal Bolus'
          , insulin: 3.5
          , notes: 'Test Bolus'
          , created_at: new Date().toISOString()
        , }
      }, response => {
        response[0].eventType.should.equal('Meal Bolus');
        inst.ctx.dataloader.update(inst.ctx.ddata, () => {
          inst.ctx.bus.emit('data-loaded')
        })
      })

    });
  });
});
