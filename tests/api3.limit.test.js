'use strict';

require('should');

// `?limit=` is v3's document bound, and `API3_MAX_LIMIT` is the ceiling it is
// checked against.  A value that is not a plain number of documents has to be
// refused, not reinterpreted: `parseInt(x, 10)` reads `0x10` as `0`, and a
// MongoDB limit of `0` means *no limit*, so a bounded request would come back
// with the whole collection.
describe('API3 LIMIT', function() {
  const self = this
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    , utils = require('./fixtures/api3/utils')
    ;

  const STORED = 30;

  this.timeout(20000);

  before(async () => {
    self.instance = await instance.create({});

    const authResult = await authSubject(self.instance.ctx.authorization.storage, ['read'], self.instance.app);
    self.subject = authResult.subject;
    self.jwt = authResult.jwt;

    self.col = self.instance.ctx.devicestatus();
    await self.col.deleteMany({ });

    const docs = [];
    for (let i = 0; i < STORED; i++) {
      docs.push({
        device: 'limit.test'
        , created_at: new Date(1662908400000 + i * 1000).toISOString()
        , date: 1662908400000 + i * 1000
      });
    }
    await self.col.insertMany(docs);
  });

  after(async () => {
    await utils.storageClear(self.instance.ctx);
    self.instance.ctx.bus.teardown();
  });

  function search (limit) {
    return self.instance.get('/api/v3/devicestatus?limit=' + encodeURIComponent(limit), self.jwt.read);
  }

  [
    ['zero', '0']
    , ['a negative number', '-3']
    , ['a non-number', 'abc']
    , ['hex notation, which parseInt reads as zero', '0x10']
    , ['exponent notation, which parseInt truncates', '1e2']
    , ['a fraction', '2.5']
  ].forEach(function ([label, value]) {
    it('refuses ' + label + ': limit=' + value, async () => {
      const res = await search(value).expect(400);
      res.body.status.should.equal(400);
    });
  });

  it('returns exactly the number of documents asked for', async () => {
    const res = await search('5').expect(200);
    res.body.result.should.have.lengthOf(5);
  });

  it('never returns more than the ceiling, whatever notation the limit is in', async () => {
    // The ceiling is above 16 on purpose: `0x10` is 16 to the `<= maxLimit`
    // test and 0 to `parseInt(_, 10)`, so it used to pass the ceiling check
    // and then remove the bound completely.
    const maxLimit = 20;
    self.instance.ctx.apiApp.set('API3_MAX_LIMIT', maxLimit);

    try {
      const capped = await search(String(maxLimit)).expect(200);
      capped.body.result.should.have.lengthOf(maxLimit);

      const hex = await search('0x10');
      (hex.body.result ? hex.body.result.length : 0).should.be.belowOrEqual(maxLimit);
      hex.status.should.equal(400);

      const unspecified = await self.instance.get('/api/v3/devicestatus', self.jwt.read).expect(200);
      unspecified.body.result.should.have.lengthOf(maxLimit);
    } finally {
      self.instance.ctx.apiApp.set('API3_MAX_LIMIT', undefined);
    }
  });
});
