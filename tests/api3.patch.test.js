/* global should */
'use strict';

require('should');

describe('API3 PATCH', function() {
  const self = this
    , testConst = require('./fixtures/api3/const.json')
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    , opTools = require('../lib/api3/shared/operationTools')
    ;

  self.validDoc = {
    date: (new Date()).getTime(),
    utcOffset: -180,
    app: testConst.TEST_APP,
    device: testConst.TEST_DEVICE,
    eventType: 'Correction Bolus',
    insulin: 0.3
  };
  self.validDoc.identifier = opTools.calculateIdentifier(self.validDoc);
  
  self.timeout(15000);


  /**
   * Get document detail for futher processing
   */
  self.get = function get (identifier, done) {
    self.instance.get(`${self.url}/${identifier}?token=${self.token.read}`)
      .expect(200)
      .end((err, res) => {
        should.not.exist(err);
        done(res.body);
      });
  };


  before(done => {
    instance.create({})

      .then(instance => {
        self.instance = instance;
        self.app = instance.app;
        self.env = instance.env;

        self.url = '/api/v3/treatments';
        return authSubject(instance.ctx.authorization.storage);
      })
      .then(result => {
        self.subject = result.subject;
        self.token = result.token;
        self.urlToken = `${self.url}/${self.validDoc.identifier}?token=${self.token.update}`;
        done();
      })
      .catch(err => {
        done(err);
      })
  });


  after(() => {
    self.instance.server.close();
  });


  it('should require authentication', done => {
    self.instance.patch(`${self.url}/FAKE_IDENTIFIER`)
      .expect(401)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(401);
        res.body.message.should.equal('Missing or bad access token or JWT');
        done();
      });
  });


  it('should not found not existing collection', done => {
    self.instance.patch(`/api/v3/NOT_EXIST?token=${self.url}`)
      .send(self.validDoc)
      .expect(404)
      .end((err, res) => {
        should.not.exist(err);
        res.body.should.be.empty();
        done();
      });
  });


  it('should not found not existing document', done => {
    self.instance.patch(self.urlToken)
      .send(self.validDoc)
      .expect(404)
      .end((err, res) => {
        should.not.exist(err);
        res.body.should.be.empty();

        // now let's insert the document for further patching
        self.instance.post(`${self.url}?token=${self.token.create}`) 
          .send(self.validDoc)
          .expect(201)
          .end((err, res) => {
            should.not.exist(err);
            res.body.should.be.empty();

            done();
        });

      })
  });


  it('should reject identifier alteration', done => {
    self.instance.patch(self.urlToken)
      .send(Object.assign({}, self.validDoc, { identifier: 'MODIFIED'}))
      .expect(400)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(400);
        res.body.message.should.equal('Field identifier cannot be modified by the client');
        done();
      })
  });


  it('should reject date alteration', done => {
    self.instance.patch(self.urlToken)
      .send(Object.assign({}, self.validDoc, { date: self.validDoc.date + 10000 }))
      .expect(400)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(400);
        res.body.message.should.equal('Field date cannot be modified by the client');
        done();
      })
  });


  it('should reject utcOffset alteration', done => {
    self.instance.patch(self.urlToken)
      .send(Object.assign({}, self.validDoc, { utcOffset: self.utcOffset - 120 }))
      .expect(400)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(400);
        res.body.message.should.equal('Field utcOffset cannot be modified by the client');
        done();
      })
  });


  it('should reject eventType alteration', done => {
    self.instance.patch(self.urlToken)
      .send(Object.assign({}, self.validDoc, { eventType: 'MODIFIED' }))
      .expect(400)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(400);
        res.body.message.should.equal('Field eventType cannot be modified by the client');
        done();
      })
  });


  it('should reject device alteration', done => {
    self.instance.patch(self.urlToken)
      .send(Object.assign({}, self.validDoc, { device: 'MODIFIED' }))
      .expect(400)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(400);
        res.body.message.should.equal('Field device cannot be modified by the client');
        done();
      })
  });


  it('should reject app alteration', done => {
    self.instance.patch(self.urlToken)
      .send(Object.assign({}, self.validDoc, { app: 'MODIFIED' }))
      .expect(400)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(400);
        res.body.message.should.equal('Field app cannot be modified by the client');
        done();
      })
  });


  it('should reject srvCreated alteration', done => {
    self.instance.patch(self.urlToken)
      .send(Object.assign({}, self.validDoc, { srvCreated: self.validDoc.date - 10000 }))
      .expect(400)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(400);
        res.body.message.should.equal('Field srvCreated cannot be modified by the client');
        done();
      })
  });


  it('should reject subject alteration', done => {
    self.instance.patch(self.urlToken)
      .send(Object.assign({}, self.validDoc, { subject: 'MODIFIED' }))
      .expect(400)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(400);
        res.body.message.should.equal('Field subject cannot be modified by the client');
        done();
      })
  });


  it('should reject srvModified alteration', done => {
    self.instance.patch(self.urlToken)
      .send(Object.assign({}, self.validDoc, { srvModified: self.validDoc.date - 100000 }))
      .expect(400)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(400);
        res.body.message.should.equal('Field srvModified cannot be modified by the client');
        done();
      })
  });


  it('should reject modifiedBy alteration', done => {
    self.instance.patch(self.urlToken)
      .send(Object.assign({}, self.validDoc, { modifiedBy: 'MODIFIED' }))
      .expect(400)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(400);
        res.body.message.should.equal('Field modifiedBy cannot be modified by the client');
        done();
      })
  });


  it('should reject isValid alteration', done => {
    self.instance.patch(self.urlToken)
      .send(Object.assign({}, self.validDoc, { isValid: false }))
      .expect(400)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(400);
        res.body.message.should.equal('Field isValid cannot be modified by the client');
        done();
      })
  });


  it('should patch document', done => {
    self.validDoc.carbs = 10;

    self.instance.patch(self.urlToken)
      .send(self.validDoc)
      .expect(204)
      .end((err, res) => {
        should.not.exist(err);
        res.body.should.be.empty();

        self.get(self.validDoc.identifier, body => {
          body.carbs.should.equal(10);
          body.insulin.should.equal(0.3);
          body.subject.should.equal(self.subject.apiCreate.name);
          body.modifiedBy.should.equal(self.subject.apiUpdate.name);

          done();
        });
      })
  });


});

