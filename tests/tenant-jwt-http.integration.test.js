'use strict';

// Tenant-bound data JWTs through HTTP authorization. Tokens are the api's local
// data JWTs signed with per-tenant keys derived from the deployment signing
// secret (decision deployment-signing-secret); each tenant verifies with its own
// stored public key, so a token for A fails signature on B (D14).
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const createResolver = require('../lib/tenant-resolution');
const { createTenantApp } = require('../lib/server/tenant-app');
const tokens = require('../lib/tenant-authorization/legacy-data-token');
const { signing } = require('./fixtures/signing-secret');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const TENANTS = [A, B];

function fixture () {
  const access = new Map(TENANTS.map(tenant => [`${tenant}:device-${tenant}`, `subject-${tenant}`]));
  const grants = new Set(TENANTS.map(tenant => `${tenant}:subject-${tenant}:data`));
  const calls = [];
  let unavailable = false;
  const codec = tokens.create({ issuer: 'synthetic-data', audience: 'synthetic-api', now: () => 1800000000 });
  // The stored verification row: public key only.
  const row = tenant => ({ kid: signing.key(tenant, 'data', 1).kid, publicKey: signing.key(tenant, 'data', 1).spki, active: true });
  const resolver = createResolver({
    aliases: [
      { host: 'one.example.test', tenant: A },
      { host: 'two.example.test', tenant: B }
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
      calls.push({ operation: 'verify', tenant });
      try {
        const claims = codec.verify(credential, tenant, [row(tenant)]);
        const principal = access.get(`${tenant}:${claims.sub}`);
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
    token (tenant, signedFor = tenant) {
      return codec.issue(tenant, { kind: 'subject', subjectId: `device-${tenant}`, credentialVersion: 1, rootVersion: 1 },
        signing.key(signedFor, 'data', 1)).token;
    }
  };
}

function get (app, host, token) {
  return request(app).get('/api/v3/entries')
    .set('Host', host)
    .set('Authorization', `Bearer ${token}`);
}

describe('tenant-bound JWT through HTTP authorization', function () {
  it('accepts each tenant token only on its own alias, with local signature verification', async function () {
    const state = fixture();
    const [tokenA, tokenB] = [state.token(A), state.token(B)];

    await get(state.app, 'one.example.test', tokenA)
      .expect(200, { tenant: A, principal: 'subject-' + A });
    await get(state.app, 'two.example.test', tokenB)
      .expect(200, { tenant: B, principal: 'subject-' + B });
    await get(state.app, 'two.example.test', tokenA)
      .expect(401, { error: 'CREDENTIAL_REFUSED' });
    await get(state.app, 'one.example.test', tokenB)
      .expect(401, { error: 'CREDENTIAL_REFUSED' });
    // D14: a token claiming B but signed with A's derived key fails on B.
    await get(state.app, 'two.example.test', state.token(B, A))
      .expect(401, { error: 'CREDENTIAL_REFUSED' });
    assert.equal(state.calls.filter(event => event.operation === 'verify').length, 5);
  });

  it('uses current tenant grants after JWT verification and fails closed on authority outage', async function () {
    const state = fixture();
    const tokenA = state.token(A);

    await get(state.app, 'one.example.test', tokenA).expect(200);
    state.grants.delete(`${A}:subject-${A}:data`);
    await get(state.app, 'one.example.test', tokenA)
      .expect(403, { error: 'REQUEST_FORBIDDEN' });
    state.setUnavailable(true);
    await get(state.app, 'one.example.test', tokenA)
      .expect(503, { error: 'AUTHORITY_UNAVAILABLE' });
  });
});
