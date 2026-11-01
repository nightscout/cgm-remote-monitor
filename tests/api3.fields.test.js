'use strict';

require('should');

// `uploader.battery` is the canonical nested field in Nightscout and
// `devicestatus` is the collection people query for it, so a dotted `?fields=`
// is an ordinary request. The storage projection understands dotted paths; the
// projection applied afterwards has to understand them too.
describe('API3 FIELDS PROJECTOR', function() {
  const FieldsProjector = require('../lib/api3/shared/fieldsProjector');

  it('keeps a dotted path, and only that path', function() {
    const projector = new FieldsProjector('uploader.battery')
      , doc = {
        identifier: 'abc'
        , uploader: { battery: 80, type: 'phone' }
        , device: 'openaps://hostname'
        , created_at: '2022-09-11T15:00:00.000Z'
      };

    projector.applyProjection(doc);
    doc.should.eql({ uploader: { battery: 80 } });
  });

  it('keeps the whole subtree when the parent itself is requested', function() {
    const projector = new FieldsProjector('uploader')
      , doc = { uploader: { battery: 80, type: 'phone' }, device: 'x' };

    projector.applyProjection(doc);
    doc.should.eql({ uploader: { battery: 80, type: 'phone' } });
  });

  it('projects into the members of an array', function() {
    const projector = new FieldsProjector('foods.name')
      , doc = { foods: [{ name: 'apple', carbs: 12 }, { name: 'pear', carbs: 15 }], device: 'x' };

    projector.applyProjection(doc);
    doc.should.eql({ foods: [{ name: 'apple' }, { name: 'pear' }] });
  });

  it('still answers a plain comma separated list the same way', function() {
    const projector = new FieldsProjector('device,created_at')
      , doc = { device: 'x', created_at: '2022-09-11T15:00:00.000Z', uploader: { battery: 80 } };

    projector.applyProjection(doc);
    doc.should.eql({ device: 'x', created_at: '2022-09-11T15:00:00.000Z' });
  });

  it('drops a dotted path the document does not have', function() {
    const projector = new FieldsProjector('uploader.battery')
      , doc = { device: 'x' };

    projector.applyProjection(doc);
    doc.should.eql({ });
  });
});


describe('API3 FIELDS over HTTP', function() {
  const self = this
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    , utils = require('./fixtures/api3/utils')
    ;

  this.timeout(20000);

  before(async () => {
    self.instance = await instance.create({});

    const authResult = await authSubject(self.instance.ctx.authorization.storage, ['read'], self.instance.app);
    self.subject = authResult.subject;
    self.jwt = authResult.jwt;

    self.col = self.instance.ctx.devicestatus();
    await self.col.deleteMany({ });
    await self.col.insertMany([{
      device: 'fields.test'
      , created_at: '2022-09-11T15:00:00.000Z'
      , date: 1662908400000
      , uploader: { battery: 80, type: 'phone' }
    }]);
  });

  after(async () => {
    await utils.storageClear(self.instance.ctx);
    self.instance.ctx.bus.teardown();
  });

  it('answers ?fields=uploader.battery with the battery, not an empty document', async () => {
    const res = await self.instance.get('/api/v3/devicestatus?fields=uploader.battery', self.jwt.read)
      .expect(200);

    res.body.result.should.have.lengthOf(1);
    res.body.result[0].should.eql({ uploader: { battery: 80 } });
  });
});
