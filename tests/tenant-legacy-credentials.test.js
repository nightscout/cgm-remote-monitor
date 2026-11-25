'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { ObjectId } = require('mongodb');
const { createSecrets } = require('../lib/secrets/component');
const provider = require('./fixtures/tenant-credential-provider');
const localCredentials = require('./fixtures/local-data-credentials');

// Shipping parity of the api's DATA verifier (lib/secrets/legacy-verifiers.js,
// one-way verifiers prepared from the root secret) against the shipping
// authorization storage. The Vault-backed component verifier is retired
// (decision deployment-signing-secret); the component keeps root custody,
// issuance and the admin-tools token listings tested here.

describe('tenant legacy credentials against shipping authentication', function () {
  let component, enclave, storage, root, subjects, metadata, events, records, unavailable, docs, clockOffset, authorizations, auditUnavailable, verifyAllowed, componentOptions, local;
  const TENANT = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a', OTHER_TENANT = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
  const context = { tenant: TENANT, principal: 'verifier', consumer: 'api' };
  // The verifier's principal also carries credential and root versions.
  const verify = async (...args) => {
    const principal = await local.verifier.verifyLegacyCredential(...args);
    return principal && principal.kind === 'subject' ? { kind: 'subject', subjectId: principal.subjectId } : principal;
  };
  const prepare = () => local.set(TENANT, { root, subjects: metadata });
  const hash = value => crypto.createHash('sha1').update(value).digest('hex');

  beforeEach(async function () {
    root = crypto.randomBytes(24).toString('hex');
    enclave = require('../lib/server/enclave')();
    enclave.setApiKey(root);
    enclave.setJWTKey(crypto.randomBytes(32).toString('hex'));
    // Shipping storage/lookup, with only its Mongo I/O port replaced.
    docs = ['Same Display', 'Same Display', '!!!', 'Test_user'].map((name, index) => ({
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
    clockOffset = 0; authorizations = []; auditUnavailable = false; verifyAllowed = true;
    const cryptoProvider = provider();
    componentOptions = {
      providerFor: async () => cryptoProvider,
      store: { async get (tenant, id) { return records.get(tenant + ':' + id); },
        async insert (record) { records.set(record.tenant + ':' + record.id, record); } },
      authorize: async (identity, action, hint) => { authorizations.push({ identity, action, hint }); return action.operation !== 'verify' || verifyAllowed; },
      audit: async event => { if (auditUnavailable) throw Error('audit unavailable'); events.push(event); },
      maxTokenLifetimeSeconds: 28800,
      now: () => Date.now() + clockOffset,
      async legacyAuthorityFor (tenant) {
        if (unavailable) throw new Error('authority unavailable');
        return { reference: { tenant, id: 'imported-root' }, subjects: metadata };
      }
    };
    component = createSecrets(componentOptions);
    await component.encrypt(context, 'imported-root', Buffer.from(root));
    local = localCredentials.memory();
    prepare();
  });

  it('lists the shipping admin tools accessToken for every subject only to the tenant root secret', async function () {
    const expected = new Map(subjects.map(subject => [subject._id.toHexString(), subject.accessToken]));
    assert.ok([...expected.values()].every(token => typeof token === 'string' && token.length > 16));
    for (const apiSecret of [hash(root), hash(root).toUpperCase(), crypto.createHash('sha512').update(root).digest('hex')]) {
      assert.deepEqual(await component.rootLegacyTokens(context, { apiSecret }), expected);
    }
    for (const apiSecret of [undefined, '', hash('another-root-secret'), subjects[0].accessToken, 'x'.repeat(8193)]) {
      assert.equal(await component.rootLegacyTokens(context, { apiSecret }), null);
    }
    unavailable = true;
    await assert.rejects(component.rootLegacyTokens(context, { apiSecret: hash(root) }), /authority unavailable/);
  });

  it('lists the same tokens to a current admin-role subject only while its authority check returns true', async function () {
    const expected = new Map(subjects.map(subject => [subject._id.toHexString(), subject.accessToken]));
    const before = events.length;
    assert.deepEqual(await component.adminLegacyTokens(context, async () => true), expected);
    for (const answer of [false, undefined, 'true', 1]) {
      const seen = events.length;
      assert.equal(await component.adminLegacyTokens(context, async () => answer), null);
      assert.equal(events.length, seen, 'no decrypt is authorized or audited when authority is refused');
    }
    assert.ok(events.length > before);
    await assert.rejects(component.adminLegacyTokens(context), TypeError);
  });

  it('matches shipping root SHA1/SHA512 and subject token/digest/prefix forms by immutable ID', async function () {
    const rootForms = [hash(root), hash(root).toUpperCase(),
      crypto.createHash('sha512').update(root).digest('hex')];
    for (const apiSecret of rootForms) {
      assert.equal(enclave.isApiKey(apiSecret), true);
      assert.deepEqual(await verify(context, { apiSecret }), { kind: 'root' });
    }
    for (const subject of subjects) {
      for (const apiSecret of [subject.accessToken, subject.digest, subject.digest.slice(0, 16),
        subject.accessTokenDigest, subject.accessTokenDigest.slice(0, 16),
        'ignored-name-' + subject.digest.slice(0, 16)]) {
        const shipping = storage.findSubject(apiSecret);
        assert.ok(shipping);
        assert.deepEqual(await verify(context, { apiSecret }),
          { kind: 'subject', subjectId: shipping._id.toHexString() });
      }
    }
    assert.notEqual(subjects[0]._id.toHexString(), subjects[1]._id.toHexString());
    assert.equal(subjects[0].name, subjects[1].name);
    // The verifier state holds no usable credential: no root, digest or token.
    const stored = JSON.stringify(local.tenants.get(TENANT));
    assert.equal(stored.includes(root) || stored.includes(hash(root)), false);
    for (const subject of subjects) assert.equal([subject.accessToken, subject.digest, subject.accessTokenDigest].some(value => stored.includes(value)), false);
  });

  async function renameFirstSubject () {
    docs[0].name = 'Renamed Display';
    await new Promise((resolve, reject) => storage.reload(error => error ? reject(error) : resolve()));
    const current = storage.subjects[0];
    metadata[0].tokenPrefix = current.name.toLowerCase().replace(/[\W]/g, '').substring(0, 10);
    // Management re-prepares the subject's verifiers for its new prefix.
    prepare();
    return current;
  }

  it('keeps shipping raw subject suffixes and shipping JWTs valid after a display-prefix rename', async function () {
    const original = { ...subjects[0] };
    const shippingJWT = enclave.signJWT({ accessToken: original.accessToken });
    const current = await renameFirstSubject();
    assert.notEqual(current.accessToken, original.accessToken, 'rename actually changes the displayed prefix');
    assert.equal(current.digest, original.digest, 'suffix derives from immutable identity and root');
    for (const credential of [original.accessToken, current.accessToken, original.digest, original.digest.slice(0, 16)]) {
      assert.equal(storage.findSubject(credential).name, 'Renamed Display');
      assert.deepEqual(await verify(context, { apiSecret: credential }),
        { kind: 'subject', subjectId: original._id.toHexString() });
    }
    // Shipping JWT verification yields the old raw token. Current shipping
    // lookup accepts its immutable suffix, exactly as the tenant bridge does.
    assert.equal(storage.findSubject(enclave.verifyJWT(shippingJWT).accessToken).name, 'Renamed Display');
    const shipping = require('../lib/authorization')({
      enclave, settings: { authDefaultRoles: 'denied', authFailDelay: 0 }, trustProxy: false
    }, { store: { collection: () => ({}) }, settings: {}, moment: require('moment'),
      language: { translate: value => value } });
    shipping.storage.subjects = storage.subjects;
    shipping.storage.roles = storage.roles;
    const exchanged = shipping.authorize(shippingJWT);
    assert.equal(exchanged.sub, 'Renamed Display');
    assert.equal(enclave.verifyJWT(exchanged.token).accessToken, current.accessToken);
  });

  it('retires the shipping full-token hash after a prefix rename while accepting the newly derived hash', async function () {
    const original = { ...subjects[0] };
    for (const credential of [original.accessTokenDigest, original.accessTokenDigest.slice(0, 16)]) {
      assert.equal(storage.findSubject(credential)._id.toHexString(), original._id.toHexString());
      assert.deepEqual(await verify(context, { apiSecret: credential }),
        { kind: 'subject', subjectId: original._id.toHexString() });
    }
    const current = await renameFirstSubject();
    assert.notEqual(current.accessTokenDigest, original.accessTokenDigest);
    for (const credential of [original.accessTokenDigest, original.accessTokenDigest.slice(0, 16)]) {
      assert.equal(storage.findSubject(credential), null, 'old hash includes the old display prefix');
      assert.equal(await verify(context, { apiSecret: credential }), null);
    }
    for (const credential of [current.accessTokenDigest, current.accessTokenDigest.slice(0, 16)]) {
      assert.equal(storage.findSubject(credential).name, 'Renamed Display');
      assert.deepEqual(await verify(context, { apiSecret: credential }),
        { kind: 'subject', subjectId: original._id.toHexString() });
    }
  });

  describe('trusted data bridge boundaries', function () {
    const createDataAccess = require('../lib/server/tenant-app/data-access');
    const authentication = require('../lib/api3/tenant-authentication');
    const security = require('../lib/api3/security');

    function legacyAccess (authority) {
      return createDataAccess({ secrets: local.verifier, authority,
        verifierContext: async tenant => ({ ...context, tenant }), legacyCollections: ['entries'] });
    }
    const legacyRequest = token => ({ method: 'GET', path: '/entries/sgv.json', rawHeaders: [], query: { token } });

    it('authenticates a legacy query within its request without issuing an internal token', async function () {
      const access = legacyAccess({ async authorize () { return true; },
        async subjectSnapshot () { return { sub: 'synthetic', permissionGroups: [] }; } });
      const before = events.length;
      const req = legacyRequest(subjects[0].accessToken);
      assert.equal((await access({ tenant: context.tenant, request: req, version: 1 })).principal,
        subjects[0]._id.toHexString());
      assert.equal(events.length, before, 'no secrets operation: one-way verifiers only');
      const selected = await security.authenticate({ req });
      assert.equal(security.checkPermission(selected, 'api:entries:read'), true);
      assert.equal(security.checkPermission(selected, 'api:entries:create'), false);
    });

    it('refuses query roots, foreign credentials and removed subjects, then checks permission afresh', async function () {
      let present = true, allowed = true, snapshots = 0;
      const access = legacyAccess({ async authorize () { throw new Error('fresh permission snapshot required'); },
        async permissionSnapshot () {
          snapshots++;
          const decision = allowed;
          return { allows: () => decision };
        },
        async subjectSnapshot () { return present ? { sub: 'synthetic', permissionGroups: [] } : null; } });
      const authenticate = (token, tenant = context.tenant) =>
        access({ tenant, request: legacyRequest(token), version: 1 });
      assert.equal(await authenticate(hash(root)), null, 'query roots do not acquire subject authority');
      assert.equal(await authenticate('invalid'), null);
      local.set(OTHER_TENANT, { root: 'other-synthetic-root-secret', subjects: metadata });
      assert.equal(await authenticate(subjects[0].accessToken, OTHER_TENANT), null);
      const token = subjects[0].accessToken;
      assert.ok(await authenticate(token));
      present = false;
      assert.equal(await authenticate(token), null, 'subject removal applies on the next request');
      present = true; allowed = false;
      const req = legacyRequest(token);
      await assert.rejects(access({ tenant: context.tenant, request: req, version: 1 }),
        { code: 'TENANT_LEGACY_FORBIDDEN' });
      assert.equal(authentication.get(req), undefined, 'refusal never binds authentication');
      assert.equal(snapshots, 2, 'each authenticated request reads a new permission snapshot');
    });

    it('retains explicit root-secret precedence when a legacy query credential is also supplied', async function () {
      const access = legacyAccess({ async authorize () { return true; },
        async subjectSnapshot () { return { sub: 'synthetic', permissionGroups: [] }; } });
      const req = legacyRequest(subjects[0].accessToken);
      req.rawHeaders = ['api-secret', hash(root)];
      assert.equal((await access({ tenant: context.tenant, request: req, version: 1 })).principal, 'root');
    });

    it('awaits current authority before binding only the exact synchronous read permission', async function () {
      let release, verified = false;
      const ready = new Promise(resolve => { release = resolve; });
      const req = { method: 'GET', path: '/entries/shared', rawHeaders: ['api-secret', 'synthetic'] };
      const access = createDataAccess({
        secrets: { async verifyLegacyCredential () { return { kind: 'subject', subjectId: 'root' }; } },
        verifierContext: async tenant => ({ tenant, principal: 'verifier', consumer: 'api' }),
        authority: { async authorize (input) {
          assert.deepEqual(input, { tenant: TENANT, principal: { kind: 'subject', subjectId: 'root' },
            permission: 'api:entries:read' });
          await ready;
          verified = true;
          return true;
        } }
      });
      const pending = access({ tenant: TENANT, request: req });
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
        assert.equal(await access({ tenant: TENANT, request: req }), null);
        assert.equal(authentication.get(req), undefined);
      }
      assert.equal(verified, 0);
      for (const [method, path] of [['POST', '/entries/shared'], ['PUT', '/entries'], ['PATCH', '/entries'],
        ['DELETE', '/entries'], ['GET', '/entries/history/one/two']]) {
        await assert.rejects(access({ tenant: TENANT, request: { method, path, rawHeaders: [] } }),
          { code: 'TENANT_DATA_UNSUPPORTED' });
      }
      assert.equal(verified, 0);
    });
  });

  it('keeps invalid supplied values out of anonymous and checks current verifier state every time', async function () {
    assert.deepEqual(await verify(context), { kind: 'anonymous' });
    for (const apiSecret of ['', 'null', 'wrong', root, 'same-display', subjects[0].digest.slice(0, 15)]) {
      assert.equal(await verify(context, { apiSecret }), null);
    }
    const credential = { apiSecret: subjects[0].accessToken };
    assert.equal((await verify(context, credential)).kind, 'subject');
    metadata = metadata.slice(1); prepare();
    assert.equal(await verify(context, credential), null);
    local.outage(true);
    await assert.rejects(verify(context, { apiSecret: hash(root) }), { code: 'SECRETS_LEGACY_AUTHORITY_UNAVAILABLE' });
  });

});
