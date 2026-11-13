'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const createResolver = require('../lib/tenant-resolution');
const { createTenantSettings } = require('../lib/tenant-settings/component');
const { createSubjectPolicy } = require('../lib/subject-policy/component');
const { createOperatorPolicy } = require('../lib/operator-policy/component');
const { createTenantApp, createOperatorApp } = require('../lib/server/tenant-app');
const createDataAccess = require('../lib/server/tenant-app/data-access');
const legacyAuthorization = require('../lib/server/tenant-app/legacy-authorization');

function fixture ({ trustedProxy = () => false, resolver: suppliedResolver, exchange } = {}) {
  const events = [];
  const state = {
    revoked: false, unavailable: false, managementDenied: false,
    verificationError: false, serviceError: false, limitsUnavailable: false
  };
  const settingsRows = new Map();
  const settingsHistory = new Map();
  const policyRows = new Map();
  const operatorRows = new Map();
  const grant = { principal: 'owner', consumer: 'client', operation: 'verify' };
  for (const tenant of ['A', 'B']) {
    settingsRows.set(tenant, { version: 1, values: { SHOW_SECONDS: tenant === 'A' } });
    settingsHistory.set(tenant + ':1', settingsRows.get(tenant));
    policyRows.set(tenant, { version: 1, grants: [grant] });
    operatorRows.set(tenant, { generation: 1, policy: { enabled: true } });
  }
  const ownerManagement = async context => {
    events.push(['management', context]);
    return !state.managementDenied && context.principal === 'owner';
  };
  const tenantSettings = createTenantSettings({
    store: {
      async read (tenant) {
        if (state.serviceError) throw new Error('database password secret-value');
        return settingsRows.get(tenant);
      },
      async history (tenant, version) { return settingsHistory.get(tenant + ':' + version); },
      async write (actor, expected, values) {
        const previous = settingsRows.get(actor.tenant);
        if ((previous ? previous.version : 0) !== expected) return null;
        const next = { version: expected + 1, values };
        settingsRows.set(actor.tenant, next);
        settingsHistory.set(actor.tenant + ':' + next.version, next);
        return next;
      }
    },
    policyFor: async () => ({ deployment: {}, overrides: {}, generation: 1 }),
    authorize: ownerManagement
  });
  const subjectPolicy = createSubjectPolicy({
    store: {
      async read (tenant) { return policyRows.get(tenant); },
      async write (actor, expected, grants) {
        const previous = policyRows.get(actor.tenant);
        if ((previous ? previous.version : 0) !== expected) return null;
        const next = { version: expected + 1, grants };
        policyRows.set(actor.tenant, next);
        return next;
      }
    },
    limitsFor: async () => state.limitsUnavailable ? null : { code: [grant], operator: [grant], generation: 1 },
    authorizeManagement: ownerManagement
  });
  const tenantResolver = suppliedResolver || createResolver({
    aliases: [
      { host: 'one.example.org', tenant: 'A' },
      { host: 'rotated.example.org', tenant: 'A' },
      { host: 'two.example.org', tenant: 'B' }
    ],
    trustedProxy
  });
  const data = express.Router();
  data.get('/entries', (req, res) => {
    events.push(['data', req.tenantContext]);
    assert.equal(Object.isFrozen(req.tenantContext), true);
    res.json(req.tenantContext);
  });
  const options = {
    resolver: tenantResolver,
    async verifyCredential ({ tenant, credential, plane }) {
      events.push(['verify', tenant, plane]);
      if (state.verificationError) throw new Error('provider credential secret-value');
      const [credentialTenant, principal] = credential.split('-');
      if (!['A', 'B'].includes(credentialTenant) || !['owner', 'data'].includes(principal)) return null;
      return { tenant: credentialTenant, principal, consumer: 'client' };
    },
    async authorizeRequest (context, action) {
      events.push(['authorize', context, action]);
      if (state.unavailable) throw new Error('authority database secret-value');
      return !state.revoked && (action.plane === 'data' ? context.principal === 'data' : context.principal === 'owner');
    },
    tenantSettings, subjectPolicy, dataRouter: data, exchange
  };
  const operatorPolicy = createOperatorPolicy({
    store: {
      async read (tenant) { return operatorRows.get(tenant); },
      async write (actor, expected, policy) {
        const previous = operatorRows.get(actor.tenant);
        if ((previous ? previous.generation : 0) !== expected) return null;
        const next = { generation: expected + 1, policy };
        operatorRows.set(actor.tenant, next);
        return next;
      }
    },
    async authorizeManagement (context) {
      events.push(['operator-management', context]);
      if (state.unavailable) throw new Error('operator authority secret-value');
      return !state.managementDenied && context.principal === 'operator' && context.tenant === 'A';
    }
  });
  const operator = createOperatorApp({
    async authenticateOperator (req) {
      events.push(['operator-auth']);
      return req.get('Authorization') === 'Bearer private-operator'
        ? { principal: 'operator', consumer: 'private' } : null;
    },
    operatorPolicy
  });
  return { app: createTenantApp(options), operator, options, state, events };
}

function tenantRequest (app, path, token = 'A-owner', host = 'one.example.org', method = 'get') {
  return request(app)[method](path).set('Host', host).set('Authorization', 'Bearer ' + token);
}

describe('dormant tenant HTTP composition', function () {
  it('resolves aliases before verification and passes stable, immutable tenant identities to API3', async function () {
    const { app, events } = fixture();
    for (const host of ['ONE.EXAMPLE.ORG:443', 'rotated.example.org']) {
      const result = await tenantRequest(app, '/api/v3/entries', 'A-data', host).expect(200);
      assert.deepEqual(result.body, { tenant: 'A', principal: 'data', consumer: 'client' });
      assert.equal(result.headers['cache-control'], 'no-store');
      assert.equal(result.headers['x-powered-by'], undefined);
    }
    const second = await tenantRequest(app, '/api/v3/entries', 'B-data', 'two.example.org').expect(200);
    assert.equal(second.body.tenant, 'B');
    assert.deepEqual(events.filter(event => event[0] === 'verify'),
      [['verify', 'A', 'data'], ['verify', 'A', 'data'], ['verify', 'B', 'data']]);
  });

  it('refuses unknown aliases before credential verification and refuses cross-tenant credentials', async function () {
    const { app, events } = fixture();
    await tenantRequest(app, '/api/v3/entries', 'A-data', 'unknown.example.org').expect(404, { error: 'TENANT_REFUSED' });
    assert.deepEqual(events, []);
    await tenantRequest(app, '/api/v3/entries', 'B-data').expect(401, { error: 'CREDENTIAL_REFUSED' });
    await tenantRequest(app, '/api/v1/tenant/settings', 'B-owner').expect(401);
    await tenantRequest(app, '/api/v1/tenant/settings', 'unknown-token').expect(401);
    await request(app).get('/api/v1/tenant/settings').set('Host', 'one.example.org').expect(401);
    assert.equal(events.some(event => ['authorize', 'data', 'management'].includes(event[0])), false);
  });

  it('accepts proxy selectors only from an explicitly trusted peer, never as authorization', async function () {
    const untrusted = fixture();
    await tenantRequest(untrusted.app, '/api/v3/entries', 'A-data')
      .set('X-Resolved-Tenant', 'A').expect(400);
    assert.deepEqual(untrusted.events, []);
    const { app } = fixture({ trustedProxy: req =>
      ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) });
    await tenantRequest(app, '/api/v3/entries', 'A-data', 'backend.example.org')
      .set('X-Forwarded-Host', 'rotated.example.org').set('X-Resolved-Tenant', 'A').expect(200);
    await tenantRequest(app, '/api/v3/entries', 'B-data', 'backend.example.org')
      .set('X-Forwarded-Host', 'one.example.org').set('X-Resolved-Tenant', 'A').expect(401);
    await tenantRequest(app, '/api/v3/entries', 'A-data')
      .set('X-Resolved-Tenant', 'B').expect(400);
    await request(app).get('/api/v3/entries').set('Host', 'one.example.org')
      .set('X-Resolved-Tenant', 'A').expect(401);
  });

  it('keeps owner and data permissions separate and rechecks current authority on every request', async function () {
    const { app, state, events } = fixture();
    await tenantRequest(app, '/api/v1/tenant/settings', 'A-data').expect(403);
    await tenantRequest(app, '/api/v3/entries', 'A-owner').expect(403);
    await tenantRequest(app, '/api/v3/entries', 'A-data').expect(200);
    state.revoked = true;
    await tenantRequest(app, '/api/v3/entries', 'A-data').expect(403);
    await tenantRequest(app, '/api/v1/tenant/settings').expect(403);
    state.revoked = false;
    state.unavailable = true;
    await tenantRequest(app, '/api/v3/entries', 'A-data').expect(503, { error: 'AUTHORITY_UNAVAILABLE' });
    await tenantRequest(app, '/api/v1/tenant/settings').expect(503);
    assert.equal(events.filter(event => event[0] === 'data').length, 1);
    assert.equal(events.some(event => event[0] === 'management'), false);
  });

  it('wires settings reads, replacement and rollback without allowing identity overrides', async function () {
    const { app } = fixture();
    const initial = await tenantRequest(app, '/api/v1/tenant/settings').expect(200);
    assert.equal(initial.body.effective.SHOW_SECONDS.value, true);
    const update = await tenantRequest(app, '/api/v1/tenant/settings', 'A-owner', 'one.example.org', 'put')
      .send({ expectedVersion: 1, values: { DISPLAY_UNITS: 'mmol' } }).expect(200);
    assert.equal(update.body.version, 2);
    assert.equal(update.body.effective.DISPLAY_UNITS.value, 'mmol');
    await tenantRequest(app, '/api/v1/tenant/settings', 'A-owner', 'one.example.org', 'put')
      .send({ expectedVersion: 1, values: {} }).expect(409, { error: 'SETTINGS_VERSION_CONFLICT' });
    const rollback = await tenantRequest(app, '/api/v1/tenant/settings/rollback', 'A-owner', 'one.example.org', 'post')
      .send({ expectedVersion: 2, restoredFrom: 1 }).expect(200);
    assert.equal(rollback.body.version, 3);
    assert.equal(rollback.body.effective.SHOW_SECONDS.value, true);
    await tenantRequest(app, '/api/v1/tenant/settings', 'A-owner', 'one.example.org', 'put')
      .send({ expectedVersion: 3, values: {}, tenant: 'B' }).expect(400);
    const other = await tenantRequest(app, '/api/v1/tenant/settings', 'B-owner', 'two.example.org').expect(200);
    assert.equal(other.body.version, 1);
    assert.equal(other.body.effective.SHOW_SECONDS.value, false);
  });

  it('wires subject-policy management while preserving service ceilings and management checks', async function () {
    const { app, state } = fixture();
    const current = await tenantRequest(app, '/api/v1/tenant/subject-policy').expect(200);
    assert.equal(current.body.grants.length, 1);
    await tenantRequest(app, '/api/v1/tenant/subject-policy', 'A-owner', 'one.example.org', 'put')
      .send({ expectedVersion: 1, grants: [{ principal: 'owner', consumer: 'client', operation: 'sign' }] }).expect(403);
    await tenantRequest(app, '/api/v1/tenant/subject-policy', 'A-owner', 'one.example.org', 'put')
      .send({ expectedVersion: 1, grants: [] }).expect(200, { version: 2, grants: [] });
    state.limitsUnavailable = true;
    await tenantRequest(app, '/api/v1/tenant/subject-policy', 'A-owner', 'one.example.org', 'put')
      .send({ expectedVersion: 2, grants: [] }).expect(503, { error: 'AUTHORITY_UNAVAILABLE' });
    state.managementDenied = true;
    await tenantRequest(app, '/api/v1/tenant/subject-policy').expect(403, { error: 'POLICY_FORBIDDEN' });
    await tenantRequest(app, '/api/v1/tenant/settings').expect(403, { error: 'SETTINGS_FORBIDDEN' });
  });

  it('exposes operator management only in the independently authenticated private app', async function () {
    const { app, operator, events, state } = fixture();
    const path = '/api/v1/operator/tenants/A/policy';
    await tenantRequest(app, path, 'private-operator').expect(404);
    await request(operator).get('/api/v3/entries').expect(404);
    await request(operator).get('/api/v1/tenant/settings').expect(404);
    await request(operator).get(path).set('Authorization', 'Bearer A-owner').expect(401);
    await request(operator).get(path).set('Authorization', 'Bearer private-operator')
      .expect(200, { generation: 1, policy: { enabled: true } });
    await request(operator).put(path).set('Authorization', 'Bearer private-operator')
      .send({ expectedGeneration: 1, policy: { enabled: false } })
      .expect(200, { generation: 2, policy: { enabled: false } });
    await request(operator).put(path).set('Authorization', 'Bearer private-operator')
      .send({ expectedGeneration: 1, policy: {} }).expect(409);
    await request(operator).get('/api/v1/operator/tenants/B/policy')
      .set('Authorization', 'Bearer private-operator').expect(403);
    state.unavailable = true;
    await request(operator).get(path).set('Authorization', 'Bearer private-operator')
      .expect(503, { error: 'AUTHORITY_UNAVAILABLE' });
    assert.equal(events.some(event => event[0] === 'verify'), false);
    assert.deepEqual(events.find(event => event[0] === 'operator-management')[1],
      { tenant: 'A', principal: 'operator', consumer: 'private' });
  });

  it('sanitizes credential/provider and service failures and invalid/oversized JSON', async function () {
    const { app, state } = fixture();
    state.verificationError = true;
    await tenantRequest(app, '/api/v1/tenant/settings').expect(503, { error: 'AUTHORITY_UNAVAILABLE' });
    state.verificationError = false;
    state.serviceError = true;
    await tenantRequest(app, '/api/v1/tenant/settings').expect(503, { error: 'AUTHORITY_UNAVAILABLE' });
    state.serviceError = false;
    await tenantRequest(app, '/api/v1/tenant/settings', 'A-owner', 'one.example.org', 'put')
      .set('Content-Type', 'application/json').send('{"password":"secret-value"')
      .expect(400, { error: 'REQUEST_INVALID' });
    await tenantRequest(app, '/api/v1/tenant/settings', 'A-owner', 'one.example.org', 'put')
      .send({ expectedVersion: 1, values: { unsupported: 'secret-value' } })
      .expect(400, { error: 'SETTINGS_UNSUPPORTED' });
    await tenantRequest(app, '/api/v1/tenant/settings', 'A-owner', 'one.example.org', 'put')
      .send({ expectedVersion: -1, values: {} }).expect(400, { error: 'REQUEST_INVALID' });
    await tenantRequest(app, '/api/v1/tenant/settings', 'A-owner', 'one.example.org', 'put')
      .send({ expectedVersion: 1, values: { extra: 'x'.repeat(65536) } })
      .expect(413, { error: 'REQUEST_TOO_LARGE' });
  });

  it('rejects duplicate credentials instead of relying on normalized headers', async function () {
    const { app, events } = fixture();
    await request(app).get('/api/v3/entries').set('Host', 'one.example.org')
      .set('Authorization', ['Bearer A-data', 'Bearer B-data'])
      .expect(401, { error: 'CREDENTIAL_REFUSED' });
    assert.deepEqual(events, []);
  });

  it('requires explicit composition dependencies rather than silently using legacy globals', function () {
    assert.throws(() => createTenantApp(), TypeError);
    assert.throws(() => createOperatorApp(), TypeError);
    const { options } = fixture();
    assert.throws(() => createTenantApp({ ...options, authorizeRequest: undefined }), TypeError);
    assert.throws(() => createTenantApp({ ...options, verifyCredential: undefined }), TypeError);
  });

  it('uses canonical Host for exchange, data and owner planes without changing their authorization', async function () {
    const resolver = createResolver({
      mode: 'canonical-internal',
      internalNames: [
        { host: 'internal-a.example.net', tenant: 'A' },
        { host: 'internal-b.example.net', tenant: 'B' }
      ],
      aliases: [
        { host: 'one.example.org', tenant: 'A' },
        { host: 'two.example.org', tenant: 'B' }
      ],
      trustedProxy: () => true
    });
    const { app, events } = fixture({
      resolver,
      exchange: async ({ tenant, credential }) => ({ tenant, credential })
    });
    await request(app).get('/api/v2/authorization/request/exchange-token')
      .set('Host', 'internal-a.example.net')
      .set('X-Forwarded-Host', 'rotated.example.org')
      .expect(200, { tenant: 'A', credential: 'exchange-token' });
    await tenantRequest(app, '/api/v3/entries', 'A-data', 'internal-a.example.net')
      .set('X-Forwarded-Host', 'one.example.org')
      .expect(200, { tenant: 'A', principal: 'data', consumer: 'client' });
    await tenantRequest(app, '/api/v1/tenant/settings', 'A-owner', 'internal-a.example.net')
      .set('X-Forwarded-Host', 'rotated.example.org').expect(200);
    await tenantRequest(app, '/api/v3/entries', 'B-data', 'internal-a.example.net')
      .set('X-Forwarded-Host', 'two.example.org')
      .expect(400, { error: 'TENANT_REFUSED' });
    assert.deepEqual(events.filter(event => event[0] === 'verify'),
      [['verify', 'A', 'data'], ['verify', 'A', 'owner']]);
    assert.deepEqual(events.filter(event => event[0] === 'authorize').map(event => event[2].plane),
      ['data', 'owner']);
  });

  it('refuses unknown canonical Hosts, untrusted requests and sanitizes trust outages', async function () {
    const canonical = options => createResolver({
      mode: 'canonical-internal',
      internalNames: [{ host: 'internal-a.example.net', tenant: 'A' }],
      aliases: [{ host: 'one.example.org', tenant: 'A' }],
      trustedProxy: () => true,
      ...options
    });
    const unknown = fixture({ resolver: canonical() });
    await tenantRequest(unknown.app, '/api/v3/entries', 'A-data', 'unknown.example.net')
      .set('X-Forwarded-Host', 'one.example.org').set('X-Resolved-Tenant', 'A')
      .expect(404, { error: 'TENANT_REFUSED' });
    assert.deepEqual(unknown.events, []);
    const untrusted = fixture({ resolver: canonical({ trustedProxy: () => false }) });
    await tenantRequest(untrusted.app, '/api/v3/entries', 'A-data', 'internal-a.example.net')
      .expect(400, { error: 'TENANT_REFUSED' });
    const unavailable = fixture({
      resolver: canonical({ trustedProxy: () => { throw new Error('transport secret-value'); } })
    });
    await tenantRequest(unavailable.app, '/api/v3/entries', 'A-data', 'internal-a.example.net')
      .expect(503, { error: 'AUTHORITY_UNAVAILABLE' })
      .then(result => assert.equal(JSON.stringify(result.body).includes('secret-value'), false));
  });

  it('replaces an injected resolver snapshot without preserving retired tenant mappings', async function () {
    const make = internalNames => createResolver({
      mode: 'canonical-internal',
      internalNames,
      trustedProxy: () => true
    });
    let active = make([
      { host: 'retired-a.example.net', tenant: 'A' },
      { host: 'internal-b.example.net', tenant: 'B' }
    ]);
    const resolver = { resolve: req => active.resolve(req) };
    const { app } = fixture({ resolver });
    await tenantRequest(app, '/api/v3/entries', 'A-data', 'retired-a.example.net').expect(200);

    active = make([
      { host: 'internal-a.example.net', tenant: 'A' },
      { host: 'internal-b.example.net', tenant: 'B' }
    ]);
    await tenantRequest(app, '/api/v3/entries', 'A-data', 'retired-a.example.net')
      .expect(404, { error: 'TENANT_REFUSED' });
    await tenantRequest(app, '/api/v3/entries', 'A-data', 'internal-a.example.net').expect(200);
    await tenantRequest(app, '/api/v3/entries', 'B-data', 'internal-a.example.net')
      .expect(401, { error: 'CREDENTIAL_REFUSED' });
  });
});

describe('legacy tenant data refusal compatibility', function () {
  const unauthorized = { status: 401, message: 'Unauthorized', description: 'Invalid/Missing' };
  const scope = require('../lib/storage/tenant-scope');
  let originalMode;
  before(function () { originalMode = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  after(function () { scope.setTenancyMode(originalMode); });

  function legacyFixture () {
    const original = fixture();
    const state = { credential: false, permission: false, error: null, reached: 0 };
    const access = createDataAccess({
      secrets: {
        async verifyLegacyCredential () {
          if (state.error) throw state.error;
          return state.credential ? { kind: 'subject', subjectId: 'client' } : null;
        },
        async exchangeLegacyCredential () { return null; }
      },
      authority: {
        async authorize () { return state.permission; },
        async subjectSnapshot () { return { sub: 'client', permissionGroups: [] }; }
      },
      verifierContext: async tenant => ({ tenant, consumer: 'client' }),
      legacyCollections: ['entries']
    });
    const legacy = express.Router();
    legacy.get('/entries', legacyAuthorization().isPermitted('api:entries:read'), (req, res) => {
      state.reached++;
      res.json([]);
    });
    const app = createTenantApp({ ...original.options,
      // Keep admission in the actual authentication callback; this router also
      // falls through to the separate owner plane, which must retain its errors.
      dataAccess: input => access(input), legacyRouter: legacy });
    return { app, state, operator: original.operator };
  }

  it('preserves the shipping v1/v2 401 envelope for rejected credentials before any data handler', async function () {
    const { app, state } = legacyFixture();
    for (const version of [1, 2]) {
      await request(app).get('/api/v' + version + '/entries?token=synthetic-invalid')
        .set('Host', 'one.example.org').expect(401, unauthorized);
      await request(app).get('/api/v' + version + '/entries')
        .set('Host', 'one.example.org').set('api-secret', 'synthetic-invalid')
        .expect(401, unauthorized);
    }
    assert.equal(state.reached, 0);
  });

  it('preserves that envelope for current permission denial and lets an authorized request reach data', async function () {
    const { app, state } = legacyFixture();
    state.credential = true;
    for (const version of [1, 2]) {
      await request(app).get('/api/v' + version + '/entries')
        .set('Host', 'one.example.org').set('api-secret', 'synthetic-credential')
        .expect(401, unauthorized);
    }
    assert.equal(state.reached, 0);
    state.permission = true;
    await request(app).get('/api/v1/entries').set('Host', 'one.example.org')
      .set('api-secret', 'synthetic-credential').expect(200, []);
    assert.equal(state.reached, 1);
  });

  it('formats known token refusals statically while retaining sanitized dependency failure', async function () {
    const { app, state } = legacyFixture();
    for (const code of ['TOKEN_FORMAT', 'TOKEN_HEADER', 'TOKEN_KEY', 'TOKEN_SIGNATURE', 'TOKEN_CLAIMS']) {
      state.error = Object.assign(new Error('private synthetic provider detail'), { code });
      await request(app).get('/api/v1/entries').set('Host', 'one.example.org')
        .set('api-secret', 'synthetic-credential').expect(401, unauthorized);
    }
    state.error = new Error('private synthetic provider detail');
    await request(app).get('/api/v1/entries').set('Host', 'one.example.org')
      .set('api-secret', 'synthetic-credential').expect(503, { error: 'AUTHORITY_UNAVAILABLE' });
    assert.equal(state.reached, 0);
  });

  it('keeps API3, owner and operator refusal contracts even with a legacy router mounted', async function () {
    const { app, operator, state } = legacyFixture();
    await request(app).get('/api/v3/entries').set('Host', 'one.example.org')
      .expect(401, { error: 'CREDENTIAL_REFUSED' });
    await request(app).get('/api/v1/tenant/settings').set('Host', 'one.example.org')
      .expect(401, { error: 'CREDENTIAL_REFUSED' });
    await request(operator).get('/api/v1/operator/tenants/A/policy')
      .expect(401, { error: 'CREDENTIAL_REFUSED' });
    state.error = Object.assign(new Error('private synthetic provider detail'), { code: 'TOKEN_SIGNATURE' });
    await request(app).get('/api/v3/entries').set('Host', 'one.example.org')
      .set('api-secret', 'synthetic-credential').expect(401, { error: 'TOKEN_SIGNATURE' });
    assert.equal(state.reached, 0);
  });
});
