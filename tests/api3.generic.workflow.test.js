/* eslint require-atomic-updates: 0 */
'use strict';

require('should');

describe('Generic REST API3', function() {
  const self = this
    , testConst = require('./fixtures/api3/const.json')
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    , opTools = require('../lib/api3/shared/operationTools')
    , utils = require('./fixtures/api3/utils')
    ;

  utils.randomString('32', 'aA#'); // let's have a brand new identifier for your testing document
  self.urlLastModified = '/api/v3/lastModified';
  self.historyTimestamp = 0;

  self.docOriginal = {
    eventType: 'Correction Bolus',
    insulin: 1,
    date: (new Date()).getTime(),
    app: testConst.TEST_APP,
    device: testConst.TEST_DEVICE
  };
  self.identifier = opTools.calculateIdentifier(self.docOriginal);
  self.docOriginal.identifier = self.identifier;

    this.timeout(30000);

  before(async () => {
    self.instance = await instance.create({});

    self.app = self.instance.app;
    self.env = self.instance.env;
    self.urlCol = '/api/v3/treatments';
    self.urlResource = self.urlCol + '/' + self.identifier;
    self.urlHistory = self.urlCol + '/history';

    let authResult = await authSubject(self.instance.ctx.authorization.storage);

    self.subject = authResult.subject;
    self.token = authResult.token;
    self.urlToken = `${self.url}?token=${self.token.create}`;
  });


  after(() => {
    self.instance.server.close();
  });


  self.checkHistoryExistence = async function checkHistoryExistence (assertions) {

    let res = await self.instance.get(`${self.urlHistory}/${self.historyTimestamp}?token=${self.token.read}`)
      .expect(200);

    res.body.length.should.be.above(0);
    res.body.should.matchAny(value => {
      value.identifier.should.be.eql(self.identifier);
      value.srvModified.should.be.above(self.historyTimestamp);

      if (typeof(assertions) === 'function') {
        assertions(value);
      }

      self.historyTimestamp = value.srvModified;
    });
  };


  it('LAST MODIFIED to get actual server timestamp', async () => {
    let res = await self.instance.get(`${self.urlLastModified}?token=${self.token.read}`)
      .expect(200);

    self.historyTimestamp = res.body.collections.treatments;
    if (!self.historyTimestamp) {
      self.historyTimestamp = res.body.srvDate - (10 * 60 * 1000);
    }
    self.historyTimestamp.should.be.aboveOrEqual(testConst.YEAR_2019);
  });


  it('STATUS to get actual server timestamp', async () => {
    let res = await self.instance.get(`/api/v3/status?token=${self.token.read}`)
      .expect(200);

    self.historyTimestamp = res.body.srvDate;
    self.historyTimestamp.should.be.aboveOrEqual(testConst.YEAR_2019);
  });


  it('READ of not existing document is not found', async () => {
    await self.instance.get(`${self.urlResource}?token=${self.token.read}`)
      .expect(404);
  });


  it('SEARCH of not existing document (not found)', async () => {
    let res = await self.instance.get(`${self.urlCol}?token=${self.token.read}`)
      .query({ 'identifier_eq': self.identifier })
      .expect(200);

    res.body.should.have.length(0);
  });


  it('DELETE of not existing document is not found', async () => {
    await self.instance.delete(`${self.urlResource}?token=${self.token.delete}`)
      .expect(404);
  });


  it('CREATE new document', async () => {
    await self.instance.post(`${self.urlCol}?token=${self.token.create}`)
      .send(self.docOriginal)
      .expect(201);
  });


  it('READ existing document', async () => {
    let res = await self.instance.get(`${self.urlResource}?token=${self.token.read}`)
      .expect(200);

    res.body.should.containEql(self.docOriginal);
    self.docActual = res.body;

    if (self.historyTimestamp >= self.docActual.srvModified) {
      self.historyTimestamp = self.docActual.srvModified - 1;
    }
  });


  it('SEARCH existing document (found)', async () => {
    let res = await self.instance.get(`${self.urlCol}?token=${self.token.read}`)
      .query({ 'identifier$eq': self.identifier })
      .expect(200);

    res.body.length.should.be.above(0);
    res.body.should.matchAny(value => {
      value.identifier.should.be.eql(self.identifier);
    });
  });


  it('new document in HISTORY', async () => {
    await self.checkHistoryExistence();
  });


  it('UPDATE document', async () => {
    self.docActual.insulin = 0.5;

    await self.instance.put(`${self.urlResource}?token=${self.token.update}`)
      .send(self.docActual)
      .expect(204);

    self.docActual.subject = self.subject.apiUpdate.name;
  });


  it('document changed in HISTORY', async () => {
    await self.checkHistoryExistence();
  }); 

  
  it('document changed in READ', async () => {
    let res = await self.instance.get(`${self.urlResource}?token=${self.token.read}`)
      .expect(200);

    delete self.docActual.srvModified;
    res.body.should.containEql(self.docActual);
    self.docActual = res.body;
  });


  it('PATCH document', async () => {
    self.docActual.carbs = 5;
    self.docActual.insulin = 0.4;

    await self.instance.patch(`${self.urlResource}?token=${self.token.update}`)
      .send({ 'carbs': self.docActual.carbs, 'insulin': self.docActual.insulin })
      .expect(204);
  });


  it('document changed in HISTORY', async () => {
    await self.checkHistoryExistence();
  }); 

  
  it('document changed in READ', async () => {
    let res = await self.instance.get(`${self.urlResource}?token=${self.token.read}`)
      .expect(200);

    delete self.docActual.srvModified;
    res.body.should.containEql(self.docActual);
    self.docActual = res.body;
  });


  it('soft DELETE', async () => {
    await self.instance.delete(`${self.urlResource}?token=${self.token.delete}`)
      .expect(204);
  });


  it('READ of deleted is gone', async () => {
    await self.instance.get(`${self.urlResource}?token=${self.token.read}`)
      .expect(410);
  });



  it('SEARCH of deleted document missing it', async () => {
    let res = await self.instance.get(`${self.urlCol}?token=${self.token.read}`)
      .query({ 'identifier_eq': self.identifier })
      .expect(200);

    res.body.should.have.length(0);
  });
  

  it('document deleted in HISTORY', async () => {
    await self.checkHistoryExistence(value => {
      value.isValid.should.be.eql(false);
    });
  }); 
  

  it('permanent DELETE', async () => {
    await self.instance.delete(`${self.urlResource}?token=${self.token.delete}`)
      .query({ 'permanent': 'true' })
      .expect(204);
  });


  it('READ of permanently deleted is not found', async () => {
    await self.instance.get(`${self.urlResource}?token=${self.token.read}`)
      .expect(404);
  });


  it('document permanently deleted not in HISTORY', async () => {
    let res = await self.instance.get(`${self.urlHistory}/${self.historyTimestamp}?token=${self.token.read}`);

    if (res.status === 200) {
      res.body.should.matchEach(value => {
        value.identifier.should.not.be.eql(self.identifier);
      });
    } else {
      res.status.should.equal(204);
    }
  });

});

