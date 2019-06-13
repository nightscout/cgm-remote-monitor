'use strict';

require('should');

describe('API3 READ', function ( ) {
  const self = this
    , testConst = require('./fixtures/api3/const.json')
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    , utils = require('./fixtures/api3/utils')
    ;

  self.validDoc = {
    identifier: utils.randomString('32', 'aA#'),
    date: (new Date()).getTime(),
    app: testConst.TEST_APP,
    device: 'openaps://samsung SM-J320FN',
    uploaderBattery: 58
  };

  self.timeout(15000);


  before(function (done) {
    instance.create({})

      .then(instance => {
        self.instance = instance;
        self.app = instance.app;
        self.env = instance.env;

        self.url = '/api/v3/' + (self.env.devicestatus_collection || 'devicestatus');
        return authSubject(instance.ctx.authorization.storage);
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


  after(function after () {
    self.instance.server.close();
  });


  it('should require authentication', function (done) {
    self.instance.get(`${self.url}/FAKE_IDENTIFIER`)
      .expect(401)
      .end((err, res) => {
        should.not.exist(err);
        res.body.status.should.equal(401);
        res.body.message.should.equal('Missing or bad access token or JWT');
        done();
      });
  });


  it('should not found not existing document', function (done) {
    self.instance.get(`${self.url}/${self.validDoc.identifier}?token=${self.token.read}`)
      .expect(404)
      .end(done);
  });


  it('should read just created document', function (done) {
    self.instance.post(`${self.url}?token=${self.token.create}`)
      .send(self.validDoc)
      .expect(201)
      .end((err, res) => {
        should.not.exist(err);
        res.body.should.be.empty();

        self.instance.get(`${self.url}/${self.validDoc.identifier}?token=${self.token.read}`)
          .expect(200)
          .end((err, res) => {
            should.not.exist(err);

            res.body.should.containEql(self.validDoc);
            res.body.should.have.property('srvCreated').which.is.a.Number();
            res.body.should.have.property('srvModified').which.is.a.Number();
            res.body.should.have.property('user');
            self.validDoc.user = res.body.user; // let's store user for later tests

            done();
          })
      });
  });


  it('should contain only selected fields', function (done) {
    self.instance.get(`${self.url}/${self.validDoc.identifier}?fields=date,device,user&token=${self.token.read}`)
      .expect(200)
      .end((err, res) => {
        should.not.exist(err);

        const correct = { 
          date: self.validDoc.date, 
          device: self.validDoc.device, 
          user: self.validDoc.user
        };
        res.body.should.eql(correct);

        done();
      })
  });


  it('should contain all fields', function (done) {
    self.instance.get(`${self.url}/${self.validDoc.identifier}?fields=_all&token=${self.token.read}`)
      .expect(200)
      .end((err, res) => {
        should.not.exist(err);

        for (const fieldName of ['app', 'date', 'device', 'identifier', 'srvModified', 'uploaderBattery', 'user']) {
          res.body.should.have.property(fieldName);
        }

        done();
      })
  });


});

