'use strict';
const assert = require('node:assert/strict');
const scope = require('../lib/storage/tenant-scope');
const { fromMongo } = require('../lib/storage/filter');
const { optInSuite } = require('./support/opt-in');
const fixture = require('./fixtures/tenant-rest-settings-differential');

// Actual generic handlers, current persisted authority, Mongo driver and PG RLS.
// Synthetic client-pattern replay; no client binary or shared revision claim.
optInSuite(process.env.NS_SETTINGS_DIFFERENTIAL_TEST === '1' &&
  !!process.env.NS_TEST_POSTGRES_ADMIN_URI && !!process.env.CUSTOMCONNSTR_mongo &&
  !!process.env.NS_SETTINGS_VAULT_ADDRESS && !!process.env.NS_SETTINGS_VAULT_TOKEN,
'NS_SETTINGS_DIFFERENTIAL_TEST=1 with owned PostgreSQL, MongoDB and Vault')(
  'settings actual single/Mongo and tenant/PostgreSQL differential', function () {
    this.timeout(60000);
    const f = fixture();
    const doc = () => ({ _id: new f.ObjectId(f.ID), identifier: 'synthetic-client', app: 'synthetic', date: f.BASE, utcOffset: 0,
      srvCreated: f.BASE, srvModified: f.BASE, isValid: true, rank: 2,
      extension: { secret: 'synthetic-private', visible: 2, removed: true },
      markup: '<b>client settings retained verbatim</b>' });
    const clean = docs => JSON.parse(JSON.stringify(docs)).map(({ _id, srvCreated, srvModified, ...rest }) => rest);
    const persistedSame = async () => assert.deepEqual(clean(await f.rows('settings')), clean(await f.mongoRows()));

    it('reads addressed settings verbatim and agrees on missing identity', async function () {
      await f.seed('settings', [doc()]);
      const response = await f.same('get', '/api/v3/settings/synthetic-client');
      assert.equal(response.body.result.markup, doc().markup);
      await f.same('get', '/api/v3/settings/not-present', undefined, 404);
      await persistedSame();
    });

    it('replaces patches and deletes persisted settings while foreign tenant remains unchanged', async function () {
      await f.seed('settings', [doc()]);
      const before = await f.rows('settings', f.B);
      await f.same('put', '/api/v3/settings/synthetic-client', { app: 'synthetic', date: f.BASE, utcOffset: 0, rank: 3,
        extension: { removed: true, retained: [null, false, { option: 'value' }] } });
      await persistedSame();
      assert.equal((await f.rows('settings'))[0].markup, undefined);
      await f.same('patch', '/api/v3/settings/synthetic-client', { extension: { removed: null, added: 7 } });
      await persistedSame();
      assert.deepEqual((await f.rows('settings'))[0].extension,
        { retained: [null, false, { option: 'value' }], added: 7 });
      await f.same('delete', '/api/v3/settings/synthetic-client');
      await persistedSame();
      assert.equal((await f.rows('settings'))[0].isValid, false);
      const history = await f.same('get', '/api/v3/settings/history/' + (f.BASE - 1));
      assert.equal(history.body.result[0].isValid, false);
      await f.same('get', '/api/v3/settings/synthetic-client', undefined, 410);
      await f.same('delete', '/api/v3/settings/synthetic-client?permanent=true');
      assert.deepEqual(await f.rows('settings'), []);
      assert.deepEqual(await f.rows('settings', f.B), before);
    });

    it('applies scalar predicate to exact selected row with distractor present', async function () {
      await f.seed('settings', [doc(), { ...doc(), _id: new f.ObjectId('65a1b2c3d4e5f60718293a4c'),
        identifier: 'synthetic-distractor', rank: 9 }]);
      const result = await f.same('get', '/api/v3/settings?rank$eq=2&sort=identifier&limit=10');
      assert.deepEqual(result.body.result.map(row => row.identifier), ['synthetic-client']);
      await f.same('get', '/api/v3/settings?rank$gte=2&sort$desc=identifier&skip=1&limit=1');
    });

    // The original pre-fix vector returned Mongo200/PG500 with five sort keys.
    // Keep the exact vector as a regression and retain every stable tie-breaker.
    it('admits requested scalar sort with all stable tie-breakers', async function () {
      await f.seed('settings', [doc(), { ...doc(), _id: new f.ObjectId('65a1b2c3d4e5f60718293a4c'),
        identifier: 'synthetic-distractor', rank: 9 }]);
      const actual = await f.same('get', '/api/v3/settings?sort=rank');
      assert.deepEqual(actual.body.result.map(row => row.rank), [2, 9]);
      assert.deepEqual(f.workers[0].sorts.at(-1), { rank: 1, identifier: 1, created_at: 1, date: 1, _id: 1 });
      const page = await f.same('get', '/api/v3/settings?sort$desc=rank&skip=1&limit=1');
      assert.deepEqual(page.body.result.map(row => row.rank), [2]);
    });

    it('checks projection at actual storage port before renderer pruning', async function () {
      await f.seed('settings', [doc()]);
      const rows = await scope.withTenant(f.A, () => f.storage().findMany({ filter: [],
        sort: { identifier: 1 }, limit: 10, skip: 0, projection: { 'extension.visible': 1 } }));
      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0].extension, { visible: 2 });
      assert.equal(rows[0].markup, undefined);
      assert.equal(rows[0].rank, undefined);
      await assert.rejects(scope.withTenant(f.A, () => f.storage().findMany({ filter: [],
        sort: { identifier: 1 }, limit: 10, skip: 0, projection: { markup: 0 } })), /projection/);
      await f.same('get', '/api/v3/settings?fields=identifier,extension.visible');
    });

    it('uses current persisted legacy grants on subsequent requests', async function () {
      await f.seed('settings', [doc()]);
      await f.same('get', '/api/v3/settings');
      await f.grants(['api:settings:read']);
      await f.http('get', '/api/v3/settings').expect(403);
      await f.same('get', '/api/v3/settings/synthetic-client');
      const before = await f.rows('settings');
      await f.http('patch', '/api/v3/settings/synthetic-client').send({ rank: 10 }).expect(403);
      assert.deepEqual(await f.rows('settings'), before);
    });

    it('creates settings and reopens persisted options through a separate worker', async function () {
      const before = await f.rows('settings', f.B);
      await f.same('post', '/api/v3/settings', { identifier: 'synthetic-new', app: 'synthetic',
        date: f.BASE, utcOffset: 0, extension: { unknown: [1, null, false] } }, 201);
      await persistedSame();
      const worker = await f.makeWorker();
      const reopened = await f.http('get', '/api/v3/settings/synthetic-new', { worker }).expect(200);
      assert.deepEqual(reopened.body.result.extension, { unknown: [1, null, false] });
      assert.deepEqual(await f.rows('settings', f.B), before);
    });

    it('preserves typed raw identities and matching shown identity', async function () {
      const object = { ...doc(), rank: 1 }, string = { ...doc(), _id: f.ID, rank: 2 };
      delete object.identifier;
      delete string.identifier;
      await f.seed('settings', [object, string]);
      const addressed = await f.same('get', '/api/v3/settings/' + f.ID);
      assert.equal(addressed.body.result.rank, 1);
      const listed = await f.same('get', '/api/v3/settings?sort=identifier');
      assert.equal(listed.body.result.length, 2);
      assert.deepEqual(listed.body.result.map(row => row.identifier), [f.ID, f.ID]);
      const raw = await f.mongoRows();
      assert.equal(raw.filter(row => typeof row._id === 'string').length, 1);
      assert.equal(raw.filter(row => row._id instanceof f.ObjectId).length, 1);
      assert.equal((await f.rows('settings')).length, 2);
    });

    it('characterizes regex and dotted predicates as explicit PG refusals', async function () {
      await f.seed('settings', [doc()]);
      for (const query of ['identifier$re=synthetic', 'extension.visible$eq=2']) {
        const expected = await f.reference('get', '/api/v3/settings?' + query).expect(200);
        assert.equal(expected.body.result.length, 1);
        const actual = await f.http('get', '/api/v3/settings?' + query).expect(500);
        assert.deepEqual(actual.body, { status: 500, message: 'Database error' });
      }
    });

    it('refuses nested cross-binding writes and preserves both tenants', async function () {
      await f.seed('settings', [doc()]);
      const beforeA = await f.rows('settings'), beforeB = await f.rows('settings', f.B);
      await assert.rejects(scope.withTenant(f.A, () => f.workers[0].connection.transaction(async () =>
        scope.withTenant(f.B, () => f.storage().updateMany(fromMongo({ identifier: 'synthetic-client' }),
          { set: { rank: 99 } })))), /cannot rebind|belongs to another tenant/);
      assert.deepEqual(await f.rows('settings'), beforeA);
      assert.deepEqual(await f.rows('settings', f.B), beforeB);
    });

    it('maps actual connection unavailability and failed commit without persistence', async function () {
      await f.seed('settings', [doc()]);
      const beforeA = await f.rows('settings'), beforeB = await f.rows('settings', f.B);
      f.setStorageFault('ECONNRESET');
      const unavailable = await f.http('get', '/api/v3/settings/synthetic-client').expect(503);
      assert.deepEqual(unavailable.body, { error: 'STORAGE_UNAVAILABLE' });
      f.setStorageFault(undefined);
      f.setWriteFault(true);
      await f.http('patch', '/api/v3/settings/synthetic-client').send({ rank: 99 }).expect(500);
      f.setWriteFault(false);
      assert.deepEqual(await f.rows('settings'), beforeA);
      assert.deepEqual(await f.rows('settings', f.B), beforeB);
      await f.same('get', '/api/v3/settings/synthetic-client');
    });

    it('refuses malformed query and immutable client identity consistently', async function () {
      await f.seed('settings', [doc()]);
      await f.same('get', '/api/v3/settings?limit=0x10', undefined, 400);
      await f.same('get', '/api/v3/settings?rank$unknown=2', undefined, 400);
      await f.same('patch', '/api/v3/settings/synthetic-client', { _id: 'client-supplied' }, 400);
      await f.same('patch', '/api/v3/settings/synthetic-client', {}, 400);
      await persistedSame();
    });
  });
