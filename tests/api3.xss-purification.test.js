/* eslint require-atomic-updates: 0 */
'use strict';

require('should');

describe('API3 write path purification (Stored XSS regression)', function() {
  const self = this
    , testConst = require('./fixtures/api3/const.json')
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    , opTools = require('../lib/api3/shared/operationTools')
    , utils = require('./fixtures/api3/utils')
    ;

  const XSS_PAYLOAD = '<img src=x onerror=alert(document.domain)>';
  const SCRIPT_PAYLOAD = '<script>alert(1)</script>attacker';

  self.timeout(20000);

  function treatmentDoc (suffix) {
    const doc = {
      date: (new Date()).getTime(),
      app: testConst.TEST_APP,
      device: testConst.TEST_DEVICE + ' API3 XSS ' + suffix,
      eventType: 'Note',
      notes: 'clean'
    };
    doc.identifier = opTools.calculateIdentifier(doc);
    return doc;
  }

  async function get (col, identifier) {
    let res = await self.instance.get(`/api/v3/${col}/${identifier}`, self.jwt.read)
      .expect(200);

    res.body.status.should.equal(200);
    return res.body.result;
  }

  before(async () => {
    self.instance = await instance.create({});

    let authResult = await authSubject(self.instance.ctx.authorization.storage, [
      'create',
      'update',
      'read',
      'all'
    ], self.instance.app);

    self.jwt = authResult.jwt;
  });

  after(async () => {
    await utils.storageClear(self.instance.ctx);
    self.instance.ctx.bus.teardown();
  });

  it('sanitizes malicious HTML when creating a treatment', async () => {
    const doc = Object.assign(treatmentDoc('create'), {
      notes: XSS_PAYLOAD,
      enteredBy: SCRIPT_PAYLOAD
    });

    let res = await self.instance.post('/api/v3/treatments', self.jwt.create)
      .send(doc)
      .expect(201);

    res.body.status.should.equal(201);

    const stored = await get('treatments', doc.identifier);
    stored.notes.should.not.containEql('onerror');
    stored.enteredBy.should.not.containEql('<script>');
    stored.enteredBy.should.containEql('attacker');
  });

  it('sanitizes malicious HTML when replacing a treatment', async () => {
    const doc = treatmentDoc('replace');

    let res = await self.instance.post('/api/v3/treatments', self.jwt.create)
      .send(doc)
      .expect(201);

    res.body.status.should.equal(201);

    const replacement = Object.assign({}, doc, {
      notes: XSS_PAYLOAD,
      enteredBy: SCRIPT_PAYLOAD
    });

    res = await self.instance.put(`/api/v3/treatments/${doc.identifier}`, self.jwt.update)
      .send(replacement)
      .expect(200);

    res.body.status.should.equal(200);

    const stored = await get('treatments', doc.identifier);
    stored.notes.should.not.containEql('onerror');
    stored.enteredBy.should.not.containEql('<script>');
    stored.enteredBy.should.containEql('attacker');
  });

  it('sanitizes malicious HTML when upserting a treatment through PUT', async () => {
    const doc = Object.assign(treatmentDoc('upsert'), {
      notes: XSS_PAYLOAD,
      enteredBy: SCRIPT_PAYLOAD
    });

    let res = await self.instance.put(`/api/v3/treatments/${doc.identifier}`, self.jwt.all)
      .send(doc)
      .expect(201);

    res.body.status.should.equal(201);

    const stored = await get('treatments', doc.identifier);
    stored.notes.should.not.containEql('onerror');
    stored.enteredBy.should.not.containEql('<script>');
    stored.enteredBy.should.containEql('attacker');
  });

  it('sanitizes malicious HTML when patching a treatment', async () => {
    const doc = treatmentDoc('patch');

    let res = await self.instance.post('/api/v3/treatments', self.jwt.create)
      .send(doc)
      .expect(201);

    res.body.status.should.equal(201);

    res = await self.instance.patch(`/api/v3/treatments/${doc.identifier}`, self.jwt.update)
      .send({
        notes: XSS_PAYLOAD,
        enteredBy: SCRIPT_PAYLOAD
      })
      .expect(200);

    res.body.status.should.equal(200);

    const stored = await get('treatments', doc.identifier);
    stored.notes.should.not.containEql('onerror');
    stored.enteredBy.should.not.containEql('<script>');
    stored.enteredBy.should.containEql('attacker');
  });

  it('sanitizes malicious HTML in other API3 data collections', async () => {
    const doc = {
      date: (new Date()).getTime(),
      app: testConst.TEST_APP,
      device: testConst.TEST_DEVICE + ' API3 XSS entries',
      type: 'mbg',
      mbg: 100,
      notes: XSS_PAYLOAD
    };
    doc.identifier = opTools.calculateIdentifier(doc);

    let res = await self.instance.post('/api/v3/entries', self.jwt.create)
      .send(doc)
      .expect(201);

    res.body.status.should.equal(201);

    const stored = await get('entries', doc.identifier);
    stored.notes.should.not.containEql('onerror');
  });
});
