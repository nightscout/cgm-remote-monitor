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

  self.timeout(150000);


  /**
   * Cleanup after successful creation
   */
  self.delete = function deletePermanent (identifier, done) {
    self.instance.delete(`${self.url}/${identifier}?permanent=true&token=${self.token.delete}`)
      .expect(204)
      .end((err) => {
        should.not.exist(err);
        done(err);
      });
  }


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
        self.subject = result.subject;
        self.token = result.token;
        self.urlToken = `${self.url}?token=${self.token.create}`;
        done();
      })
      .catch(err => {
        done(err);
      })
  });


  after(function after () {
    self.instance.server.close();
  });


  it('should require authentication', function (done) {
    self.instance.post(`${self.url}`)
      .send(self.validDoc)
      .expect(401)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(401);
        res.body.message.should.equal('Missing or bad access token or JWT');
        done();
      });
  });


  it('should require create permission', function (done) {
    self.instance.post(`${self.url}?token=${self.token.read}`)
      .send(self.validDoc)
      .expect(403)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(403);
        res.body.message.should.equal('Missing permission api:treatments:create');
        done();
      });
  });


  it('should reject empty body', function (done) {
    self.instance.post(self.urlToken)
      .send({ })
      .expect(400)
      .end((err) => {
        should.not.exist(err);
        done();
      });
  });


  it('should accept valid document', function (done) {
    self.instance.post(self.urlToken)
      .send(self.validDoc)
      .expect(201)
      .end((err, res) => {
        should.not.exist(err);
        res.body.should.be.empty();
        res.headers.location.should.equal(`${self.url}/${self.validDoc.identifier}`);
        const lastModified = new Date(res.headers['last-modified']).getTime(); // Last-Modified has trimmed milliseconds
        
        self.get(self.validDoc.identifier, body => {
          body.should.containEql(self.validDoc);

          const ms = body.srvModified % 1000;
          (body.srvModified - ms).should.equal(lastModified);
          (body.srvCreated - ms).should.equal(lastModified);
          body.user.should.equal(self.subject.apiCreate.name);

          self.delete(self.validDoc.identifier, done);
        });
      });
  });


  it('should reject missing date', function (done) {
    let doc = Object.assign({}, self.validDoc);
    delete doc.date;

    self.instance.post(self.urlToken)
      .send(doc)
      .expect(400)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(400);
        res.body.message.should.equal('Bad or missing date field');
        done();
      })
  });


  it('should reject invalid date null', function (done) {
    self.instance.post(self.urlToken)
      .send(Object.assign({}, self.validDoc, { date: null }))
      .expect(400)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(400);
        res.body.message.should.equal('Bad or missing date field');
        done();
      })
  });


  it('should reject invalid date ABC', function (done) {
    self.instance.post(self.urlToken)
      .send(Object.assign({}, self.validDoc, { date: 'ABC' }))
      .expect(400)
      .end((err, res) => {
        res.body.status.should.equal(400);
        res.body.message.should.equal('Bad or missing date field');
        done();
      })
  });


  it('should reject invalid date -1', function (done) {
    self.instance.post(self.urlToken)
      .send(Object.assign({}, self.validDoc, { date: -1 }))
      .expect(400)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(400);
        res.body.message.should.equal('Bad or missing date field');
        done();
      })
  });



  it('should reject invalid date 1 (too old)', function (done) {
    self.instance.post(self.urlToken)
      .send(Object.assign({}, self.validDoc, { date: 1 }))
      .expect(400)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(400);
        res.body.message.should.equal('Bad or missing date field');
        done();
      })
  });


  it('should reject invalid date - illegal format', function (done) {
    self.instance.post(self.urlToken)
      .send(Object.assign({}, self.validDoc, { date: '2019-20-60T50:90:90' }))
      .expect(400)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(400);
        res.body.message.should.equal('Bad or missing date field');
        done();
      })
  });


  it('should reject invalid utcOffset -5000', function (done) {
    self.instance.post(self.urlToken)
      .send(Object.assign({}, self.validDoc, { utcOffset: -5000 }))
      .expect(400)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(400);
        res.body.message.should.equal('Bad or missing utcOffset field');
        done();
      })
  });


  it('should reject invalid utcOffset ABC', function (done) {
    self.instance.post(self.urlToken)
      .send(Object.assign({}, self.validDoc, { utcOffset: 'ABC' }))
      .expect(400)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(400);
        res.body.message.should.equal('Bad or missing utcOffset field');
        done();
      })
  });


  it('should accept valid utcOffset', function (done) {
    self.instance.post(self.urlToken)
      .send(Object.assign({}, self.validDoc, { utcOffset: 120 }))
      .expect(201)
      .end((err) => {
        should.not.exist(err);
        self.get(self.validDoc.identifier, body => {
          body.utcOffset.should.equal(120);
          self.delete(self.validDoc.identifier, done);
        });
      })
  });


  it('should reject invalid utcOffset null', function (done) {
    self.instance.post(self.urlToken)
      .send(Object.assign({}, self.validDoc, { utcOffset: null }))
      .expect(400)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(400);
        res.body.message.should.equal('Bad or missing utcOffset field');
        done();
      })
  });


  it('should reject missing app', function (done) {
    let doc = Object.assign({}, self.validDoc);
    delete doc.app;

    self.instance.post(self.urlToken)
      .send(doc)
      .expect(400)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(400);
        res.body.message.should.equal('Bad or missing app field');
        done();
      })
  });


  it('should reject invalid app null', function (done) {
    self.instance.post(self.urlToken)
      .send(Object.assign({}, self.validDoc, { app: null }))
      .expect(400)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(400);
        res.body.message.should.equal('Bad or missing app field');
        done();
      })
  });


  it('should reject empty app', function (done) {
    self.instance.post(self.urlToken)
      .send(Object.assign({}, self.validDoc, { app: '' }))
      .expect(400)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(400);
        res.body.message.should.equal('Bad or missing app field');
        done();
      })
  });


  it('should normalize date and store utcOffset', function (done) {
    self.instance.post(self.urlToken)
      .send(Object.assign({}, self.validDoc, { date: '2019-06-10T08:07:08,576+02:00' }))
      .expect(201)
      .end((err) => {
        should.not.exist(err);
        self.get(self.validDoc.identifier, body => {
          body.date.should.equal(1560146828576);
          body.utcOffset.should.equal(120);
          self.delete(self.validDoc.identifier, done);
        });
      })
  });


  it('should require update permission for deduplication', function (done) {
    const identifier = utils.randomString("32", 'aA#')
      , doc = Object.assign({}, self.validDoc, { identifier });

    self.instance.post(self.urlToken)
      .send(doc)
      .expect(201)
      .end((err) => {
        should.not.exist(err);
        self.get(identifier, createdBody => {
          createdBody.should.containEql(doc);

          const doc2 = Object.assign({}, doc);
          self.instance.post(self.urlToken)
            .send(doc2)
            .expect(403)
            .end((err, res) => {
              should.not.exist(err);
              res.body.status.should.equal(403);
              res.body.message.should.equal('Missing permission api:treatments:update');
              self.delete(identifier, done);
            });
        });
      });
  });


  it('should deduplicate document by identifier', function (done) {
    const identifier = utils.randomString("32", 'aA#')
      , doc = Object.assign({}, self.validDoc, { identifier });

    self.instance.post(self.urlToken)
      .send(doc)
      .expect(201)
      .end((err) => {
        should.not.exist(err);

        self.get(identifier, createdBody => {
          createdBody.should.containEql(doc);

          const doc2 = Object.assign({}, doc, {
            insulin: 0.5
          });

          self.instance.post(`${self.url}?token=${self.token.all}`)
            .send(doc2)
            .expect(204)
            .end((err) => {
              should.not.exist(err);

              self.get(identifier, updatedBody => {
                updatedBody.should.containEql(doc2);

                self.delete(identifier, done);
              })
            });
        });
      });
  });


  it('should deduplicate document by created at+eventType', function (done) {
    const identifier = utils.randomString("32", 'aA#')
      , doc = Object.assign({}, self.validDoc, { 
        identifier, 
        created_at: new Date(self.validDoc.date).toISOString() 
      });

    self.instance.post(self.urlToken)
      .send(doc)
      .expect(201)
      .end((err) => {
        should.not.exist(err);

        self.get(identifier, createdBody => {
          createdBody.should.containEql(doc);

          const doc2 = Object.assign({}, doc, {
            insulin: 0.4
          });

          self.instance.post(`${self.url}?token=${self.token.all}`)
            .send(doc2)
            .expect(204)
            .end((err) => {
              should.not.exist(err);

              self.get(identifier, updatedBody => {
                updatedBody.should.containEql(doc2);

                self.delete(identifier, done);
              })
            });
        });
      });
  });


});

