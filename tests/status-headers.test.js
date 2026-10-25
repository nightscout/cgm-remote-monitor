'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const crypto = require('node:crypto');
const {EventEmitter} = require('node:events');

describe('status bootstrap authentication headers', function () {
  let app, authorization, jwt;
  const subjectToken = 'status-fixture-0123456789abcdef';
  const hash = crypto.createHash('sha1').update('status fixture API secret').digest('hex');

  before(function () {
    const enclave = require('../lib/server/enclave')();
    enclave.setApiKey('status fixture API secret');
    enclave.setJWTKey('status-fixture-jwt-key');
    const env = {name: 'status fixture', version: 'test', enclave, trustProxy: false,
      settings: {authDefaultRoles: '', enable: [], filteredSettings: value => value}};
    const ctx = {store: {collection: () => ({})}, bus: new EventEmitter(),
      language: {translate: text => text}, runtimeState: 'loaded'};
    authorization = ctx.authorization = require('../lib/authorization')(env, ctx);
    authorization.storage.roles = [{name: 'status-reader', permissions: ['api:status:read']}];
    authorization.storage.subjects = [{name: 'status-fixture', roles: ['status-reader'],
      accessToken: subjectToken, accessTokenDigest: subjectToken, digest: '0123456789abcdef'}];
    jwt = enclave.signJWT({accessToken: subjectToken});
    app = express();
    app.use('/api/v1', require('../lib/api/status')(app, require('../lib/middleware')(env), env, ctx));
  });

  it('authorizes an opaque subject token sent only in headers and returns its JWT', async function () {
    const res = await request(app).get('/api/v1/status.json')
      .set('api-secret', subjectToken).set('Authorization', 'Bearer ' + subjectToken).expect(200);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.body.authorized.sub, 'status-fixture');
    assert.ok(res.body.authorized.token);
  });

  it('authorizes a JWT sent only as a bearer token', async function () {
    const res = await request(app).get('/api/v1/status.json').set('Authorization', 'Bearer ' + jwt).expect(200);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.body.authorized.sub, 'status-fixture');
  });

  it('retains API-secret header authentication without minting a subject session', async function () {
    const res = await request(app).get('/api/v1/status.json').set('api-secret', hash).expect(200);
    assert.equal(res.body.authorized, null);
  });

  it('retains shared subject-token query compatibility', async function () {
    const res = await request(app).get('/api/v1/status.json').query({token: subjectToken}).expect(200);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.body.authorized.sub, 'status-fixture');
  });

  it('retains JWT query compatibility', async function () {
    const res = await request(app).get('/api/v1/status.json').query({token: jwt}).expect(200);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.body.authorized.sub, 'status-fixture');
  });

  it('retains API-secret query compatibility', async function () {
    await request(app).get('/api/v1/status.json').query({secret: hash}).expect(200);
  });

  it('refuses a private status request without credentials', async function () {
    await request(app).get('/api/v1/status.json').expect(401);
  });
});
