'use strict';

const assert = require('node:assert/strict');
const { ObjectId } = require('mongodb');
const { setTimeout: delay } = require('node:timers/promises');
const crudHTTP = require('./fixtures/entries-crud-http');
const { optInSuite } = require('./support/opt-in');

const BASE = 1793664000123;
const document = (extra = {}) => ({
  _id: 'same-id', identifier: 'shared-entry', date: BASE, utcOffset: 0,
  type: 'sgv', sgv: 123, app: 'synthetic', srvCreated: BASE, srvModified: BASE,
  nested: { retained: 1, removed: 2 }, omitted: true, ...extra
});
const submitted = (extra = {}) => ({
  identifier: 'shared-entry', date: BASE, utcOffset: 0, type: 'sgv', sgv: 124, app: 'synthetic', ...extra
});
const names = events => events.map(item => item.event);
const noStamps = docs => docs.map(value => {
  const doc = { ...value };
  for (const field of ['srvModified', 'srvCreated', '_id']) delete doc[field];
  return doc;
})
  .sort((a, b) => (a.identifier || '').localeCompare(b.identifier || ''));

optInSuite(process.env.NS_ENTRIES_CRUD_HTTP_TEST === '1' &&
  !!process.env.NS_TEST_POSTGRES_ADMIN_URI && !!process.env.CUSTOMCONNSTR_mongo,
'NS_ENTRIES_CRUD_HTTP_TEST=1 with disposable PostgreSQL and MongoDB')('API3 entries CRUD actual HTTP differential', function () {
  this.timeout(30000);
  const lab = crudHTTP();
  before(() => lab.open());
  beforeEach(() => lab.seed([document()]));
  after(() => lab.close());

  async function same (method, path, body, status, headers = {}) {
    let mongo = lab.reference(method, path);
    let pg = lab.http(method, path);
    for (const [key, value] of Object.entries(headers)) {
      mongo = mongo.set(key, value);
      pg = pg.set(key, value);
    }
    if (body !== undefined) {
      mongo = mongo.send(body);
      pg = pg.send(body);
    }
    const expected = await mongo.expect(status);
    const actual = await pg.expect(status);
    const { lastModified: expectedModified, ...expectedBody } = expected.body;
    const { lastModified: actualModified, ...actualBody } = actual.body;
    assert.deepEqual(actualBody, expectedBody);
    assert.equal(typeof actualModified, typeof expectedModified);
    assert.equal(actual.headers.location, expected.headers.location);
    const stored = await lab.rows();
    const reference = await lab.mongoCollection.find({}).sort({ _id: 1 }).toArray();
    assert.deepEqual(noStamps(stored), noStamps(reference));
    assert.deepEqual(names(lab.workers[0].events), names(lab.mongoEvents));
    assert.ok((await lab.rows(lab.B)).every(doc => doc.sgv === 902), 'other tenant unchanged');
    return { actual, expected, stored };
  }

  it('PATCH merges unknown JSON, purifies, stamps current attribution and commits before local notifications', async function () {
    await lab.displayName('Refreshed Exact Name');
    lab.mongoName = 'Refreshed Exact Name';
    const result = await same('patch', '/entries/shared-entry', {
      sgv: 124, omitted: null, nested: { removed: null, added: 3, 'literal.dot': 'kept' },
      'extension-key': { 'ユニコード': [null, false] }, notes: '<unknown>synthetic</unknown>'
    }, 200);
    const [stored] = result.stored;
    assert.equal(stored.modifiedBy, 'Refreshed Exact Name');
    assert.equal(stored.subject, undefined);
    assert.deepEqual(stored.nested, { retained: 1, added: 3, 'literal.dot': 'kept' });
    assert.equal(Object.hasOwn(stored, 'omitted'), false);
    assert.equal(stored.notes, 'synthetic');
    assert.equal(stored.srvCreated, BASE);
    assert.ok(stored.srvModified > BASE);
    assert.equal(result.actual.headers['last-modified'], new Date(stored.srvModified).toUTCString());
    assert.deepEqual(result.actual.body, { status: 200 });
    assert.deepEqual(names(lab.workers[0].events),
      ['storage-intent-committed', 'storage-socket-update', 'data-received']);
    for (const visible of await Promise.all(lab.workers[0].visible)) assert.equal(visible[0].sgv, 124);
    const read = await lab.http('get', '/entries/shared-entry', { worker: 1 }).expect(200);
    assert.equal(read.body.result.sgv, 124);
  });

  it('PUT replaces on match and creates on miss using the exact branch grant and shipping response headers', async function () {
    await lab.grants(['api:entries:create']);
    lab.mongoGrants = ['api:entries:create'];
    await same('put', '/entries/shared-entry', submitted(), 403);
    await lab.grants(['api:entries:update']);
    lab.mongoGrants = ['api:entries:update'];
    await same('put', '/entries/new-entry', submitted({ identifier: 'new-entry', date: BASE + 1 }), 403);
    const replaced = await same('put', '/entries/shared-entry', submitted({ unknown: [1, null] }), 200);
    assert.equal(replaced.stored[0].omitted, undefined);
    assert.equal(replaced.stored[0].subject, 'Current Exact Name');
    assert.equal(replaced.stored[0].srvCreated, BASE);
    assert.equal(replaced.actual.headers['last-modified'], new Date(replaced.stored[0].srvModified).toUTCString());
    await lab.grants(['api:entries:create']);
    lab.mongoGrants = ['api:entries:create'];
    const created = await same('put', '/entries/new-entry', submitted({ identifier: 'ignored-body', date: BASE + 1 }), 201);
    assert.equal(created.actual.headers.location, '/api/v3/entries/new-entry');
    assert.equal(created.actual.body.identifier, 'new-entry');
  });

  it('PATCH and PUT preserve missing, deleted, read-only, immutable and conditional responses without mutation', async function () {
    for (const method of ['patch', 'put']) {
      for (const [stored, body, headers, status] of [
        [document({ isValid: false }), method === 'patch' ? { sgv: 124 } : submitted(), {}, 410],
        [document({ readOnly: true }), method === 'patch' ? { sgv: 124 } : submitted(), {}, 422],
        [document(), { ...submitted(), _id: 'not-allowed' }, {}, 400],
        [document(), { ...submitted(), date: BASE + 1 }, {}, 400],
        [document(), submitted(), { 'If-Unmodified-Since': new Date(BASE - 1000).toUTCString() }, 412]
      ]) {
        await lab.seed([stored]);
        const before = await lab.rows();
        await same(method, '/entries/shared-entry', body, status, headers);
        assert.deepEqual(await lab.rows(), before);
        assert.deepEqual(lab.workers[0].events, []);
      }
      await lab.seed([document()]);
      await same(method, '/entries/shared-entry', method === 'patch' ? { sgv: 124 } : submitted(), 200,
        { 'If-Unmodified-Since': new Date(BASE).toUTCString() });
      await lab.seed([document()]);
      await same(method, '/entries/shared-entry', method === 'patch' ? { sgv: 124 } : submitted(), 200,
        { 'If-Unmodified-Since': 'invalid-date' });
    }
    await lab.seed([document()]);
    await same('patch', '/entries/missing', { sgv: 124 }, 404);
    await same('patch', '/entries/shared-entry', {}, 400);
    await lab.reference('patch', '/entries').send({ sgv: 124 }).expect(404);
    await lab.http('patch', '/entries').send({ sgv: 124 }).expect(405);
    await lab.reference('delete', '/entries').expect(404);
    await lab.http('delete', '/entries').expect(405);
  });

  it('PATCH detects held identifier conflicts before immutable refusal', async function () {
    await lab.seed([document(), document({ _id: 'second', identifier: 'held-entry' })]);
    const before = await lab.rows();
    await same('patch', '/entries/shared-entry', { identifier: 'held-entry' }, 409);
    await same('patch', '/entries/shared-entry', { identifier: 'unheld-entry' }, 400);
    assert.deepEqual(await lab.rows(), before);
    assert.deepEqual(lab.workers[0].events, []);
  });

  it('DELETE marks all identifier forms, exposes tombstones in history, then permanently removes them', async function () {
    const hex = '65a1b2c3d4e5f60718293a4b';
    await lab.seed([
      document({ _id: 'holder', identifier: hex }),
      document({ _id: hex, identifier: undefined }),
      document({ _id: new ObjectId(hex), identifier: undefined })
    ].map(doc => Object.fromEntries(Object.entries(doc).filter(([, value]) => value !== undefined))));
    const marked = await same('delete', '/entries/' + hex, undefined, 200);
    assert.equal(marked.stored.length, 3);
    assert.ok(marked.stored.every(doc => doc.isValid === false && doc.srvModified > BASE &&
      doc.modifiedBy === 'Current Exact Name'));
    assert.deepEqual(marked.actual.body, { status: 200 });
    assert.equal(marked.actual.headers['last-modified'], undefined);
    assert.deepEqual(names(lab.workers[0].events),
      ['storage-intent-committed', 'storage-socket-delete', 'data-received']);
    await lab.http('get', '/entries/' + hex, { worker: 1 }).expect(410);
    const history = await lab.http('get', '/entries/history/' + BASE, { worker: 1 }).expect(200);
    assert.equal(history.body.result.length, 3);
    assert.ok(history.body.result.every(doc => doc.isValid === false));
    const max = Math.max(...marked.stored.map(doc => doc.srvModified));
    assert.equal(history.headers.etag, 'W/"' + max + '"');
    assert.equal(history.headers['last-modified'], new Date(max).toUTCString());
    await same('delete', '/entries/' + hex + '?permanent=true', undefined, 200);
    assert.deepEqual(await lab.rows(), []);
    assert.deepEqual((await lab.http('get', '/entries/history/' + BASE).expect(200)).body.result, []);
    await same('delete', '/entries/' + hex, undefined, 404);
  });

  it('DELETE preserves read-only refusal and ignores If-Unmodified-Since as shipping does', async function () {
    await lab.seed([document({ isReadOnly: true })]);
    const before = await lab.rows();
    await same('delete', '/entries/shared-entry', undefined, 422);
    await same('delete', '/entries/shared-entry?permanent=true', undefined, 422);
    assert.deepEqual(await lab.rows(), before);
    await lab.seed([document()]);
    await same('delete', '/entries/shared-entry', undefined, 200, { 'If-Unmodified-Since': new Date(0).toUTCString() });
  });

  it('history preserves strict URL and seconds-floor inclusive header boundaries, projection and read authority', async function () {
    await lab.seed([document(), document({ _id: 'newer', identifier: 'newer-entry', srvModified: BASE + 1001 })]);
    for (const path of ['/entries/history/' + BASE, '/entries/history?fields=identifier,srvModified']) {
      const headers = { 'Last-Modified': new Date(BASE).toUTCString() };
      const mongo = await lab.reference('get', path).set(headers).expect(200);
      const pg = await lab.http('get', path, { worker: 1 }).set(headers).expect(200);
      assert.deepEqual(pg.body, mongo.body);
      assert.equal(pg.headers.etag, mongo.headers.etag);
      assert.equal(pg.headers['last-modified'], mongo.headers['last-modified']);
      assert.equal(pg.body.result.length, path.includes('?') ? 2 : 1);
    }
    await lab.displayName(null);
    await lab.http('get', '/entries/history/' + BASE).expect(200);
    await lab.grants([]);
    await lab.http('get', '/entries/history/' + BASE).expect(403);
    await lab.grants(lab.GRANTS);
    await same('get', '/entries/history', undefined, 400);
    await same('get', '/entries/history/not-a-date', undefined, 400);
  });

  it('refuses cross-tenant credentials, revoked current grants and anonymous mutations on both workers', async function () {
    const before = await lab.rows();
    const foreign = await lab.rows(lab.B);
    for (const method of ['patch', 'put', 'delete']) {
      await lab.grants(lab.GRANTS);
      for (const worker of [0, 1]) {
        const body = method === 'patch' ? { sgv: 124 } : submitted();
        await lab.http(method, '/entries/shared-entry', { worker, tenant: lab.B }).send(body).expect(401);
        await lab.http(method, '/entries/shared-entry', { worker, credential: null }).send(body).expect(403);
      }
      await lab.grants(['api:entries:read']);
      await lab.http(method, '/entries/shared-entry', { worker: 1 }).send(submitted()).expect(403);
    }
    assert.deepEqual(await lab.rows(), before);
    assert.deepEqual(await lab.rows(lab.B), foreign);
    assert.ok(lab.workers.every(worker => !worker.events.length));
    await lab.grants(lab.GRANTS, lab.B);
    await lab.http('patch', '/entries/shared-entry', { worker: 1, tenant: lab.B, credential: lab.credentials[1] })
      .send({ sgv: 903 }).expect(200);
    assert.equal((await lab.rows(lab.B))[0].sgv, 903);
    assert.deepEqual(await lab.rows(), before);
  });

  it('each mutation needs the exact current subject name; outages are 503 and root invents no subject', async function () {
    for (const method of ['patch', 'put', 'delete']) {
      await lab.seed([document()]);
      const before = await lab.rows();
      await lab.displayName(null);
      await lab.http(method, '/entries/shared-entry').send(method === 'patch' ? { sgv: 124 } : submitted()).expect(401);
      assert.deepEqual(await lab.rows(), before);
      const authority = lab.workers[0].authority;
      const original = authority.subjectSnapshot;
      authority.subjectSnapshot = async () => { throw new Error('synthetic metadata outage'); };
      try {
        await lab.http(method, '/entries/shared-entry').send(submitted()).expect(503);
        assert.deepEqual(await lab.rows(), before);
      } finally { authority.subjectSnapshot = original; }
      await lab.http(method, '/entries/shared-entry', { credential: lab.rootCredentials[0] })
        .send(method === 'patch' ? { sgv: 124 } : submitted()).expect(200);
      const [stored] = await lab.rows();
      assert.equal(stored.subject, undefined);
      assert.equal(stored.modifiedBy, undefined);
    }
  });

  it('refuses only marked nonrepresentable submissions as 400, preserving storage/internal failures as 500', async function () {
    for (const method of ['patch', 'put']) {
      for (const extra of [{ 'top.level': 1 }, { '$operator': 1 }, { text: '\0' }, { text: '\ud800' }]) {
        const before = await lab.rows();
        await lab.http(method, '/entries/shared-entry').send(method === 'patch' ? extra : submitted(extra)).expect(400);
        assert.deepEqual(await lab.rows(), before);
        assert.deepEqual(lab.workers[0].events, []);
      }
    }
    // Mongo interprets top-level dotted updates as paths; PG refuses them.
    await lab.reference('patch', '/entries/shared-entry').send({ 'top.level': 1 }).expect(200);
    assert.deepEqual((await lab.mongoCollection.findOne({})).top, { level: 1 });
    const col = lab.workers[0].collections.get(lab.A);
    const original = col.intentFactory;
    for (const [error, status] of [
      [Object.assign(new TypeError('stored unsupported shape'), { unsupported: true }), 500],
      [Object.assign(new Error('synthetic unavailable'), { code: 'ECONNRESET' }), 503]
    ]) {
      col.intentFactory = () => ({ ...original(), match: async () => { throw error; } });
      try {
        await lab.http('patch', '/entries/shared-entry').send({ sgv: 124 }).expect(status);
        await lab.http('put', '/entries/shared-entry').send(submitted()).expect(status);
      } finally { col.intentFactory = original; }
    }
    const connection = lab.workers[0].connection;
    const query = connection.query;
    for (const [error, status] of [
      [Object.assign(new TypeError('stored unsupported history'), { unsupported: true }), 500],
      [Object.assign(new Error('synthetic unavailable'), { code: 'ECONNRESET' }), 503]
    ]) {
      connection.query = async () => { throw error; };
      try {
        await lab.http('delete', '/entries/shared-entry').expect(status);
        await lab.http('get', '/entries/history/' + BASE).expect(status);
      } finally { connection.query = query; }
    }
    assert.deepEqual(lab.workers[0].events, []);
  });

  it('rolls back each actual mutation before commit with no row changes or committed notifications', async function () {
    const connection = lab.workers[0].connection;
    const original = connection.transaction;
    for (const [method, suffix] of [['patch', ''], ['put', ''], ['delete', ''], ['delete', '?permanent=true']]) {
      const before = await lab.rows();
      connection.transaction = operation => original.call(connection, async () => {
        await operation();
        throw new Error('synthetic-after-write-before-commit');
      });
      try {
        await lab.http(method, '/entries/shared-entry' + suffix).send(method === 'patch' ? { sgv: 124 } : submitted()).expect(500);
        assert.deepEqual(await lab.rows(), before);
        assert.deepEqual(lab.workers[0].events, []);
      } finally { connection.transaction = original; }
    }
  });

  it('configured retention following PATCH uses operator policy, not an invented uploader delete grant', async function () {
    const old = document({ _id: 'old-id', identifier: 'old-entry', date: 1, srvCreated: 1, srvModified: 1 });
    const recent = document({ date: Date.now(), srvCreated: Date.now(), srvModified: Date.now() });
    await lab.seed([old, recent]);
    await lab.grants(['api:entries:update']);
    lab.workers[0].collections.get(lab.A).autoPruneDays = 1;
    await lab.http('patch', '/entries/shared-entry').send({ sgv: 124 }).expect(200);
    const deadline = Date.now() + 5000;
    while ((await lab.rows()).some(doc => doc.identifier === 'old-entry')) {
      assert.ok(Date.now() < deadline, 'configured retention completed');
      await delay(20);
    }
    assert.equal((await lab.rows(lab.B)).length, 2);
    assert.equal((await lab.rows())[0].sgv, 124);
    assert.equal(names(lab.workers[0].events).filter(event => event === 'storage-intent-committed').length, 2);
  });
});
