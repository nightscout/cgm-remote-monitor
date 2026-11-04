'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter, once } = require('node:events');
const { MongoClient, ObjectId } = require('mongodb');
const express = require('express');
const request = require('supertest');

describe('shipping authorization exchange compatibility boundary', function () {
  this.timeout(15000);
  const prefix = 'test_exchange_' + crypto.randomUUID().replaceAll('-', '') + '_';
  const id = new ObjectId();
  const hash = (value, algorithm = 'sha1') => crypto.createHash(algorithm).update(value).digest('hex');
  let client, subjects, roles, authorization, enclave, server, root, env;

  async function reload () {
    await new Promise((resolve, reject) => authorization.storage.reload(error => error ? reject(error) : resolve()));
  }

  function exchange (credential) {
    return request(server).get('/api/v2/authorization/request/' + encodeURIComponent(credential));
  }

  function refused (response) {
    assert.equal(response.status, 401);
    assert.deepEqual(response.body, {
      status: 401, message: 'Unauthorized', description: 'Invalid/Missing'
    });
  }

  before(async function () {
    client = new MongoClient(process.env.CUSTOMCONNSTR_mongo || 'mongodb://127.0.0.1:27017/test');
    await client.connect();
    const db = client.db();
    subjects = db.collection(prefix + 'subjects');
    roles = db.collection(prefix + 'roles');
    root = crypto.randomBytes(24).toString('hex');
    enclave = require('../lib/server/enclave')();
    enclave.setApiKey(root);
    enclave.setJWTKey(crypto.randomBytes(32).toString('hex'));
    env = {
      enclave, authentication_collections_prefix: prefix, trustProxy: false,
      settings: { authDefaultRoles: 'readable', authFailDelay: 0 }
    };
    authorization = require('../lib/authorization')(env, {
      store: db, bus: new EventEmitter(), settings: {}, moment: require('moment'),
      language: { translate: value => value }
    });
    const app = express();
    app.use(require('../lib/middleware/send-json-status')());
    app.use(express.json());
    app.use('/api/v2/authorization', authorization.endpoints);
    app.all('/legacy-probe', authorization.isPermitted('api:entries:read'), (req, res) => res.json({ readable: true }));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
  });

  beforeEach(async function () {
    await subjects.deleteMany({});
    await roles.deleteMany({});
    await subjects.insertOne({ _id: id, name: 'Shared.Name Alpha', roles: ['upload', 'upload', 'missing'] });
    await roles.insertOne({ name: 'upload', permissions: ['api:entries:create'] });
    await reload();
  });

  after(async function () {
    try {
      if (subjects) await subjects.drop();
      if (roles) await roles.drop();
    } finally {
      if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      if (client) await client.close();
    }
  });

  it('exchanges shipping subject carriers in the path, canonicalizes JWTs and preserves response timing/shape', async function () {
    const subject = authorization.storage.subjects[0];
    const earlier = Math.floor(Date.now() / 1000) - 120;
    const jwt = enclave.signJWT({ accessToken: subject.accessToken, iat: earlier });
    for (const credential of [subject.accessToken, subject.digest, subject.digest.slice(0, 16),
      subject.accessTokenDigest, subject.accessTokenDigest.slice(0, 16),
      'other-presentation-' + subject.digest.slice(0, 16), jwt]) {
      const before = Math.floor(Date.now() / 1000);
      const response = await exchange(credential);
      assert.equal(response.status, 200);
      assert.deepEqual(Object.keys(response.body).sort(), ['exp', 'iat', 'permissionGroups', 'sub', 'token']);
      assert.equal(response.body.sub, 'Shared.Name Alpha');
      assert.deepEqual(response.body.permissionGroups, [['api:entries:create'], [], ['*:*:read']]);
      assert.equal(response.body.exp - response.body.iat, 8 * 60 * 60);
      assert.ok(response.body.iat >= before && response.body.iat <= Math.floor(Date.now() / 1000));
      const decoded = enclave.verifyJWT(response.body.token);
      assert.deepEqual(Object.keys(decoded).sort(), ['accessToken', 'exp', 'iat']);
      assert.ok(decoded.accessToken === subject.accessToken);
      assert.equal(decoded.iat, response.body.iat);
      assert.equal(decoded.exp, response.body.exp);
    }
  });

  it('does not exchange root credentials or take its credential from headers, query or body', async function () {
    const token = authorization.storage.subjects[0].accessToken;
    for (const credential of [hash(root), hash(root, 'sha512'), root]) {
      refused(await exchange(credential));
    }
    refused(await exchange('invalid').set('api-secret', hash(root)).set('Authorization', 'Bearer ' + token));
    refused(await exchange('invalid').query({ token, secret: hash(root) }));
    refused(await exchange('invalid').send({ token, secret: hash(root) }));
    assert.equal((await request(server).get('/api/v2/authorization/request').query({ token })).status, 404);
    assert.equal((await request(server).post('/api/v2/authorization/request/' + token)).status, 404);
  });

  it('uses the reloaded current name and role snapshot, not permissions embedded in a JWT', async function () {
    const first = await exchange(authorization.storage.subjects[0].accessToken);
    assert.equal(first.status, 200);
    await subjects.updateOne({ _id: id }, { $set: { name: 'Shared.Name Beta', roles: ['upload'] } });
    await roles.updateOne({ name: 'upload' }, { $set: { permissions: ['api:profile:read'] } });
    await reload();
    const response = await exchange(first.body.token);
    assert.equal(response.status, 200);
    assert.equal(response.body.sub, 'Shared.Name Beta');
    assert.deepEqual(response.body.permissionGroups, [['api:profile:read'], ['*:*:read']]);
    assert.ok(authorization.storage.subjects[0].accessToken.startsWith('sharedname-'));
  });

  it('refuses unknown, bad, expired and removed-subject tokens instead of returning anonymous permissions', async function () {
    const subject = authorization.storage.subjects[0];
    const valid = enclave.signJWT({ accessToken: subject.accessToken });
    const expired = enclave.signJWT({ accessToken: subject.accessToken,
      iat: Math.floor(Date.now() / 1000) - 60 }, 1);
    const unknown = enclave.signJWT({ accessToken: 'unknown-subject' });
    for (const credential of ['invalid', 'null', expired, unknown, valid + 'broken']) {
      refused(await exchange(credential));
    }
    await subjects.deleteOne({ _id: id });
    await reload();
    refused(await exchange(valid));
  });

  it('distinguishes no credential from invalid supplied credentials in each shipping anonymous mode', async function () {
    for (const mode of ['denied', 'readable', 'status-only']) {
      const instance = require('../lib/authorization')({ ...env, settings: {
        ...env.settings, authDefaultRoles: mode
      } }, {
        store: client.db(), bus: new EventEmitter(), settings: {}, moment: require('moment'),
        language: { translate: value => value }
      });
      await new Promise((resolve, reject) => instance.storage.reload(error => error ? reject(error) : resolve()));
      const anonymous = await instance.resolve({ ip: '127.0.0.1' });
      assert.equal(anonymous.defaults, true);
      assert.equal(instance.checkMultiple('api:entries:read', anonymous.shiros), mode === 'readable');
      assert.equal(instance.checkMultiple('api:status:read', anonymous.shiros), mode !== 'denied');
      assert.equal(instance.checkMultiple('api:entries:create', anonymous.shiros), false);
      assert.deepEqual(await instance.resolve({ ip: '127.0.0.1', token: 'invalid' }), {});
      assert.deepEqual(await instance.resolve({ ip: '127.0.0.1', api_secret: 'invalid' }), {});
    }
  });

  it('exposes legacy extraction anonymous fallback separately from exchange refusal', async function () {
    assert.equal((await request(server).get('/legacy-probe')).status, 200);
    // Legacy extraction loses invalid query/body tokens before resolve sees
    // them. This is an observed single-site conflict, not a tenant contract.
    assert.equal((await request(server).get('/legacy-probe').query({ token: 'invalid' })).status, 200);
    assert.equal((await request(server).post('/legacy-probe').send({ token: 'invalid' })).status, 200);
    assert.equal((await request(server).get('/legacy-probe').set('Authorization', 'bearer invalid')).status, 200);
    refused(await request(server).get('/legacy-probe').set('Authorization', 'Bearer invalid'));
    refused(await request(server).get('/legacy-probe').query({ secret: 'invalid' }));
    refused(await exchange('invalid'));
  });
});
