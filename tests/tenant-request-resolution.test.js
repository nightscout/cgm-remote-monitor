'use strict';
const assert = require('node:assert/strict');
const express = require('express'), request = require('supertest');
const { createTenantApp } = require('../lib/server/tenant-app');
const A = '11111111-1111-4111-8111-111111111111';
const scope = require('../lib/storage/tenant-scope');
const B = '22222222-2222-4222-8222-222222222222';
describe('request-local tenant resolution', function () {
  let mode; before(() => { mode = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  after(() => scope.setTenancyMode(mode));
  it('resolves once and keeps admission and authentication on the same tenant, with fresh next-request resolution', async () => {
    let resolutions = 0, active, nextTenant = A;
    const admitted = [], authenticated = [];
    const unavailable = async () => { throw new Error('unused owner capability'); };
    const app = createTenantApp({
      resolver: { resolve: async () => { resolutions++; return nextTenant; } },
      verifyCredential: unavailable, authorizeRequest: unavailable,
      tenantSettings: { read: unavailable, replace: unavailable, rollback: unavailable },
      subjectPolicy: { read: unavailable, replace: unavailable }, dataRouter: express.Router(),
      operationWindow: { run: async (tenant, fn) => { admitted.push(tenant); active = tenant; nextTenant = B; await fn(); } },
      dataAccess: async ({ tenant }) => { authenticated.push(tenant); assert.equal(tenant, active); return { tenant, principal: 'synthetic', consumer: 'api' }; },
      legacyRouter: async (req, res, next) => {
        try { await Promise.all([req.tenantAuthenticate(), req.tenantAuthenticate()]); res.json({ tenant: req.tenantContext.tenant }); }
        catch (error) { next(error); }
      }
    });
    assert.equal((await request(app).get('/api/v1/entries').expect(200)).body.tenant, A);
    assert.equal((await request(app).get('/api/v1/entries').expect(200)).body.tenant, B);
    assert.equal(resolutions, 2);
    assert.deepEqual(admitted, [A, B]); assert.deepEqual(authenticated, [A, B]);
  });
});
