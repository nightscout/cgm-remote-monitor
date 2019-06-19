'use strict';

const request = require('supertest')
  , apiConst = require('../lib/api3/const.json')
  , semver = require('semver')
  , moment = require('moment')
  ;
require('should');
  
describe('Security of REST API3', function() {
  const self = this
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    ;

  this.timeout(30000);

  before(done => {
    instance.create({ useHttps: false })

    .then(http => {
      self.http = http;
      return instance.create({ });
    })
    .then(https => {
      self.https = https;
      return authSubject(https.ctx.authorization.storage);
    })
    .then(result => {
      self.subject = result.subject;
      self.token = result.token;
      done();
    })
    .catch(err => {
      done(err);
    })

  });

  
  after(() => {
    self.http.server.close();
    self.https.server.close();
  });


  it('should require HTTPS', done => {
    if (semver.gte(process.version, '10.0.0')) { 
    request(self.http.baseUrl)  // hangs on 8.x.x (no reason why)
      .get('/api/v3/test') 
      .expect(403)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(403);
        res.body.message.should.equal(apiConst.MSG.HTTP_403_NOT_USING_HTTPS);
        done();
      }); 
    }
    else {
      done();
    }
  });


  it('should require Date header', done => {
    request(self.https.baseUrl)
      .get('/api/v3/test')
      .expect(401)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(401);
        res.body.message.should.equal(apiConst.MSG.HTTP_401_MISSING_DATE);

        done();
      });
  });


  it('should validate Date header syntax', done => {
    request(self.https.baseUrl)
      .get('/api/v3/test')
      .set('Date', 'invalid date header')
      .expect(401)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(401);
        res.body.message.should.equal(apiConst.MSG.HTTP_401_BAD_DATE);

        done();
      });
  });


  it('should reject Date header out of tolerance', done => {
    const oldDate = new Date((new Date() * 1) - 2 * 3600 * 1000)
      , futureDate = new Date((new Date() * 1) + 2 * 3600 * 1000);

    request(self.https.baseUrl)
      .get('/api/v3/test')
      .set('Date', oldDate.toUTCString())
      .expect(401)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(401);
        res.body.message.should.equal(apiConst.MSG.HTTP_401_DATE_OUT_OF_TOLERANCE);

        request(self.https.baseUrl)
          .get('/api/v3/test')
          .set('Date',futureDate.toUTCString())
          .expect(401)
          .end((err, res) => {
            res.body.status.should.equal(401);
            res.body.message.should.equal(apiConst.MSG.HTTP_401_DATE_OUT_OF_TOLERANCE);

            done();
          });
      });
  });


  it('should reject invalid now ABC', done => {
    request(self.https.baseUrl)
      .get(`/api/v3/test?now=ABC`)
      .expect(401)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(401);
        res.body.message.should.equal('Bad Date header');
        done();
      })
  });


  it('should reject invalid now -1', done => {
    request(self.https.baseUrl)
      .get(`/api/v3/test?now=-1`)
      .expect(401)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(401);
        res.body.message.should.equal('Bad Date header');
        done();
      })
  });


  it('should reject invalid now - illegal format', done => {
    request(self.https.baseUrl)
      .get(`/api/v3/test?now=2019-20-60T50:90:90`)
      .expect(401)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(401);
        res.body.message.should.equal('Bad Date header');
        done();
      })
  });


  it('should require token', done => {
    request(self.https.baseUrl)
      .get('/api/v3/test')
      .set('Date', new Date().toUTCString())
      .expect(401)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(401);
        res.body.message.should.equal(apiConst.MSG.HTTP_401_MISSING_OR_BAD_TOKEN);

        done();
      });
  });


  it('should require valid token', done => {
    request(self.https.baseUrl)
      .get('/api/v3/test?token=invalid_token')
      .set('Date', new Date().toUTCString())
      .expect(401)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(401);
        res.body.message.should.equal(apiConst.MSG.HTTP_401_MISSING_OR_BAD_TOKEN);

        done();
      });
  });


  it('should deny subject denied', done => {
    request(self.https.baseUrl)
      .get('/api/v3/test?token=' + self.subject.denied.accessToken)
      .set('Date', new Date().toUTCString())
      .expect(403)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(403);
        res.body.message.should.equal(apiConst.MSG.HTTP_403_MISSING_PERMISSION.replace('{0}', 'api:entries:read'));

        done();
      });
  });


  it('should allow subject with read permission', done => {
    request(self.https.baseUrl)
      .get('/api/v3/test?token=' + self.token.read)
      .set('Date', new Date().toUTCString())
      .expect(200)
      .end((err) => {
        should.not.exist(err);

        done();
      });
  });


  it('should accept valid now - epoch in ms', done => {
    request(self.https.baseUrl)
      .get(`/api/v3/test?token=${self.token.read}&now=${moment().valueOf()}`)
      .expect(200)
      .end((err) => {
        should.not.exist(err);
        done();
      })
  });
  
  
  it('should accept valid now - epoch in seconds', done => {
    request(self.https.baseUrl)
      .get(`/api/v3/test?token=${self.token.read}&now=${moment().unix()}`)
      .expect(200)
      .end((err) => {
        should.not.exist(err);
        done();
      })
  });


  it('should accept valid now - ISO 8601', done => {
    request(self.https.baseUrl)
      .get(`/api/v3/test?token=${self.token.read}&now=${moment().toISOString()}`)
      .expect(200)
      .end((err) => {
        should.not.exist(err);
        done();
      })
  });


  it('should accept valid now - RFC 2822', done => {
    request(self.https.baseUrl)
      .get(`/api/v3/test?token=${self.token.read}&now=${moment().utc().format('ddd, DD MMM YYYY HH:mm:ss [GMT]')}`)
      .expect(200)
      .end((err) => {
        should.not.exist(err);
        done();
      })
  });
});