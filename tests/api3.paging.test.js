'use strict';

require('should');

// Paging with `skip`/`limit` only returns each document once if the sort order
// is total.  Uploaders write `devicestatus` in bursts that share one
// `created_at` and one `date`, and a bulk import writes no `identifier` at all,
// so the tiebreaks the API appends can all tie at once.  The fixture below is
// built to hit exactly that: no `identifier`, one `created_at`, one `date`.
describe('API3 PAGING over a tied sort chain', function() {
  const self = this
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    ;


  const DOC_COUNT = 12
    , PAGE_SIZE = 3
    , TIED_CREATED_AT = '2022-09-11T15:00:00.000Z'
    , TIED_DATE = 1662908400000
    ;

  this.timeout(20000);

  before(async () => {
    self.instance = await instance.create({});

    const authResult = await authSubject(self.instance.ctx.authorization.storage, ['read'], self.instance.app);
    self.subject = authResult.subject;
    self.jwt = authResult.jwt;

    self.col = self.instance.ctx.devicestatus();
    await self.col.deleteMany({ });

    const docs = [];
    for (let i = 0; i < DOC_COUNT; i++) {
      docs.push({
        device: 'paging.test'
        , marker: 'doc' + i
        , created_at: TIED_CREATED_AT
        , date: TIED_DATE
      });
    }
    await self.col.insertMany(docs);
  });

  after(async () => {
    await require('./fixtures/api3/utils').storageClear(self.instance.ctx);
    self.instance.ctx.bus.teardown();
  });


  function fetchPage (query) {
    return new Promise((resolve, reject) => {
      self.instance.get(`/api/v3/devicestatus?${query}`, self.jwt.read)
        .expect(200)
        .end((err, res) => err ? reject(err) : resolve(res.body.result));
    });
  }

  // The fixture is only evidence if the tie it is built around actually exists.
  it('the fixture really does tie on the whole appended sort chain', async () => {
    const docs = await self.col.find({ device: 'paging.test' }).toArray();
    docs.length.should.equal(DOC_COUNT);
    docs.filter(d => d.identifier === undefined).length.should.equal(DOC_COUNT);
    new Set(docs.map(d => d.created_at)).size.should.equal(1);
    new Set(docs.map(d => d.date)).size.should.equal(1);
  });

  it('returns every document exactly once when paged with the default sort', async () => {
    const seen = new Map();

    for (let skip = 0; skip < DOC_COUNT; skip += PAGE_SIZE) {
      const page = await fetchPage(`limit=${PAGE_SIZE}&skip=${skip}`);
      page.forEach(doc => seen.set(doc.identifier, (seen.get(doc.identifier) || 0) + 1));
    }

    const duplicated = [...seen.entries()].filter(([, n]) => n > 1);
    duplicated.should.have.lengthOf(0);
    seen.size.should.equal(DOC_COUNT);
  });

  it('returns every document exactly once when paged with a client-chosen sort', async () => {
    const seen = new Map();

    for (let skip = 0; skip < DOC_COUNT; skip += PAGE_SIZE) {
      const page = await fetchPage(`sort=device&limit=${PAGE_SIZE}&skip=${skip}`);
      page.forEach(doc => seen.set(doc.identifier, (seen.get(doc.identifier) || 0) + 1));
    }

    const duplicated = [...seen.entries()].filter(([, n]) => n > 1);
    duplicated.should.have.lengthOf(0);
    seen.size.should.equal(DOC_COUNT);
  });
});
