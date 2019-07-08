'use strict';

require('should');

describe('API3 SEARCH', function() {
  const self = this
    , testConst = require('./fixtures/api3/const.json')
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    , utils = require('./fixtures/api3/utils')
    ;

  self.docs = testConst.SAMPLE_ENTRIES;

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


  /**
   * Create given document in a promise
   */
  self.create = (doc) => new Promise((resolve, reject) => {
    doc.identifier = utils.randomString('32', 'aA#');
    self.instance.post(`${self.url}?token=${self.token.create}`)
      .send(doc)
      .expect(201)
      .end((err, res) => {
        should.not.exist(err);
        res.body.should.be.empty();
        self.get(doc.identifier, resolve);
      });
  });
  
  
  before(done => {
    instance.create({})

      .then(instance => {
        self.testStarted = new Date();
        self.instance = instance;
        self.app = instance.app;
        self.env = instance.env;

        self.url = '/api/v3/entries';
        return authSubject(instance.ctx.authorization.storage);
      })
      .then(async result => {
        self.subject = result.subject;
        self.token = result.token;
        self.urlToken = `${self.url}?token=${self.token.read}`;
        self.urlTest = `${self.urlToken}&srvCreated$gte=${self.testStarted.getTime()}`;

        const promises = testConst.SAMPLE_ENTRIES.map(doc => self.create(doc));
        Promise.all(promises)
          .then(docs => {
            self.docs = docs;
            done();
          })
          .catch(reason => done(reason));
      })
      .catch(err => {
        done(err);
      })
  });


  after(() => {
    self.instance.server.close();
  });


  it('should require authentication', done => {
    self.instance.get(self.url)
      .expect(401)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(401);
        res.body.message.should.equal('Missing or bad access token or JWT');
        done();
      });
  });


  it('should not found not existing collection', done => {
    self.instance.get(`/api/v3/NOT_EXIST?token=${self.url}`)
      .send(self.validDoc)
      .expect(404)
      .end((err, res) => {
        should.not.exist(err);
        res.body.should.be.empty();
        done();
      });
  });


  it('should found at least 10 documents', done => {
    self.instance.get(self.urlToken)
      .expect(200)
      .end((err, res) => {
        should.not.exist(err);
        res.body.length.should.be.aboveOrEqual(self.docs.length);
        done();
      });
  });


  it('should found at least 10 documents from test start', done => {
    self.instance.get(self.urlTest)
      .expect(200)
      .end((err, res) => {
        should.not.exist(err);
        res.body.length.should.be.aboveOrEqual(self.docs.length);
        done();
      });
  });


  it('should reject invalid limit - not a number', done => {
    self.instance.get(`${self.urlToken}&limit=INVALID`)
      .expect(400)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.be.equal(400);
        res.body.message.should.be.equal('Parameter limit out of tolerance');
        done();
      });
  });


  it('should reject invalid limit - negative number', done => {
    self.instance.get(`${self.urlToken}&limit=-1`)
      .expect(400)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.be.equal(400);
        res.body.message.should.be.equal('Parameter limit out of tolerance');
        done();
      });
  });


  it('should reject invalid limit - zero', done => {
    self.instance.get(`${self.urlToken}&limit=0`)
      .expect(400)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.be.equal(400);
        res.body.message.should.be.equal('Parameter limit out of tolerance');
        done();
      });
  });


  it('should accept valid limit', done => {
    self.instance.get(`${self.urlToken}&limit=3`)
      .expect(200)
      .end((err, res) => {
        should.not.exist(err);
        res.body.length.should.be.equal(3);
        done();
      });
  });


  it('should reject invalid skip - not a number', done => {
    self.instance.get(`${self.urlToken}&skip=INVALID`)
      .expect(400)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.be.equal(400);
        res.body.message.should.be.equal('Parameter skip out of tolerance');
        done();
      });
  });


  it('should reject invalid skip - negative number', done => {
    self.instance.get(`${self.urlToken}&skip=-5`)
      .expect(400)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.be.equal(400);
        res.body.message.should.be.equal('Parameter skip out of tolerance');
        done();
      });
  });


  it('should reject both sort and sort$desc', done => {
    self.instance.get(`${self.urlToken}&sort=date&sort$desc=created_at`)
      .expect(400)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.be.equal(400);
        res.body.message.should.be.equal('Parameters sort and sort_desc cannot be combined');
        done();
      });
  });


  it('should sort well by date field', done => {
    self.instance.get(`${self.urlTest}&sort=date`)
      .expect(200)
      .end((err, res) => {
        should.not.exist(err);
        const ascending = res.body;
        const length = ascending.length;
        length.should.be.aboveOrEqual(self.docs.length);

        self.instance.get(`${self.urlTest}&sort$desc=date`)
          .expect(200)
          .end((err, res) => {
            should.not.exist(err);
            const descending = res.body;
            descending.length.should.equal(length);

            for (let i in ascending) {
              ascending[i].should.eql(descending[length - i - 1]);

              if (i > 0) {
                ascending[i - 1].date <= ascending[i].date;
              }
            }

            done();
          });
      });
  });


  it('should skip documents', done => {
    self.instance.get(`${self.urlToken}&sort=date&limit=8`)
      .expect(200)
      .end((err, res) => {
        should.not.exist(err);
        const fullDocs = res.body;
        fullDocs.length.should.be.equal(8);

        self.instance.get(`${self.urlToken}&sort=date&skip=3&limit=5`)
          .expect(200)
          .end((err, res) => {
            should.not.exist(err);
            const skipDocs = res.body;
            skipDocs.length.should.be.equal(5);

            for (let i = 0; i < 3; i++) {
              skipDocs[i].should.be.eql(fullDocs[i + 3]);
            }

            done();
          });
      });
  });


  it('should project selected fields', done => {
    self.instance.get(`${self.urlToken}&fields=date,app,subject`)
      .expect(200)
      .end((err, res) => {
        should.not.exist(err);
        
        res.body.forEach(doc => {
          const docFields = Object.getOwnPropertyNames(doc);
          docFields.sort().should.be.eql(['app', 'date', 'subject']);
        });

        done();
      });
  });


  it('should project all fields', done => {
    self.instance.get(`${self.urlToken}&fields=_all`)
      .expect(200)
      .end((err, res) => {
        should.not.exist(err);
        
        res.body.forEach(doc => {
          Object.getOwnPropertyNames(doc).length.should.be.aboveOrEqual(10);
          doc.hasOwnProperty('_id').should.not.be.true();
          doc.hasOwnProperty('identifier').should.be.true();
          doc.hasOwnProperty('srvModified').should.be.true();
          doc.hasOwnProperty('srvCreated').should.be.true();
        });

        done();
      });
  });


  it('should not exceed the limit of docs count', done => {
    const apiApp = self.instance.ctx.apiApp
      , limitBackup = apiApp.get('API3_MAX_LIMIT');
    apiApp.set('API3_MAX_LIMIT', 5);
    self.instance.get(`${self.urlToken}&limit=10`)
      .expect(400)
      .end((err, res) => {
        should.not.exist(err);
        
        res.body.status.should.be.equal(400);
        res.body.message.should.be.equal('Parameter limit out of tolerance');
        apiApp.set('API3_MAX_LIMIT', limitBackup);

        done();
      });
  });


  it('should respect the ceiling (hard) limit of docs', done => {
    const apiApp = self.instance.ctx.apiApp
      , limitBackup = apiApp.get('API3_MAX_LIMIT');
    apiApp.set('API3_MAX_LIMIT', 5);
    self.instance.get(`${self.urlToken}`)
      .expect(200)
      .end((err, res) => {
        should.not.exist(err);
        
        res.body.length.should.be.equal(5);
        apiApp.set('API3_MAX_LIMIT', limitBackup);

        done();
      });
  });

});

