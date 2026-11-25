'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const createAccess = require('../lib/server/tenant-app/data-access');
const legacyAuthorization = require('../lib/server/tenant-app/legacy-authorization');
const { createTenantApp } = require('../lib/server/tenant-app');
const scope = require('../lib/storage/tenant-scope');

describe('version-aware tenant REST authority invocation', function () {
  let mode;
  before(() => { mode = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  after(() => scope.setTenancyMode(mode));

  function fixture () {
    let name = 'Exact Synthetic Name';
    const calls = [];
    const dataAccess = createAccess({
      secrets: { async verifyLegacyCredential (context, credentials) {
        return credentials.token === 'synthetic' ? { kind: 'subject', subjectId: 'subject' } : null;
      }, async exchangeLegacyCredential (context, token) { return token === 'synthetic' ? { token } : null; } },
      verifierContext: async tenant => ({ tenant, consumer: 'api' }),
      authority: {
        async authorize (input) { calls.push(input); return true; },
        async subjectSnapshot () { return { sub: name }; }
      },
      legacyCollections: ['entries']
    });
    const router = express.Router();
    const auth = legacyAuthorization();
    router.use(express.json({ limit: '50mb' }));
    router.use(auth.isPermitted('api:entries:read'));
    router.post('/entries', auth.isPermitted('api:entries:create'), (req, res, next) => {
      auth.resolveWithRequest(req, (error, identity) => {
        if (error) return next(error);
        res.json({ body: req.body, subject: identity.subject, tenant: scope.currentTenant() });
      });
    });
    router.get('/entries', (req, res) => res.json([]));
    const unused = async () => { throw new Error('not installed'); };
    const app = createTenantApp({
      resolver: { resolve: async () => 'tenant-a' }, dataAccess, legacyRouter: router,
      verifyCredential: async () => null, authorizeRequest: async () => false,
      tenantSettings: { read: unused, replace: unused, rollback: unused },
      subjectPolicy: { read: unused, replace: unused }, dataRouter: express.Router()
    });
    return { app, calls, setName: value => { name = value; } };
  }

  it('authenticates after the parser, consumes selected array credentials once and inherits v1 under v2', async function () {
    for (const version of [1, 2]) {
      const { app, calls } = fixture();
      const response = await request(app).post('/api/v' + version + '/entries')
        .send([{ token: 'synthetic', sgv: 123 }, { sgv: 124 }]).expect(200);
      assert.deepEqual(response.body.body, [{ sgv: 123 }, { sgv: 124 }]);
      assert.equal(response.body.subject.name, 'Exact Synthetic Name');
      assert.equal(response.body.tenant, 'tenant-a');
      assert.deepEqual(calls.map(call => call.permission), ['api:entries:create', 'api:entries:read']);
    }
  });

  it('requires the current exact persisted name and refuses unknown methods before domain handlers', async function () {
    const { app, setName } = fixture();
    setName('');
    await request(app).post('/api/v1/entries').send({ token: 'synthetic', sgv: 123 }).expect(401);
    await request(app).put('/api/v1/entries').send({ token: 'synthetic' }).expect(405);
    await request(app).get('/api/v1/notifications/ack').expect(405);
  });

  it('retains implicit HEAD and automatic OPTIONS without anonymous mutation admission', async function () {
    const { app } = fixture();
    await request(app).head('/api/v2/entries?token=synthetic').expect(200);
    const options = await request(app).options('/api/v2/entries?token=synthetic').expect(200);
    assert.match(options.headers.allow, /GET/);
    assert.match(options.headers.allow, /POST/);
  });
});
