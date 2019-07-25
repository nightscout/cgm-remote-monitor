'use strict';

const request = require('supertest');
require('should');

describe('Socket.IO in REST API3', function() {
  const self = this
    , testConst = require('./fixtures/api3/const.json')
    , apiConst = require('../lib/api3/const.json')
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    , utils = require('./fixtures/api3/utils')
    ;

  self.identifier = utils.randomString('32', 'aA#'); // let's have a brand new identifier for your testing document

  self.docOriginal = {
    identifier: self.identifier,
    eventType: 'Correction Bolus',
    insulin: 1,
    date: (new Date()).getTime(),
    app: testConst.TEST_APP
  };

  this.timeout(30000);

  before(done => {
    instance.create({
      storageSocket: true
    })
    .then(instance => {
      self.instance = instance;
      self.app = instance.app;
      self.env = instance.env;

      self.colName = 'treatments';
      self.urlCol = `/api/v3/${self.colName}`;
      self.urlResource = self.urlCol + '/' + self.identifier;
      self.urlHistory = self.urlCol + '/history';

      return authSubject(instance.ctx.authorization.storage);
    })
    .then(result => {
      self.subject = result.subject;
      self.token = result.token;
      self.socket = self.instance.clientSocket;
      done();
    })
    .catch(err => {
      done(err);
    })
  });


  after(() => {
    if(self.instance && self.instance.clientSocket && self.instance.clientSocket.connected) {
      self.instance.clientSocket.disconnect();
    }
    self.instance.server.close();
  });


  it('should not subscribe without accessToken', done => {
    self.socket.emit('subscribe', { }, function (data) {
      data.success.should.not.equal(true);
      data.message.should.equal(apiConst.MSG.SOCKET_MISSING_OR_BAD_ACCESS_TOKEN);
      done();
    });
  });


  it('should not subscribe by invalid accessToken', done => {
    self.socket.emit('subscribe', { accessToken: 'INVALID' }, function (data) {
      data.success.should.not.equal(true);
      data.message.should.equal(apiConst.MSG.SOCKET_MISSING_OR_BAD_ACCESS_TOKEN);
      done();
    });
  });


  it('should not subscribe by subject with no rights', done => {
    self.socket.emit('subscribe', { accessToken: self.token.denied }, function (data) {
      data.success.should.not.equal(true);
      data.message.should.equal(apiConst.MSG.SOCKET_UNAUTHORIZED_TO_ANY);
      done();
    });
  });


  it('should subscribe by valid accessToken', done => {
    const cols = ['entries', 'treatments'];

    self.socket.emit('subscribe', {
      accessToken: self.token.all,
      collections: cols
    }, function (data) {
      data.success.should.equal(true);
      should(data.collections.sort()).be.eql(cols)
      done();
    });
  });


  it('should emit create event on CREATE', done => {

    self.socket.once('create', (event) => {
      event.colName.should.equal(self.colName);
      event.doc.should.containEql(self.docOriginal);
      delete event.doc.subject;
      self.docActual = event.doc;
      done();
    });

    self.instance.post(`${self.urlCol}?token=${self.token.create}`)
      .send(self.docOriginal)
      .expect(201)
      .end((err) => {
        should.not.exist(err);
      });
  });


  it('should emit update event on UPDATE', done => {

    self.docActual.insulin = 0.5;

    self.socket.once('update', (event) => {
      delete self.docActual.srvModified;
      event.colName.should.equal(self.colName);
      event.doc.should.containEql(self.docActual);
      delete event.doc.subject;
      self.docActual = event.doc;
      done();
    });

    self.instance.put(`${self.urlResource}?token=${self.token.update}`)
      .send(self.docActual)
      .expect(204)
      .end((err) => {
        should.not.exist(err);
        self.docActual.subject = self.subject.apiUpdate.name;
      });
  });


  it('should emit update event on PATCH', done => {

    self.docActual.carbs = 5;
    self.docActual.insulin = 0.4;

    self.socket.once('update', (event) => {
      delete self.docActual.srvModified;
      event.colName.should.equal(self.colName);
      event.doc.should.containEql(self.docActual);
      delete event.doc.subject;
      self.docActual = event.doc;
      done();
    });

    self.instance.patch(`${self.urlResource}?token=${self.token.update}`)
      .send({ 'carbs': self.docActual.carbs, 'insulin': self.docActual.insulin })
      .expect(204)
      .end((err) => {
        should.not.exist(err);
      });
  });


  it('should emit delete event on DELETE', done => {

    self.socket.once('delete', (event) => {
      event.colName.should.equal(self.colName);
      event.identifier.should.equal(self.identifier);
      done();
    });

    self.instance.delete(`${self.urlResource}?token=${self.token.delete}`)
      .expect(204)
      .end((err) => {
        should.not.exist(err);
      });
  });


});

