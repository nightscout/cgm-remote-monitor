'use strict';

require('should');

describe('API3 UPDATE', function() {
  const self = this
    , testConst = require('./fixtures/api3/const.json')
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    , utils = require('./fixtures/api3/utils')
    ;

  self.validDoc = {
    identifier: utils.randomString('32', 'aA#'),
    date: (new Date()).getTime(),
    utcOffset: -180,
    app: testConst.TEST_APP,
    eventType: 'Correction Bolus',
    insulin: 0.3
  };
  
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
  }


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


  it('should reject invalid date null', done => {
    self.instance.patch(self.urlToken)
      .send(Object.assign({}, self.validDoc, { date: null }))
      .expect(400)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(400);
        res.body.message.should.equal('Bad or missing date field');
        done();
      })
  });


  it('should reject invalid date ABC', done => {
    self.instance.patch(self.urlToken)
      .send(Object.assign({}, self.validDoc, { date: 'ABC' }))
      .expect(400)
      .end((err, res) => {
        res.body.status.should.equal(400);
        res.body.message.should.equal('Bad or missing date field');
        done();
      })
  });


  it('should reject invalid date -1', done => {
    self.instance.patch(self.urlToken)
      .send(Object.assign({}, self.validDoc, { date: -1 }))
      .expect(400)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(400);
        res.body.message.should.equal('Bad or missing date field');
        done();
      })
  });



  it('should reject invalid date 1 (too old)', done => {
    self.instance.patch(self.urlToken)
      .send(Object.assign({}, self.validDoc, { date: 1 }))
      .expect(400)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(400);
        res.body.message.should.equal('Bad or missing date field');
        done();
      })
  });


  it('should reject invalid date - illegal format', done => {
    self.instance.patch(self.urlToken)
      .send(Object.assign({}, self.validDoc, { date: '2019-20-60T50:90:90' }))
      .expect(400)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(400);
        res.body.message.should.equal('Bad or missing date field');
        done();
      })
  });


  it('should reject invalid utcOffset -5000', done => {
    self.instance.patch(self.urlToken)
      .send(Object.assign({}, self.validDoc, { utcOffset: -5000 }))
      .expect(400)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(400);
        res.body.message.should.equal('Bad or missing utcOffset field');
        done();
      })
  });


  it('should reject invalid utcOffset ABC', done => {
    self.instance.patch(self.urlToken)
      .send(Object.assign({}, self.validDoc, { utcOffset: 'ABC' }))
      .expect(400)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(400);
        res.body.message.should.equal('Bad or missing utcOffset field');
        done();
      })
  });


  it('should reject invalid utcOffset null', done => {
    self.instance.patch(self.urlToken)
      .send(Object.assign({}, self.validDoc, { utcOffset: null }))
      .expect(400)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(400);
        res.body.message.should.equal('Bad or missing utcOffset field');
        done();
      })
  });


  it('should reject invalid app null', done => {
    self.instance.patch(self.urlToken)
      .send(Object.assign({}, self.validDoc, { app: null }))
      .expect(400)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(400);
        res.body.message.should.equal('Bad or missing app field');
        done();
      })
  });


  it('should reject empty app', done => {
    self.instance.patch(self.urlToken)
      .send(Object.assign({}, self.validDoc, { app: '' }))
      .expect(400)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(400);
        res.body.message.should.equal('Bad or missing app field');
        done();
      })
  });


  it('should patch document', done => {
    self.validDoc.eventType = 'Carb Correction';
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
          body.eventType.should.equal('Carb Correction');
          body.subject.should.equal(self.subject.apiCreate.name);
          body.modifiedBy.should.equal(self.subject.apiUpdate.name);

          done();
        });
      })
  });


});

