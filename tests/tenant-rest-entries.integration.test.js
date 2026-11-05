'use strict';

const assert = require('node:assert/strict');
const crudHTTP = require('./fixtures/entries-crud-http');
const { optInSuite } = require('./support/opt-in');

const BASE = 1793664000123;
const ID = '000000000000000000000101';
const record = extra => ({ _id: ID, date: BASE, dateString: new Date(BASE).toISOString(),
  sysTime: new Date(BASE).toISOString(), type: 'sgv', sgv: 123, device: 'synthetic', ...extra });
function comparable (value) {
  if (Array.isArray(value)) return value.map(comparable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) =>
    !['srvCreated', 'srvModified'].includes(key)).map(([key, item]) => [key, comparable(item)]));
}

optInSuite(process.env.NS_ENTRIES_CRUD_HTTP_TEST === '1' &&
  !!process.env.NS_TEST_POSTGRES_ADMIN_URI && !!process.env.CUSTOMCONNSTR_mongo,
'NS_ENTRIES_CRUD_HTTP_TEST=1 with disposable PostgreSQL and MongoDB')(
  'legacy entries actual shipping HTTP differential', function () {
    this.timeout(30000);
    const lab = crudHTTP({ legacy: true });
    before(() => lab.open());
    beforeEach(() => lab.seed([record()]));
    after(() => lab.close());

    async function same (method, path, body, status = 200, headers = {}) {
      let reference = lab.legacyReference(method, path);
      let candidate = lab.legacyHttp(method, path);
      if (body !== undefined) { reference = reference.send(body); candidate = candidate.send(body); }
      for (const [key, value] of Object.entries(headers)) {
        reference = reference.set(key, value);
        candidate = candidate.set(key, value);
      }
      const expected = await reference.expect(status);
      const actual = await candidate.expect(status);
      assert.deepEqual(comparable(actual.body), comparable(expected.body));
      if (!Object.keys(actual.body).length) assert.equal(actual.text, expected.text);
      assert.equal(actual.headers['content-type'], expected.headers['content-type']);
      assert.equal(actual.headers['last-modified'], expected.headers['last-modified']);
      return actual;
    }

    it('serves v1 and inherited v2 default/current/model/id/missing and exact query/count semantics', async function () {
      for (const version of [1, 2]) {
        for (const path of ['/entries', '/entries/current', '/entries/sgv', '/entries/' + ID,
          '/entries/000000000000000000000999', '/entries?find[sgv][$gte]=120&count=1',
          '/entries?find[sgv][$gte]=999',
          '/entries?count=0', '/entries?count=1%3Fsynthetic', '/entries?count=invalid',
          '/count/entries/where?find[sgv][$gte]=120', '/echo/entries/sgv?find[date][$gte]=' + BASE]) {
          await same('get', '/api/v' + version + path, undefined, path.includes('invalid') ? 400 : 200);
        }
      }
    });

    it('keeps overlapping tenant IDs, runtime caches and events local across versions', async function () {
      for (const version of [1, 2]) {
        const first = await lab.legacyHttp('get', '/api/v' + version + '/entries').expect(200);
        const second = await lab.legacyHttp('get', '/api/v' + version + '/entries',
          { tenant: lab.B, credential: lab.credentials[1] }).expect(200);
        assert.equal(first.body[0].sgv, 123);
        assert.equal(second.body[0].sgv, 902);
      }
      await lab.legacyHttp('post', '/api/v1/entries').send(record({ sgv: 124 })).expect(200);
      assert.equal((await lab.rows(lab.B))[0].sgv, 902);
      assert.ok(lab.workers[0].events.every(event => event.tenant === lab.A));
      const read = await lab.legacyHttp('get', '/api/v2/entries').expect(200);
      assert.equal(read.body[0].sgv, 124);
    });

    it('preserves negotiated formats, explicit HEAD and automatic OPTIONS', async function () {
      for (const version of [1, 2]) {
        for (const suffix of ['json', 'csv', 'txt', 'tsv']) await same('get', '/api/v' + version + '/entries.' + suffix);
        await same('head', '/api/v' + version + '/entries');
        const result = await same('options', '/api/v' + version + '/entries');
        assert.match(result.headers.allow, /GET/);
        assert.match(result.headers.allow, /POST/);
        assert.match(result.headers.allow, /DELETE/);
      }
    });

    it('translates bounded literal time/slice patterns and brace expansions without broad regex admission', async function () {
      await lab.seed([record(), record({ _id: '000000000000000000000102', date: BASE + 3600000,
        dateString: new Date(BASE + 3600000).toISOString(), sysTime: new Date(BASE + 3600000).toISOString() })]);
      for (const version of [1, 2]) {
        await same('get', '/api/v' + version + '/times/2026-11-03/T00:00');
        await same('get', '/api/v' + version + '/times/echo/2026-11-03/T00:00');
        await same('get', '/api/v' + version + '/slice/entries/dateString/sgv/2026-11-03/T0%7B0..1%7D:00');
      }
    });

    it('posts objects, arrays and resends with shipping per-item results and cross-version history visibility', async function () {
      await lab.seed([]);
      const first = record({ unknown: { nested: [1, null] } });
      await same('post', '/api/v1/entries', first);
      await same('post', '/api/v2/entries?results=items', [first, record({ _id: '000000000000000000000102',
        date: BASE + 1000, dateString: new Date(BASE + 1000).toISOString(),
        sysTime: new Date(BASE + 1000).toISOString(), sgv: 124 })]);
      const read = await lab.http('get', '/entries?sort=date').expect(200);
      assert.equal(read.body.result.length, 2);
      assert.deepEqual(read.body.result.find(doc => doc.sgv === 123).unknown, { nested: [1, null] });
      const history = await lab.http('get', '/entries/history/' + (BASE - 1)).expect(200);
      assert.equal(history.body.result.length, 2);
      assert.ok(history.body.result.every(doc => doc.srvModified > BASE));
      assert.equal((await lab.rows(lab.B)).length, 0);
    });

    it('keeps preview dry, supports filtered DELETE and retains shipping missing-ID behavior', async function () {
      const before = await lab.rows();
      await same('post', '/api/v1/entries/preview', record({ _id: '000000000000000000000103' }));
      assert.deepEqual(await lab.rows(), before);
      assert.deepEqual(lab.workers[0].events, []);
      await same('delete', '/api/v2/entries?find[sgv][$gte]=120');
      assert.deepEqual(await lab.rows(), []);
      await same('delete', '/api/v1/entries/' + ID);
      assert.equal((await lab.rows(lab.B)).length, 1);
    });

    it('consumes body credentials before writes and rechecks revocation, exact name and foreign credentials', async function () {
      const response = await lab.legacyHttp('post', '/api/v2/entries', { credential: null })
        .send([{ ...record(), secret: lab.credentials[0] }]).expect(200);
      assert.equal(response.body[0].secret, undefined);
      assert.equal((await lab.rows())[0].secret, undefined);
      await lab.legacyHttp('post', '/api/v1/entries', { credential: lab.credentials[1] }).send(record()).expect(401);
      await lab.displayName(null);
      await lab.legacyHttp('post', '/api/v1/entries').send(record()).expect(401);
      await lab.displayName('Current Exact Name');
      await lab.grants(['api:entries:read']);
      await lab.legacyHttp('post', '/api/v1/entries').send(record()).expect(401);
      await lab.legacyHttp('put', '/api/v1/entries').send(record()).expect(405);
      await lab.legacyHttp('patch', '/api/v2/entries/' + ID).send({ sgv: 125 }).expect(405);
    });
  });
