'use strict';

const assert = require('node:assert/strict');
const { createHmac, randomBytes, timingSafeEqual } = require('node:crypto');
const express = require('express');
const request = require('supertest');
const createResolver = require('../lib/tenant-resolution');
const { createSecrets } = require('../lib/secrets/component');
const { createTenantApp } = require('../lib/server/tenant-app');

const TENANTS = ['A', 'B'];

function hmac (key, message) {
  return createHmac('sha256', key).update(message).digest();
}

function fixture () {
  const keys = new Map(TENANTS.map(tenant => [tenant, randomBytes(32)]));
  const access = new Map(TENANTS.map(tenant => [`${tenant}:device-${tenant}`, `subject-${tenant}`]));
  const grants = new Set(TENANTS.map(tenant => `${tenant}:subject-${tenant}:data`));
  const calls = [];
  let unavailable = false;
  const secrets = createSecrets({
    providerFor (tenant) {
      const key = keys.get(tenant);
      if (!key) throw Object.assign(new Error('unknown tenant'), { code: 'TENANT_UNKNOWN' });
      return {
        signingVersion: 1,
        async sign (message) { return hmac(key, message); },
        async verify (version, message, signature) {
          if (version !== 1) return false;
          const expected = hmac(key, message);
          return signature.length === expected.length && timingSafeEqual(signature, expected);
        }
      };
    },
    store: { async get () { return undefined; }, async insert () {} },
    async authorize (identity, action) {
      return (action.operation === 'sign' && identity.principal === 'issuer' &&
          identity.consumer === 'issuer') ||
        (action.operation === 'verify' && identity.principal === 'http-verifier' &&
          identity.consumer === 'api');
    },
    async audit (event) { calls.push(event); },
    maxTokenLifetimeSeconds: 300,
    now: () => 1800000000000
  });
  const resolver = createResolver({
    aliases: [
      { host: 'one.example.test', tenant: 'A' },
      { host: 'two.example.test', tenant: 'B' }
    ]
  });
  const data = express.Router();
  data.get('/entries', (req, res) => res.json({
    tenant: req.tenantContext.tenant,
    principal: req.tenantContext.principal
  }));
  const app = createTenantApp({
    resolver,
    async verifyCredential ({ tenant, credential }) {
      try {
        const verified = await secrets.verifyJWT({
          tenant, principal: 'http-verifier', consumer: 'api'
        }, credential);
        const principal = access.get(`${tenant}:${verified.accessToken}`);
        return principal ? { tenant, principal, consumer: 'api' } : null;
      } catch (error) {
        if (error.code === 'SECRETS_TOKEN_INVALID') return null;
        throw error;
      }
    },
    async authorizeRequest (context, action) {
      if (unavailable) throw new Error('current authority unavailable');
      return action.plane === 'data' &&
        grants.has(`${context.tenant}:${context.principal}:data`);
    },
    tenantSettings: {
      async read () {}, async replace () {}, async rollback () {}
    },
    subjectPolicy: { async read () {}, async replace () {} },
    dataRouter: data
  });
  return {
    app, calls, grants,
    setUnavailable (value) { unavailable = value; },
    async token (tenant) {
      return secrets.signJWT({ tenant, principal: 'issuer', consumer: 'issuer' },
        `device-${tenant}`, 300);
    }
  };
}

function get (app, host, token) {
  return request(app).get('/api/v3/entries')
    .set('Host', host)
    .set('Authorization', `Bearer ${token}`);
}

describe('tenant-bound JWT through HTTP authorization', function () {
  it('accepts each tenant token only on its own alias, with real secrets verification', async function () {
    const state = fixture();
    const [tokenA, tokenB] = await Promise.all([state.token('A'), state.token('B')]);

    await get(state.app, 'one.example.test', tokenA)
      .expect(200, { tenant: 'A', principal: 'subject-A' });
    await get(state.app, 'two.example.test', tokenB)
      .expect(200, { tenant: 'B', principal: 'subject-B' });
    await get(state.app, 'two.example.test', tokenA)
      .expect(401, { error: 'CREDENTIAL_REFUSED' });
    await get(state.app, 'one.example.test', tokenB)
      .expect(401, { error: 'CREDENTIAL_REFUSED' });
    assert.equal(state.calls.filter(event => event.operation === 'verify').length, 4);
  });

  it('uses current tenant grants after JWT verification and fails closed on authority outage', async function () {
    const state = fixture();
    const tokenA = await state.token('A');

    await get(state.app, 'one.example.test', tokenA).expect(200);
    state.grants.delete('A:subject-A:data');
    await get(state.app, 'one.example.test', tokenA)
      .expect(403, { error: 'REQUEST_FORBIDDEN' });
    state.setUnavailable(true);
    await get(state.app, 'one.example.test', tokenA)
      .expect(503, { error: 'AUTHORITY_UNAVAILABLE' });
  });
});
