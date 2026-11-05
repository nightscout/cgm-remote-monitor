'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { ObjectId } = require('mongodb');
const { createSecrets } = require('../lib/secrets/component');
const provider = require('./fixtures/tenant-credential-provider');

describe('tenant legacy credentials against shipping authentication', function () {
  let component, enclave, storage, root, subjects, metadata, events, records, unavailable;
  const context = { tenant: 'tenant-a', principal: 'verifier', consumer: 'api' };
  const hash = value => crypto.createHash('sha1').update(value).digest('hex');

  beforeEach(async function () {
    root = crypto.randomBytes(24).toString('hex');
    enclave = require('../lib/server/enclave')();
    enclave.setApiKey(root);
    enclave.setJWTKey(crypto.randomBytes(32).toString('hex'));
    // Shipping storage/lookup, with only its Mongo I/O port replaced.
    const docs = ['Same Display', 'Same Display', '!!!', 'Test_user'].map((name, index) => ({
      _id: new ObjectId((index + 1).toString().padStart(24, '0')), name, roles: []
    }));
    storage = require('../lib/authorization/storage')({
      authentication_collections_prefix: 'auth_', enclave
    }, { store: { collection: () => ({}) }, settings: {}, moment: require('moment'),
      language: { translate: value => value } });
    storage.listRoles = (options, callback) => callback(null, []);
    storage.listSubjects = (options, callback) => callback(null, docs.map(doc => ({ ...doc })));
    await new Promise((resolve, reject) => storage.reload(error => error ? reject(error) : resolve()));
    subjects = storage.subjects;
    metadata = subjects.map(subject => ({
      subjectId: subject._id.toHexString(),
      tokenPrefix: subject.name.toLowerCase().replace(/[\W]/g, '').substring(0, 10)
    }));
    records = new Map();
    events = [];
    unavailable = false;
    const cryptoProvider = provider();
    component = createSecrets({
      providerFor: async () => cryptoProvider,
      store: { async get (tenant, id) { return records.get(tenant + ':' + id); },
        async insert (record) { records.set(record.tenant + ':' + record.id, record); } },
      authorize: async () => true,
      audit: async event => { events.push(event); },
      maxTokenLifetimeSeconds: 28800,
      async legacyAuthorityFor (tenant) {
        if (unavailable) throw new Error('authority unavailable');
        return { reference: { tenant, id: 'imported-root' }, subjects: metadata };
      }
    });
    await component.encrypt(context, 'imported-root', Buffer.from(root));
  });

  it('matches shipping root SHA1/SHA512 and subject token/digest/prefix forms by immutable ID', async function () {
    const rootForms = [hash(root), hash(root).toUpperCase(),
      crypto.createHash('sha512').update(root).digest('hex')];
    for (const apiSecret of rootForms) {
      assert.equal(enclave.isApiKey(apiSecret), true);
      assert.deepEqual(await component.verifyLegacyCredential(context, { apiSecret }), { kind: 'root' });
    }
    for (const subject of subjects) {
      for (const apiSecret of [subject.accessToken, subject.digest, subject.digest.slice(0, 16),
        subject.accessTokenDigest, subject.accessTokenDigest.slice(0, 16),
        'ignored-name-' + subject.digest.slice(0, 16)]) {
        const shipping = storage.findSubject(apiSecret);
        assert.ok(shipping);
        assert.deepEqual(await component.verifyLegacyCredential(context, { apiSecret }),
          { kind: 'subject', subjectId: shipping._id.toHexString() });
      }
    }
    assert.notEqual(subjects[0]._id.toHexString(), subjects[1]._id.toHexString());
    assert.equal(subjects[0].name, subjects[1].name);
    assert.equal(JSON.stringify(events).includes(root), false);
    assert.doesNotMatch(JSON.stringify(events), /accessToken|tokenPrefix/);
  });

  describe('trusted data bridge boundaries', function () {
    const createDataAccess = require('../lib/server/tenant-app/data-access');
    const authentication = require('../lib/api3/tenant-authentication');
    const security = require('../lib/api3/security');

    it('awaits current authority before binding only the exact synchronous read permission', async function () {
      let release, verified = false;
      const ready = new Promise(resolve => { release = resolve; });
      const req = { method: 'GET', path: '/entries/shared', rawHeaders: ['api-secret', 'synthetic'] };
      const access = createDataAccess({
        secrets: { async verifyLegacyCredential () { return { kind: 'subject', subjectId: 'root' }; } },
        verifierContext: async tenant => ({ tenant, principal: 'verifier', consumer: 'api' }),
        authority: { async authorize (input) {
          assert.deepEqual(input, { tenant: 'tenant-a', principal: { kind: 'subject', subjectId: 'root' },
            permission: 'api:entries:read' });
          await ready;
          verified = true;
          return true;
        } }
      });
      const pending = access({ tenant: 'tenant-a', request: req });
      assert.equal(authentication.get(req), undefined);
      release();
      assert.equal((await pending).principal, 'root');
      assert.equal(verified, true);
      const authorization = await security.authenticate({ req });
      assert.equal(security.checkPermission(authorization, 'api:entries:read'), true);
      assert.equal(security.checkPermission(authorization, 'api:entries:create'), false);
      assert.equal(security.checkPermission(authorization, 'api:treatments:read'), false);
      assert.equal(authorization.subject._id, 'root');
      assert.equal(authorization.subject.name, undefined);
    });

    it('refuses duplicate/malformed credential headers and unsupported operations before binding', async function () {
      let verified = 0;
      const access = createDataAccess({
        secrets: { async verifyLegacyCredential () { verified++; return { kind: 'root' }; } },
        verifierContext: async tenant => ({ tenant, principal: 'verifier', consumer: 'api' }),
        authority: { async authorize () { return true; } }
      });
      for (const rawHeaders of [
        ['Authorization', 'Bearer a', 'authorization', 'Bearer b'],
        ['api-secret', 'a', 'Api-Secret', 'b'],
        ['Authorization', 'Bearer a,b'], ['Authorization', 'Basic a']
      ]) {
        const req = { method: 'GET', path: '/entries/shared', rawHeaders, tenantContext: { principal: 'root' } };
        assert.equal(await access({ tenant: 'tenant-a', request: req }), null);
        assert.equal(authentication.get(req), undefined);
      }
      assert.equal(verified, 0);
      for (const [method, path] of [['POST', '/entries/shared'], ['PUT', '/entries'], ['PATCH', '/entries'],
        ['DELETE', '/entries'], ['GET', '/entries/history/one/two']]) {
        await assert.rejects(access({ tenant: 'tenant-a', request: { method, path, rawHeaders: [] } }),
          { code: 'TENANT_DATA_UNSUPPORTED' });
      }
      assert.equal(verified, 0);
    });
  });

  it('keeps invalid supplied values out of anonymous and checks current metadata/reference every time', async function () {
    assert.deepEqual(await component.verifyLegacyCredential(context), { kind: 'anonymous' });
    for (const apiSecret of ['', 'null', 'wrong', root, 'same-display', subjects[0].digest.slice(0, 15)]) {
      assert.equal(await component.verifyLegacyCredential(context, { apiSecret }), null);
    }
    const credential = { apiSecret: subjects[0].accessToken };
    assert.equal((await component.verifyLegacyCredential(context, credential)).kind, 'subject');
    metadata = metadata.slice(1);
    assert.equal(await component.verifyLegacyCredential(context, credential), null);
    records.clear();
    await assert.rejects(component.verifyLegacyCredential(context, { apiSecret: hash(root) }),
      { code: 'SECRETS_NOT_FOUND' });
    unavailable = true;
    await assert.rejects(component.verifyLegacyCredential(context, credential), /authority unavailable/);
  });

  it('maps verified JWT accessToken through current subject metadata, never subject/root claims', async function () {
    const token = await component.signJWT(context, subjects[0].accessToken, 60);
    assert.deepEqual(await component.verifyLegacyCredential(context, { token }),
      { kind: 'subject', subjectId: subjects[0]._id.toHexString() });
    const unknown = await component.signJWT(context, 'root', 60);
    assert.equal(await component.verifyLegacyCredential(context, { token: unknown }), null);
    assert.equal(await component.verifyLegacyCredential(context,
      { token: unknown, apiSecret: subjects[0].accessToken }), null);
    assert.equal(await component.verifyLegacyCredential(context, { token: 'malformed' }), null);
    // Existing single-site JWT keys/envelopes are not assumed portable.
    const single = enclave.signJWT({ accessToken: subjects[0].accessToken });
    assert.equal(await component.verifyLegacyCredential(context, { token: single }), null);
  });

  it('canonicalizes exchange credentials like shipping without exposing root material or adding JWT authority', async function () {
    const shipping = require('../lib/authorization')({
      enclave, settings: { authDefaultRoles: 'readable', authFailDelay: 0 }, trustProxy: false
    }, { store: { collection: () => ({}) }, settings: {}, moment: require('moment'),
      language: { translate: value => value } });
    shipping.storage.subjects = subjects;
    shipping.storage.roles = storage.roles;
    for (const subject of subjects) {
      for (const credential of [subject.accessToken, subject.digest, subject.digest.slice(0, 16),
        subject.accessTokenDigest, subject.accessTokenDigest.slice(0, 16),
        'other-prefix-' + subject.digest.slice(0, 16)]) {
        const expected = shipping.authorize(credential);
        const issued = await component.exchangeLegacyCredential(context, credential, async principal => {
          assert.equal(principal.subjectId, subject._id.toHexString());
          return true;
        });
        const decoded = await component.verifyJWT(context, issued.token);
        assert.equal(decoded.accessToken, enclave.verifyJWT(expected.token).accessToken);
        assert.equal(issued.exp - issued.iat, expected.exp - expected.iat);
        assert.equal(issued.exp - issued.iat, 28800);
        assert.deepEqual(Object.keys(issued).sort(), ['exp', 'iat', 'token']);
        assert.equal((await component.exchangeLegacyCredential(context, issued.token, async () => true)).exp -
          issued.iat, 28800);
      }
    }
    for (const value of [hash(root), root, 'invalid']) {
      assert.equal(await component.exchangeLegacyCredential(context, value, async () => true), null);
      assert.equal(shipping.authorize(value), null);
    }
    assert.equal(await component.exchangeLegacyCredential(context, subjects[0].accessToken, async () => false), null);
    assert.equal(JSON.stringify(events).includes(root), false);
    assert.doesNotMatch(JSON.stringify(events), /accessToken|tokenPrefix/);
  });
});
