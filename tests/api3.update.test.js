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
        self.urlToken = `${self.url}/${self.validDoc.identifier}?token=${self.token.update}`
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
    self.instance.put(`${self.url}/FAKE_IDENTIFIER`)
      .expect(401)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(401);
        res.body.message.should.equal('Missing or bad access token or JWT');
        done();
      });
  });


  it('should not found not existing collection', done => {
    self.instance.put(`/api/v3/NOT_EXIST?token=${self.url}`)
      .send(self.validDoc)
      .expect(404)
      .end((err, res) => {
        should.not.exist(err);
        res.body.should.be.empty();
        done();
      });
  });


  it('should require update permission for upsert', done => {
    self.instance.put(`${self.url}/${self.validDoc.identifier}?token=${self.token.update}`)
      .send(self.validDoc)
      .expect(403)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(403);
        res.body.message.should.equal('Missing permission api:treatments:create');
        done();
      });
  });


  it('should upsert not existing document', done => {
    self.instance.put(`${self.url}/${self.validDoc.identifier}?token=${self.token.all}`)
      .send(self.validDoc)
      .expect(201)
      .end((err, res) => {
        should.not.exist(err);
        res.body.should.be.empty();

        const lastModified = new Date(res.headers['last-modified']).getTime(); // Last-Modified has trimmed milliseconds
        
        self.get(self.validDoc.identifier, body => {
          body.should.containEql(self.validDoc);
          should.not.exist(body.modifiedBy);

          const ms = body.srvModified % 1000;
          (body.srvModified - ms).should.equal(lastModified);
          (body.srvCreated - ms).should.equal(lastModified);
          body.subject.should.equal(self.subject.apiAll.name);

          done();
        });
      });
  });


  it('should update the document', done => {
    self.validDoc.carbs = 10;
    delete self.validDoc.insulin;

    self.instance.put(self.urlToken)
      .send(self.validDoc)
      .expect(204)
      .end((err, res) => {
        should.not.exist(err);
        res.body.should.be.empty();

        const lastModified = new Date(res.headers['last-modified']).getTime(); // Last-Modified has trimmed milliseconds
        
        self.get(self.validDoc.identifier, body => {
          body.should.containEql(self.validDoc);
          should.not.exist(body.insulin);
          should.not.exist(body.modifiedBy);

          const ms = body.srvModified % 1000;
          (body.srvModified - ms).should.equal(lastModified);
          body.subject.should.equal(self.subject.apiUpdate.name);

          done();
        });
      });
  });


  it('should update unmodified document since', done => {
    const doc = Object.assign({}, self.validDoc, {
      carbs: 11
    });
    self.instance.put(self.urlToken)
      .set('If-Unmodified-Since', new Date(new Date().getTime() + 1000).toUTCString())
      .send(doc)
      .expect(204)
      .end((err, res) => {
        should.not.exist(err);
        res.body.should.be.empty();

        self.get(self.validDoc.identifier, body => {
          body.should.containEql(doc);

          done();
        });
      });
  });


  it('should not update document modified since', done => {
    const doc = Object.assign({}, self.validDoc, {
      carbs: 12
    });
    self.get(doc.identifier, body => {
      self.validDoc = body;

      self.instance.put(self.urlToken)
        .set('If-Unmodified-Since', new Date(new Date(body.srvModified).getTime() - 1000).toUTCString())
        .send(doc)
        .expect(412)
        .end((err, res) => {
          should.not.exist(err);
          res.body.should.be.empty();

          self.get(doc.identifier, body => {
            body.should.eql(self.validDoc);

            done();
          });
        });
    });
  });


  it('should reject date alteration', done => {
    self.instance.put(self.urlToken)
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
    self.instance.put(self.urlToken)
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
    self.instance.put(self.urlToken)
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
    self.instance.put(self.urlToken)
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
    self.instance.put(self.urlToken)
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
    self.instance.put(self.urlToken)
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
    self.instance.put(self.urlToken)
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
    self.instance.put(self.urlToken)
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
    self.instance.put(self.urlToken)
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
    self.instance.put(self.urlToken)
      .send(Object.assign({}, self.validDoc, { isValid: false }))
      .expect(400)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(400);
        res.body.message.should.equal('Field isValid cannot be modified by the client');
        done();
      })
  });


  it('should ignore identifier alteration in body', done => {
    self.get(self.validDoc.identifier, body => {
      self.validDoc = body;

      self.instance.put(self.urlToken)
        .send(Object.assign({}, self.validDoc, { identifier: 'MODIFIED' }))
        .expect(204)
        .end((err, res) => {
          should.not.exist(err);
          res.body.should.be.empty();
          done();
        })
    });
  });


  it('should not update deleted document', done => {
    self.instance.delete(`${self.url}/${self.validDoc.identifier}?token=${self.token.delete}`)
      .expect(204)
      .end((err, res) => {
        should.not.exist(err);
        res.body.should.be.empty();

        self.instance.put(self.urlToken)
          .send(self.validDoc)
          .expect(410)
          .end((err, res) => {
            should.not.exist(err);
            res.body.should.be.empty();

            done();
          });
      });
  });


});

