'use strict';

const request = require('supertest');
require('should');

describe('Generic REST API3', function ( ) {
  const self = this
    , testConst = require('./fixtures/api3/const.json')
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    , utils = require('./fixtures/api3/utils')
    ;

  self.identifier = utils.randomString('32', 'aA#'); // let's have a brand new identifier for your testing document
  self.urlLastModified = '/api/v3/lastModified';
  self.historyTimestamp = 0;

  self.docOriginal = {
    identifier: self.identifier,
    eventType: 'Correction Bolus',
    insulin: 1,
    date: (new Date()).getTime(),
    app: testConst.TEST_APP
  };

  this.timeout(30000);

  before(function (done) {
    instance.create({ })

      .then(instance => {
        self.instance = instance;
        self.app = instance.app;
        self.env = instance.env;

        self.urlCol = '/api/v3/' + self.env.treatments_collection;
        self.urlResource = self.urlCol + '/' + self.identifier;
        self.urlHistory = self.urlCol + '/history';

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


  self.checkHistoryExistence = function checkHistoryExistence (done, assertions) {

    self.instance.get(`${self.urlHistory}/${self.historyTimestamp}?token=${self.token.read}`)
      .expect(200)
      .end(function (err, res) {
        should.not.exist(err);

        res.body.length.should.be.above(0);
        res.body.should.matchAny(function(value) { 
          value.identifier.should.be.eql(self.identifier);
          value.srvModified.should.be.above(self.historyTimestamp);

          if (typeof(assertions) === 'function') {
            assertions(value);
          }

          self.historyTimestamp = value.srvModified;
        });
        done();
      });
  }


  it('LAST MODIFIED to get actual server timestamp', function (done) {
    self.instance.get(`${self.urlLastModified}?token=${self.token.read}`)
      .expect(200)
      .end(function (err, res) {
        should.not.exist(err);

        self.historyTimestamp = res.body.collections.treatments;
        if (!self.historyTimestamp) {
          self.historyTimestamp = res.body.srvDate - (10 * 60 * 1000);
        }
        self.historyTimestamp.should.be.aboveOrEqual(testConst.YEAR_2019);
        done();
      });;
  });


  it('STATUS to get actual server timestamp', function (done) {
    self.instance.get(`/api/v3/status?token=${self.token.read}`)
      .expect(200)
      .end(function (err, res) {
        should.not.exist(err);

        self.historyTimestamp = res.body.srvDate;
        self.historyTimestamp.should.be.aboveOrEqual(testConst.YEAR_2019);
        done();
      });;
  });


  it('READ of not existing document is not found', function (done) {
    self.instance.get(`${self.urlResource}?token=${self.token.read}`)
      .expect(404)
      .end(done);
  });


  it('SEARCH of not existing document (not found)', function (done) {
    self.instance.get(`${self.urlCol}?token=${self.token.read}`)
      .query({ 'identifier_eq': self.identifier })
      .expect(200)
      .end(function (err, res) {
        should.not.exist(err);
        res.body.should.have.length(0);
        done();
      });
  });


  it('DELETE of not existing document is not found', function (done) {
    self.instance.delete(`${self.urlResource}?token=${self.token.delete}`)
      .expect(404)
      .end(done);
  });


  it('CREATE new document', function (done) {
    self.instance.post(`${self.urlCol}?token=${self.token.create}`)
      .send(self.docOriginal)
      .expect(201)
      .end(done);
  });


  it('READ existing document', function (done) {
    self.instance.get(`${self.urlResource}?token=${self.token.read}`)
      .expect(200)
      .end(function (err, res) {
        should.not.exist(err);
        
        res.body.should.containEql(self.docOriginal);
        self.docActual = res.body;

        if (self.historyTimestamp >= self.docActual.srvModified) {
          self.historyTimestamp = self.docActual.srvModified - 1;
        }
        done();
      });
  });


  it('SEARCH existing document (found)', function (done) {
    self.instance.get(`${self.urlCol}?token=${self.token.read}`)
      .query({ 'identifier$eq': self.identifier })
      .expect(200)
      .end(function (err, res) {
        should.not.exist(err);

        res.body.length.should.be.above(0);
        res.body.should.matchAny(function(value) { 
          value.identifier.should.be.eql(self.identifier);
        });
        done();
      });
  });


  it('new document in HISTORY', function (done) {
    self.checkHistoryExistence(done);
  });


  it('UPDATE document', function (done) {
    self.docActual.insulin = 0.5;

    self.instance.put(`${self.urlResource}?token=${self.token.update}`)
      .send(self.docActual)
      .expect(204)
      .end(done);
  });


  it('document changed in HISTORY', function (done) {
    self.checkHistoryExistence(done);
  }); 

  
  it('document changed in READ', function (done) {
    self.instance.get(`${self.urlResource}?token=${self.token.read}`)
      .expect(200)
      .end(function (err, res) {
        should.not.exist(err);

        delete self.docActual.srvModified;
        res.body.should.containEql(self.docActual);
        self.docActual = res.body;
        done();
      });
  });


  it('PATCH document', function (done) {
    self.docActual.carbs = 5;
    self.docActual.insulin = 0.4;

    self.instance.patch(`${self.urlResource}?token=${self.token.update}`)
      .send({ 'carbs': self.docActual.carbs, 'insulin': self.docActual.insulin })
      .expect(204)
      .end(done);
  });


  it('document changed in HISTORY', function (done) {
    self.checkHistoryExistence(done);
  }); 

  
  it('document changed in READ', function (done) {
    self.instance.get(`${self.urlResource}?token=${self.token.read}`)
      .expect(200)
      .end(function (err, res) {
        should.not.exist(err);

        delete self.docActual.srvModified;
        res.body.should.containEql(self.docActual);
        self.docActual = res.body;
        done();
      });
  });


  it('soft DELETE', function (done) {
    self.instance.delete(`${self.urlResource}?token=${self.token.delete}`)
      .expect(204)
      .end(done);
  });


  it('READ of deleted is gone', function (done) {
    self.instance.get(`${self.urlResource}?token=${self.token.read}`)
      .expect(410)
      .end(done);
  });



  it('SEARCH of deleted document missing it', function (done) {
    self.instance.get(`${self.urlCol}?token=${self.token.read}`)
      .query({ 'identifier_eq': self.identifier })
      .expect(200)
      .end(function (err, res) {
        should.not.exist(err);
        res.body.should.have.length(0);
        done();
      });
  }); 
  

  it('document deleted in HISTORY', function (done) {
    self.checkHistoryExistence(done, function assertions (value) {
      value.isValid.should.be.eql(false);
    });
  }); 
  

  it('permanent DELETE', function (done) {
    self.instance.delete(`${self.urlResource}?token=${self.token.delete}`)
      .query({ 'permanent': 'true' })
      .expect(204)
      .end(done);
  });


  it('READ of permanently deleted is not found', function (done) {
    self.instance.get(`${self.urlResource}?token=${self.token.read}`)
      .expect(404)
      .end(done);
  });


  it('document permanently deleted not in HISTORY', function (done) {
    self.instance.get(`${self.urlHistory}/${self.historyTimestamp}?token=${self.token.read}`)
      .end(function (err, res) {
        should.not.exist(err);

        if (res.status == 200) {
          res.body.should.matchEach(function(value) { 
            value.identifier.should.not.be.eql(self.identifier);
          });
        } else if (res.status != 204) {
          should.fail();
        }
        done();
      });
  }); 

});

