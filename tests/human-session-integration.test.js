'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const humanAccessFixture = require('./fixtures/human-access-issuer');
const runtime = require('../lib/human-session/runtime');
const management = require('../lib/human-session/management');
const { credential, COOKIE, MANAGEMENT_COOKIE } = require('../lib/human-session/http');
const createDataAccess = require('../lib/server/tenant-app/data-access');
const tenantAuthentication = require('../lib/api3/tenant-authentication');
const { createVerifier, createAuthentication } = require('../lib/tenant-authorization/access-token');

describe('human sessions consumed by existing authentication factories (source doubles)', function () {
  const tenant = '11111111-1111-4111-8111-111111111111';
  let token, managementToken, singleToken, singleManagementToken, profile;
  before(async function () {
    const at = Math.floor(Date.now() / 1000);
    profile = humanAccessFixture({ tenant });
    const single = humanAccessFixture({ tenant: 'single' });
    const issue = (access, tenant, purpose) => access.issue({ tenant, subject: 'reader', session: 'synthetic-' + purpose,
      purpose, credentialVersion: 1, issuedAt: at, expiresAt: at + 600 });
    token = await issue(profile.access, tenant, 'data');
    managementToken = await issue(profile.access, tenant, 'management');
    singleToken = await issue(single.access, 'single', 'data');
    singleManagementToken = await issue(single.access, 'single', 'management');
  });
  function request (headers = {}, extra = {}) {
    return { headers, rawHeaders: Object.entries(headers).flat(), query: {}, body: undefined,
      method: 'GET', path: '/entries', header: name => headers[name.toLowerCase()],
      socket: { remoteAddress: '127.0.0.1' }, ...extra };
  }

  it('leaves default-off single and multi boot free of OIDC storage/provider requirements', async function () {
    assert.equal(await runtime.single({ env: { settings: { enable: [] } }, storage: null, source: {} }), null);
    assert.equal(await runtime.multi({ source: {}, resolver: null, tenants: null }), null);
    assert.equal(runtime.enabled({ settings: { enable: ['careportal'] } }), false);
    assert.equal(runtime.enabled({ settings: { enable: ['oidc'] } }), true);
  });

  it('preserves exact legacy management implementation when OIDC is absent', async function () {
    const legacy = async () => ({ principal: 'legacy' });
    assert.equal(management({ human: null, legacy }), legacy);
  });

  it('marks human-cookie data and HTML responses no-store in the actual cache middleware', function () {
    let next = 0;
    for (const name of [COOKIE, MANAGEMENT_COOKIE]) {
      const stored = {};
      require('../lib/middleware/credential-cache')({ headers: { cookie: name + '=' + token }, query: {} },
        { setHeader (name, value) { stored[name] = value; return this; } }, () => { next++; });
      assert.equal(stored['Cache-Control'], 'no-store');
    }
    assert.equal(next, 2);
  });

  it('selects human management purpose without legacy fallback and touches only after explicit success', async function () {
    const token = managementToken;
    const calls = [];
    const actor = { tenant, principal: 'owner', consumer: 'management' };
    const human = { credential, accepts: value => profile.access.accepts(value), async authenticate (input) { calls.push(input); return { actor }; } };
    const auth = management({ human, legacy: () => { throw new Error('legacy fallback forbidden'); } });
    const req = request({ authorization: 'Bearer ' + token });
    assert.equal(await auth({ tenant, credential: token, request: req }), actor);
    assert.equal(calls[0].purpose, 'management');
    assert.equal(calls[0].activity, false);
    await auth.activity(req);
    assert.equal(calls[1].activity, true);
    human.authenticate = async () => { throw Object.assign(new Error(), { code: 'HUMAN_SESSION_REFUSED' }); };
    await assert.rejects(auth({ tenant, credential: token, request: req }), { code: 'HUMAN_SESSION_REFUSED' });
  });

  it('uses current human data grants in actual multitenant data factory without root or legacy authority', async function () {
    let legacy = 0, reads = 0;
    const sessions = { credential, accepts: value => profile.access.accepts(value), async authenticate (input) {
      reads++;
      assert.equal(input.tenant, tenant);
      assert.equal(input.purpose, 'data');
      return { actor: { subject: 'reader', permissionGroups: [['api:entries:read']], allows: permission => permission === 'api:entries:read' } };
    } };
    const access = createDataAccess({ humanSessions: sessions,
      secrets: { verifyLegacyCredential: async () => { legacy++; return { kind: 'root' }; } },
      authority: { authorize: async () => { throw new Error('legacy authority forbidden'); } },
      verifierContext: async tenant => ({ tenant, consumer: 'api' }) });
    const req = request({ cookie: COOKIE + '=' + token });
    const actor = await access({ tenant, request: req });
    assert.equal(actor.principal, 'reader');
    assert.equal(actor.consumer, 'api');
    assert.equal(reads, 1);
    assert.equal(legacy, 0);
    const bound = tenantAuthentication.get(req);
    assert.equal(bound.defaults, false);
    assert.equal(bound.shiros[0].check('api:entries:read'), true);
    assert.equal(bound.shiros[0].check('api:entries:create'), false);
  });

  it('rechecks human grant failure for each data operation without anonymous fallback', async function () {
    let active = true, legacy = 0;
    const access = createDataAccess({ humanSessions: { credential, accepts: value => profile.access.accepts(value), async authenticate () {
      if (!active) throw Object.assign(new Error(), { code: 'HUMAN_AUTHORITY_REFUSED' });
      return { actor: { subject: 'reader', permissionGroups: [['api:entries:read']], allows: () => true } };
    } }, secrets: { verifyLegacyCredential: async () => { legacy++; return { kind: 'anonymous' }; } },
    authority: { authorize: async () => true }, verifierContext: async tenant => ({ tenant, consumer: 'api' }) });
    await access({ tenant, request: request({ authorization: 'Bearer ' + token }) });
    active = false;
    await assert.rejects(access({ tenant, request: request({ authorization: 'Bearer ' + token }) }), { code: 'HUMAN_AUTHORITY_REFUSED' });
    assert.equal(legacy, 0);
  });

  it('refuses human data write with read-only grants in the actual data factory', async function () {
    const access = createDataAccess({ humanSessions: { credential, accepts: value => profile.access.accepts(value), authenticate: async () => ({ actor: {
      subject: 'reader', permissionGroups: [['api:entries:read']], allows: permission => permission === 'api:entries:read'
    } }) }, secrets: { verifyLegacyCredential: async () => { throw new Error('legacy fallback forbidden'); } },
    authority: { authorize: async () => true }, verifierContext: async tenant => ({ tenant, consumer: 'api' }) });
    await assert.rejects(access({ tenant, request: request({ authorization: 'Bearer ' + token }, { method: 'POST' }) }),
      { code: 'TENANT_DATA_FORBIDDEN' });
  });

  it('refuses ambiguous legacy/human credentials instead of promoting a human into root', async function () {
    let human = 0;
    const access = createDataAccess({ humanSessions: { credential, accepts: value => profile.access.accepts(value), authenticate: async () => { human++; throw new Error(); } },
      secrets: { verifyLegacyCredential: async () => { throw new Error('legacy fallback forbidden'); } },
      authority: { authorize: async () => true }, verifierContext: async tenant => ({ tenant, consumer: 'api' }) });
    assert.equal(await access({ tenant, request: request({ authorization: 'Bearer ' + token, 'api-secret': 'synthetic-secret-hash' }) }), null);
    assert.equal(human, 0);
  });

  it('consumes human session in actual single authorization with current grants and never calls legacy resolver', async function () {
    const token = singleToken;
    const env = { trustProxy: false, authentication_collections_prefix: 'synthetic_',
      settings: { authDefaultRoles: 'denied', authFailDelay: 0 },
      enclave: { isApiKeySet: () => false } };
    let active = true;
    const ctx = { store: { collection: () => ({}) }, bus: new EventEmitter(), settings: {},
      moment: require('moment'), language: { translate: value => value },
      humanSessions: { credential, accepts: value => profile.access.accepts(value), async authenticate (input) {
        assert.equal(input.tenant, 'single');
        assert.equal(input.purpose, 'data');
        if (!active) throw Object.assign(new Error(), { code: 'HUMAN_SESSION_REFUSED' });
        return { actor: { subject: 'reader', permissionGroups: [['api:entries:read']] } };
      } } };
    const auth = require('../lib/authorization')(env, ctx);
    auth.resolve = () => { throw new Error('legacy fallback forbidden'); };
    const resolve = req => new Promise((done, reject) => auth.resolveWithRequest(req, (err, result) => err ? reject(err) : done(result)));
    const result = await resolve(request({ cookie: COOKIE + '=' + token }));
    assert.equal(result.subject._id, 'reader');
    assert.equal(result.shiros[0].check('api:entries:read'), true);
    assert.equal(result.shiros[0].check('api:entries:create'), false);
    let entered = 0, refusal;
    const response = { sendJSONStatus (res, status) { refusal = status; return this; } };
    const permitted = auth.isPermitted('api:entries:read');
    await permitted(request({ cookie: COOKIE + '=' + token }), response, () => { entered++; });
    assert.equal(entered, 1);
    active = false;
    await assert.rejects(resolve(request({ cookie: COOKIE + '=' + token })), { code: 'HUMAN_SESSION_REFUSED' });
    await permitted(request({ cookie: COOKIE + '=' + token }), response, () => { entered++; });
    assert.equal(entered, 1);
    assert.equal(refusal, 401);
  });

  it('checks explicit single management purpose and touches after successful JSON only', async function () {
    const token = singleManagementToken;
    const calls = [];
    const env = { trustProxy: false, authentication_collections_prefix: 'synthetic_',
      settings: { authDefaultRoles: 'denied', authFailDelay: 0 }, enclave: { isApiKeySet: () => false } };
    const ctx = { store: { collection: () => ({}) }, bus: new EventEmitter(), settings: {},
      moment: require('moment'), language: { translate: value => value },
      humanSessions: { credential, accepts: value => profile.access.accepts(value), async authenticate (input) {
        calls.push(input);
        assert.equal(input.purpose, 'management');
        return { actor: { subject: 'owner', permissionGroups: [['admin:api:roles:read']] } };
      } } };
    const auth = require('../lib/authorization')(env, ctx);
    const req = request({ cookie: MANAGEMENT_COOKIE + '=' + token });
    const sent = [];
    const res = { statusCode: 200, json (body) { sent.push(body); return this; },
      status (status) { this.statusCode = status; return this; }, sendJSONStatus () { throw new Error('unexpected refusal'); } };
    await auth.isPermitted('admin:api:roles:read', { purpose: 'management' })(req, res, () => {
      assert.equal(calls.length, 1);
      res.json({ synthetic: true });
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 2);
    assert.equal(calls[0].activity, undefined);
    assert.equal(calls[1].activity, true);
    assert.deepEqual(sent, [{ synthetic: true }]);
  });

  it('preserves a real signed-machine verifier for direct data access but never falls back to it from a human cookie', async function () {
    const machine = humanAccessFixture({ tenant, issuer: 'synthetic-machine-access',
      audiences: { data: 'synthetic-machine-data', management: 'synthetic-machine-management' } });
    const at = Math.floor(Date.now() / 1000);
    const machineToken = await machine.access.issue({ tenant, subject: 'machine-reader', session: 'machine-session',
      purpose: 'data', credentialVersion: 1, issuedAt: at, expiresAt: at + 600 });
    const authenticate = createAuthentication({ verifyToken: createVerifier({ issuer: machine.issuer,
      audience: machine.audiences.data, purpose: 'data', maxLifetimeSeconds: 28800,
      resolveKey: (tenant, kid) => {
        const key = machine.keys.find(key => key.tenant === tenant && key.kid === kid);
        return key && { ...key, issuer: machine.issuer };
      } }), snapshot: async () => ({ active: true, sessionActive: true, keyActive: true,
      credentialVersion: 1, sessionExpiresAt: at + 600, name: 'machine-reader', permissionGroups: [['api:entries:read']],
      allows: permission => permission === 'api:entries:read' }) });
    const counts = { human: 0, machine: 0, legacy: 0 };
    const access = createDataAccess({
      humanSessions: { credential, accepts: value => profile.access.accepts(value), async authenticate (input) {
        counts.human++;
        profile.access.verify({ tenant: input.tenant, token: input.credential });
        throw new Error('Foreign machine profile must refuse in the human verifier');
      } },
      accessTokens: { authenticate: input => { counts.machine++; return authenticate(input); } },
      secrets: { verifyLegacyCredential: async () => { counts.legacy++; throw new Error('Unexpected legacy fallback'); } },
      authority: { authorize: async () => false }, verifierContext: async tenant => ({ tenant, consumer: 'api' }) });
    assert.equal(profile.access.accepts(machineToken), false);
    const direct = await access({ tenant, request: request({ authorization: 'Bearer ' + machineToken }) });
    assert.equal(direct.principal, 'machine-reader');
    await assert.rejects(access({ tenant, request: request({ cookie: COOKIE + '=' + machineToken }) }), { code: 'HUMAN_SESSION_REFUSED' });
    assert.deepEqual(counts, { human: 1, machine: 1, legacy: 0 });
  });

  it('refuses an unrecognized signed profile in a management cookie without calling headless legacy management', async function () {
    const foreign = humanAccessFixture({ tenant, issuer: 'foreign-management-issuer' });
    const at = Math.floor(Date.now() / 1000);
    const foreignToken = await foreign.access.issue({ tenant, subject: 'foreign-owner', session: 'foreign-session',
      purpose: 'management', credentialVersion: 1, issuedAt: at, expiresAt: at + 600 });
    let legacy = 0;
    const auth = management({ human: { credential, accepts: value => profile.access.accepts(value),
      authenticate: async input => { profile.access.verify({ tenant: input.tenant, token: input.credential }); } },
    legacy: async () => { legacy++; throw new Error('Unexpected headless management fallback'); } });
    assert.equal(profile.access.accepts(foreignToken), false);
    await assert.rejects(auth({ tenant, credential: foreignToken,
      request: request({ cookie: MANAGEMENT_COOKIE + '=' + foreignToken }) }), { code: 'HUMAN_SESSION_REFUSED' });
    assert.equal(legacy, 0);
  });
});
