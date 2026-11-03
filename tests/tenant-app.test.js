'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const createResolver = require('../lib/tenant-resolution');
const { createTenantSettings } = require('../lib/tenant-settings/component');
const { createSubjectPolicy } = require('../lib/subject-policy/component');
const { createOperatorPolicy } = require('../lib/operator-policy/component');
const { createTenantApp, createOperatorApp } = require('../lib/server/tenant-app');

function fixture ({ trustedProxy = () => false } = {}) {
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
  const resolver = createResolver({
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
    resolver,
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
    tenantSettings, subjectPolicy, dataRouter: data
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
});
