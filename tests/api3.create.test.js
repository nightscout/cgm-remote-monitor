'use strict';

const request = require('supertest');
require('should');

describe('API3 CREATE', function ( ) {
  const self = this
    , testConst = require('./fixtures/api3/const.json')
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    , utils = require('./fixtures/api3/utils')
    ;

  self.validDoc = {
    "identifier": utils.randomString("32", 'aA#'),
    date: (new Date()).getTime(),
    app: testConst.TEST_APP,
    eventType: 'Correction Bolus',
    insulin: 0.3
  };

  self.timeout(15000);

  // for cleanup after successful creation
  self.delete = function deletePermanent (identifier, done) {
    self.instance.delete(`${self.url}/${identifier}?permanent=true&token=${self.token.delete}`)
      .expect(204)
      .end((err) => {
        done(err);
      });
  }

  before(function (done) {
    instance.create({})

      .then(instance => {
        self.instance = instance;
        self.app = instance.app;
        self.env = instance.env;

        self.url = '/api/v3/' + self.env.treatments_collection;
        return authSubject(instance.ctx.authorization.storage);
      })
      .then(result => {
        self.token = result.token;
        done();
      })
      .catch(err => {
        done(err);
      })
  });


  after(function after () {
    self.instance.server.close();
  });


  it('should reject empty body', function (done) {
    self.instance.post(`${self.url}?token=${self.token.create}`)
      .send({ })
      .expect(400)
      .end(function (err, res)  {
        done();
      });
  });


  it('should accept valid document', function (done) {
    self.instance.post(`${self.url}?token=${self.token.create}`)
      .send(self.validDoc)
      .expect(201)
      .end(() => self.delete(self.validDoc.identifier, done))
  });

});

