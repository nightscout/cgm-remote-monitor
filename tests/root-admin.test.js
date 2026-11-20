'use strict';

// covers: lib/server/tenant-app/root-admin.js, lib/server/serve/preview-config.js, lib/subject-admin/owner-policy.js
// Decisions tenant-root-single-site-parity and root-may-edit-owner-subjects: the
// tenant root secret reaches the single-site admin tools routes on the DATA
// listener, bound to the resolved tenant, through the owner-aware root plane.
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { createRootAdminRouter, createRootAuthentication } = require('../lib/server/tenant-app/root-admin');
const { createOwnerPolicy } = require('../lib/subject-admin/owner-policy');
const { PreviewConfigError } = require('../lib/server/serve/preview-config');

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const ROOT = { [A]: 'a'.repeat(40), [B]: 'b'.repeat(40) };

describe('tenant root admin tools routes (no database)', function () {
  const verifierContext = tenant => ({ tenant, principal: 'preview-api', consumer: 'tenant-api' });
  const secrets = {
    async verifyLegacyCredential (context, { apiSecret }) {
      if (apiSecret === ROOT[context.tenant]) return { kind: 'root' };
      return apiSecret === 'subject-token' ? { kind: 'subject', subjectId: 'x' } : null;
    },
    async rootLegacyTokens (context, { apiSecret }) {
      return apiSecret === ROOT[context.tenant] ? new Map([['s1', 'one-0123456789abcdef']]) : null;
    },
    async exchangeLegacyCredential () { return null; },
    async adminLegacyTokens () { return null; }
  };
  const authority = { subjectAuthorizationSnapshot: async () => null };
  function app (calls) {
    const admin = {};
    for (const method of ['list', 'listRoles', 'create', 'createRole', 'updateRole', 'removeRole', 'update', 'remove']) {
      admin[method] = async (actor, ...args) => {
        calls.push([method, actor, ...args]);
        if (method === 'list') return [{ subjectId: 's1', name: 'One', roles: ['readable'], notes: null }];
        if (method === 'listRoles') return [{ name: 'readable', permissions: ['*:*:read'] }];
        if (method === 'create') return { subjectId: 'new', ...args[0] };
        if (method === 'createRole' || method === 'updateRole') return args[0];
        if (method === 'update') return { subjectId: args[0], ...args[1] };
        return true;
      };
    }
    const server = express();
    const hosts = { 'one.example.test': A, 'two.example.test': B };
    server.use('/api/v2/authorization', createRootAdminRouter({ resolveTenant: async req => hosts[req.hostname],
      authenticateRoot: createRootAuthentication({ secrets, authority, verifierContext, tenants: [A, B] }), subjectAdmin: admin }));
    server.use((req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
    return server;
  }

  it('requires its trusted composition', function () {
    assert.throws(() => createRootAdminRouter({}), TypeError);
    assert.throws(() => createRootAuthentication({ secrets, authority, verifierContext }), TypeError);
    assert.throws(() => createRootAuthentication({ secrets, verifierContext, tenants: [A] }), TypeError);
    assert.throws(() => createRootAuthentication({ secrets: { verifyLegacyCredential () {} }, authority, verifierContext, tenants: [A] }), TypeError);
    assert.throws(() => createOwnerPolicy({ namespace: 'auth', catalogue: ['*'], plane: 'operator' }), TypeError);
    assert.equal(createOwnerPolicy({ namespace: 'auth', catalogue: ['*'], plane: 'root' }).plane, 'root');
    assert.equal(createOwnerPolicy({ namespace: 'auth', catalogue: ['*'] }).plane, 'owner');
  });

  it('reads the subject and its roles once per admin-tools authentication and checks every permission in memory', async function () {
    let reads = 0;
    const counted = { ...secrets, async verifyLegacyCredential (context, { apiSecret }) {
      return apiSecret === 'admin-token' ? { kind: 'subject', subjectId: 'admin' } : apiSecret === 'reader-token'
        ? { kind: 'subject', subjectId: 'reader' } : secrets.verifyLegacyCredential(context, { apiSecret });
    }, async adminLegacyTokens (context, currentAuthority) { return await currentAuthority() === true ? new Map() : null; } };
    const grants = { admin: ['admin:api:subjects:read', 'admin:api:subjects:write'], reader: ['api:entries:read'] };
    const snapshot = principal => ({ subject: { sub: principal.subjectId, permissionGroups: [grants[principal.subjectId]] },
      allows: permission => grants[principal.subjectId].includes(permission) });
    // Every read path counts, so a second authority read on any of them shows up.
    const store = { authorize: async ({ principal, permission }) => { reads++; return snapshot(principal).allows(permission); },
      subjectSnapshot: async ({ principal }) => { reads++; return snapshot(principal).subject; },
      subjectAuthorizationSnapshot: async ({ principal }) => { reads++; return snapshot(principal); } };
    const authenticate = createRootAuthentication({ secrets: counted, authority: store, verifierContext, tenants: [A] });
    const legacy = token => ({ method: 'GET', path: '/subjects', query: { token }, rawHeaders: [], headers: {}, header: () => undefined });
    const admitted = await authenticate({ tenant: A, request: legacy('admin-token'), permission: 'admin:api:subjects:write' });
    assert.equal(admitted.actor.principal, 'admin'); assert(await admitted.tokens() instanceof Map);
    assert.equal(reads, 1, 'ONE_AUTHORITY_READ_PER_ADMIN_AUTHENTICATION');
    reads = 0;
    assert.equal(await authenticate({ tenant: A, request: legacy('reader-token'), permission: 'admin:api:subjects:read' }), null, 'SUBJECT_WITHOUT_ROUTE_PERMISSION_REFUSED');
    assert.equal(reads, 1);
    reads = 0;
    const root = await authenticate({ tenant: A, request: { method: 'GET', path: '/subjects', query: {}, rawHeaders: ['api-secret', ROOT[A]], headers: {}, header: () => undefined }, permission: 'admin:api:subjects:write' });
    assert.equal(root.actor.principal, 'root'); assert.equal(reads, 0, 'ROOT_READS_NO_SUBJECT_AUTHORITY');
  });

  it('serves the single-site payloads to the resolved tenant\'s root only', async function () {
    const calls = [];
    const server = app(calls);
    const listed = await request(server).get('/api/v2/authorization/subjects').set('Host', 'one.example.test').set('api-secret', ROOT[A]);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body, [{ _id: 's1', name: 'One', roles: ['readable'], accessToken: 'one-0123456789abcdef' }]);
    const saved = await request(server).put('/api/v2/authorization/subjects').set('Host', 'one.example.test').set('api-secret', ROOT[A])
      .type('form').send('_id=s1&name=One&roles%5B%5D=readable&notes=&accessToken=one-0123456789abcdef');
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(calls.at(-1), ['update', { tenant: A, principal: 'root', consumer: 'tenant-api' }, 's1', { name: 'One', roles: ['readable'], notes: '' }]);
    const role = await request(server).post('/api/v2/authorization/roles').set('Host', 'one.example.test').set('api-secret', ROOT[A])
      .type('form').send('name=careportal&permissions%5B%5D=api%3Atreatments%3Acreate&notes=');
    assert.deepEqual(role.body, { _id: 'careportal', name: 'careportal', permissions: ['api:treatments:create'] });
    const before = calls.length;
    for (const [host, secret] of [['one.example.test', ROOT[B]], ['two.example.test', ROOT[A]], ['one.example.test', 'subject-token'],
      ['one.example.test', undefined], ['three.example.test', ROOT[A]]]) {
      let pending = request(server).delete('/api/v2/authorization/subjects/s1').set('Host', host);
      if (secret) pending = pending.set('api-secret', secret);
      const response = await pending;
      assert.equal(response.status, 401, host + ' ' + secret);
      assert.deepEqual(response.body, { status: 401, message: 'Unauthorized', description: 'Invalid/Missing' });
    }
    // A bearer token alongside the secret is ambiguous, not root.
    assert.equal((await request(server).get('/api/v2/authorization/subjects').set('Host', 'one.example.test')
      .set('api-secret', ROOT[A]).set('Authorization', 'Bearer synthetic')).status, 401);
    assert.equal(calls.length, before, 'no refused request reached the writer');
  });

  it('refuses malformed bodies, an _id on create and a role rename before the writer', async function () {
    const calls = [];
    const server = app(calls);
    const send = (method, target, body) => request(server)[method]('/api/v2/authorization' + target)
      .set('Host', 'one.example.test').set('api-secret', ROOT[A]).type('form').send(body);
    for (const [method, target, body, status] of [['post', '/subjects', '_id=s1&name=One', 400], ['post', '/subjects', 'name=&roles%5B%5D=x', 400],
      ['put', '/subjects', 'name=One', 400], ['post', '/subjects', 'name=One&owner=true', 400], ['post', '/roles', 'name=bad%20name', 400],
      ['put', '/roles', '_id=readable&name=renamed&permissions%5B%5D=api%3Aentries%3Aread', 400], ['put', '/roles', 'name=readable', 400]]) {
      const response = await send(method, target, body);
      assert.equal(response.status, status, method + ' ' + target + ' ' + body);
    }
    assert.deepEqual(calls, []);
  });
});

describe('preview root subject administration configuration', function () {
  const url = name => 'postgres://synthetic-' + name + ':synthetic@127.0.0.1:15432/root_admin_test';
  // The api's validator on a registry-mode configuration value.
  function parse (subjectAdmin, extra = {}) {
    return require('../lib/server/serve/preview-config').parse({ version: 1, writeClock: true,
      postgres: { connectionEnv: 'RA_API_PG', readinessConnectionEnv: 'RA_READINESS_PG',
        namespaces: { entries: 'ra_entries', authorization: 'ra_authorization', secrets: 'ra_secrets', legacy: 'ra_legacy', clock: 'ra_clock', access: 'ra_access' } },
      vault: { address: 'http://127.0.0.1:8200', mount: 'ra_transit', allowInsecureLoopback: true, tokenEnv: 'RA_VAULT' },
      localDataAuthentication: 'node', accessTokens: { issuer: 'ra-data', audience: 'ra-api' },
      resolution: { mode: 'direct-alias' }, registry: { namespace: 'ra_registry' },
      tenantSettings: { connectionEnv: 'RA_SETTINGS_PG', namespaces: { settings: 'ra_settings', operatorPolicy: 'ra_policy' } },
      ...(subjectAdmin === undefined ? {} : { subjectAdmin }) },
    { RA_API_PG: url('api'), RA_READINESS_PG: url('readiness'), RA_SETTINGS_PG: url('settings'), RA_VAULT: 'synthetic', ...require('./fixtures/signing-secret').env(), ...extra });
  }

  it('is absent by default and selects a separate writer identity on the same database', function () {
    assert.equal(parse().subjectAdmin, undefined);
    // Decision root-grant-ceiling-default-all: '*' within tenant data unless narrowed.
    assert.deepEqual(parse({ writerConnectionEnv: 'RA_ROOT_PG' }, { RA_ROOT_PG: url('root') }).subjectAdmin.ownerPolicy, { catalogue: ['*'] });
    assert.deepEqual(parse({ writerConnectionEnv: 'RA_ROOT_PG', ownerPolicy: { catalogue: ['api:entries:read'] } }, { RA_ROOT_PG: url('root') })
      .subjectAdmin.ownerPolicy, { catalogue: ['api:entries:read'] });
    const parsed = parse({ writerConnectionEnv: 'RA_ROOT_PG', ownerPolicy: { catalogue: ['*'] } }, { RA_ROOT_PG: url('root') });
    assert.deepEqual(parsed.subjectAdmin, { connectionString: url('root'), ownerPolicy: { catalogue: ['*'] } });
    for (const [subjectAdmin, extra] of [[{ writerConnectionEnv: 'RA_API_PG', ownerPolicy: { catalogue: ['*'] } }, {}],
      [{ writerConnectionEnv: 'RA_READINESS_PG', ownerPolicy: { catalogue: ['*'] } }, {}],
      [{ writerConnectionEnv: 'RA_ROOT_PG', ownerPolicy: { catalogue: ['*'] } }, { RA_ROOT_PG: url('root').replace('root_admin_test', 'other') }],
      [{ writerConnectionEnv: 'RA_ROOT_PG', ownerPolicy: {} }, { RA_ROOT_PG: url('root') }],
      [{ writerConnectionEnv: 'RA_ROOT_PG', ownerPolicy: { catalogue: [] } }, { RA_ROOT_PG: url('root') }],
      [{ writerConnectionEnv: 'RA_ROOT_PG', ownerPolicy: { catalogue: ['*'] }, plane: 'owner' }, { RA_ROOT_PG: url('root') }]]) {
      assert.throws(() => parse(subjectAdmin, extra), PreviewConfigError, JSON.stringify(subjectAdmin));
    }
  });
});

describe('preview API boot composes root subject administration only when selected', function () {
  const Module = require('node:module');
  const scope = require('../lib/storage/tenant-scope');
  let previous;
  before(() => { previous = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  after(() => scope.setTenancyMode(previous));
  async function boot (subjectAdmin) {
    const seen = { stores: [], closed: [] };
    const resource = name => ({ end: async () => { seen.closed.push(name); } });
    const stubs = {
      '../../storage/postgres-connection': async () => resource('data'),
      '../../secrets/component': { createSecrets: () => ({ verifyLegacyCredential: async () => null, rootLegacyTokens: async () => null,
        exchangeLegacyCredential: async () => null, adminLegacyTokens: async () => null }) },
      '../../secrets/postgres': { createPostgresSecrets: async () => ({ ...resource('secrets'), store: { get: async () => ({}) } }) },
      '../../secrets/legacy-postgres': async () => ({ ...resource('legacy'), read: async () => ({ reference: { tenant: A, id: 'synthetic' } }) }),
      '../../tenant-authorization/postgres': async () => ({ ...resource('authority'), subjectAuthorizationSnapshot: async () => null }),
      '../../subject-admin/postgres': async options => {
        seen.stores.push(options);
        return { plane: options.plane, close: async () => { seen.closed.push('root-writer'); },
          list: async () => [], listRoles: async () => [], create: async () => ({}), createRole: async () => ({}),
          updateRole: async () => ({}), removeRole: async () => true, update: async () => ({}), remove: async () => true };
      },
      '../tenant-app/data-access': () => () => null, '../tenant-app/local-exchange': () => async () => null, '../../secrets/legacy-verifiers': { create: () => ({ verifyLegacyCredential: async () => null }) }, '../../tenant-authorization/legacy-data-token': { create: () => ({ verify () {}, issue () {} }) },
      '../tenant-app': { createTenantApp: options => { seen.rootAdmin = options.rootAdmin; return express.Router(); } },
      './role-readiness': require('./fixtures/role-readiness')(),
      './preview-domains': async () => ({ data: express.Router(), v3Names: [], legacyNames: [], safeRoutes: {}, prepareTenant: async () => {}, invalidateTenant () {}, invalidateAll () {} })
    };
    const oldLoad = Module._load;
    const file = require.resolve('../lib/server/serve/preview-api'); delete require.cache[file];
    Module._load = function (name, ...args) { return Object.hasOwn(stubs, name) ? stubs[name] : oldLoad.call(this, name, ...args); };
    try {
      const role = await require(file).boot({ bindings: new Map([[A, { tenant: A, principal: 'preview-api', consumer: 'tenant-api' }]]),
        providers: new Map(), namespaces: { authorization: 'ra_authorization', legacy: 'ra_legacy', clock: 'ra_clock' }, ...(subjectAdmin ? { subjectAdmin } : {}) });
      await role.close();
    } finally { Module._load = oldLoad; delete require.cache[file]; }
    return seen;
  }

  it('builds no writer by default and the root-plane owner-aware writer when configured', async function () {
    const absent = await boot();
    assert.deepEqual(absent.stores, []); assert.equal(absent.rootAdmin, undefined);
    const selected = await boot({ connectionString: 'postgres://synthetic-root:synthetic@127.0.0.1/ra', ownerPolicy: { catalogue: ['*'] } });
    // Local DATA authentication always prepares verifiers for new credentials.
    assert.equal(typeof selected.stores[0].prepareCredential, 'function');
    assert.deepEqual(selected.stores.map(store => { const copy = { ...store }; delete copy.prepareCredential; return copy; }), [{ connectionString: 'postgres://synthetic-root:synthetic@127.0.0.1/ra', namespace: 'ra_authorization',
      credentialNamespace: 'ra_legacy', ownerPolicy: { catalogue: ['*'] }, plane: 'root', roleAdmitted: true }]);
    for (const method of ['authenticate', 'list', 'listRoles', 'create', 'createRole', 'updateRole', 'removeRole', 'update', 'remove']) {
      assert.equal(typeof selected.rootAdmin[method], 'function', method);
    }
    // The service admits only actors on the bound data consumer (authentication decided root or permission).
    await assert.rejects(selected.rootAdmin.list({ tenant: A, principal: 'root', consumer: 'admin' }), { code: 'SUBJECT_ADMIN_FORBIDDEN' });
    assert.ok(selected.closed.includes('root-writer'), 'the writer closes with the role');
  });
});
