'use strict';

// Operation-local reuse only: current SQL authority is read for every request.
// Synthetic row protocol tests count work; native authorization tests prove RLS.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const vm = require('node:vm');
const createSocketAuthority = require('../lib/server/realtime/authority').create;
const createDataAccess = require('../lib/server/tenant-app/data-access');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

async function fixture () {
  const states = new Map([[A, ['readable']], [B, ['denied']]]), queries = [];
  const file = require.resolve('../lib/tenant-authorization/postgres');
  const realRequire = Module.createRequire(file), output = { exports: {} };
  const connection = {
    async withTenant (tenant, fn) { return fn(); }, async end () {},
    async query (text, values) {
      if (text.includes('FROM pg_class')) return { rows: Array.from({ length: 4 }, () =>
        ({ secured: true, owns: false, reads: true, writes: false, column_reads: true })) };
      queries.push({ tenant: values[0], subject: values[1] });
      return { rows: states.has(values[0]) ? [{ anonymous_roles: states.get(values[0]), found_subject: null,
        role_name: null, found_role: null, permissions: null }] : [] };
    }
  };
  const requireMock = name => name === '../storage/postgres-connection' ? async () => connection
    : name === '../storage/tenant-scope' ? { getTenancyMode: () => 'multi' } : realRequire(name);
  vm.runInNewContext('(function(require,module,exports){' + fs.readFileSync(file, 'utf8') + '\n})', {}, { filename: file })(requireMock, output, output.exports);
  const authority = await output.exports({ connectionString: 'synthetic', namespace: 'synthetic_auth' });
  const socket = principal => createSocketAuthority({ authority,
    secrets: { async verifyLegacyCredential () { return principal; } },
    verifierContext: async tenant => ({ tenant }), admission: { allows: async () => true } });
  return { states, queries, authority, socket };
}

describe('operation-local authorization snapshots', function () {
  it('does one current SQL query for every root or anonymous socket decision, with no per-permission queries', async function () {
    for (const principal of [{ kind: 'anonymous' }, { kind: 'root' }]) {
      const f = await fixture();
      const actor = await f.socket(principal).verify({ tenant: A, namespace: '/', credential: {} });
      assert.equal(f.queries.length, 1, 'AUTHZ_SOCKET_ONE_QUERY');
      assert.equal(actor.permissions.read, true);
      assert.equal(actor.permissions.write, principal.kind === 'root');
      assert.equal(actor.permissions.ack, principal.kind === 'root');
      assert.equal(actor.collections.length, 6);
    }
  });

  it('detects revocation on the next operation and separates simultaneous tenants', async function () {
    const f = await fixture(), socket = f.socket({ kind: 'anonymous' });
    const verify = tenant => socket.verify({ tenant, namespace: '/', credential: {} });
    assert.equal((await verify(A)).permissions.read, true);
    f.states.set(A, ['denied']);
    const actors = await Promise.all([verify(A), verify(B)]);
    assert.deepEqual(actors.map(actor => actor.permissions.read), [false, false]);
    assert.equal(f.queries.length, 3, 'every independent operation reads authority again');
    f.states.set(B, ['readable']);
    const restored = await Promise.all([verify(A), verify(B)]);
    assert.deepEqual(restored.map(actor => actor.permissions.read), [false, true]);
  });

  it('keeps anonymous write floors and validates permissions and unknown authority', async function () {
    const f = await fixture();
    const snapshot = await f.authority.permissionSnapshot({ tenant: A, principal: { kind: 'anonymous' } });
    for (const permission of ['api:entries:create', '*:*:write', 'notifications:*:ack']) assert.equal(snapshot.allows(permission), false);
    assert.throws(() => snapshot.allows('bad permission'), { code: 'TENANT_AUTHORITY_PERMISSION_INVALID' });
    await assert.rejects(f.authority.permissionSnapshot({ tenant: '33333333-3333-4333-8333-333333333333', principal: { kind: 'root' } }),
      { code: 'TENANT_AUTHORITY_UNKNOWN' });
  });

  it('uses one fresh authority snapshot for REST discovery instead of a query for every advertised permission', async function () {
    const f = await fixture();
    const access = createDataAccess({ authority: f.authority,
      secrets: { async verifyLegacyCredential () { return { kind: 'anonymous' }; } },
      verifierContext: async tenant => ({ tenant, consumer: 'api' }), collections: ['entries', 'treatments'], safeRoutes: { 3: ['/status'] } });
    const request = () => ({ path: '/status', method: 'GET', query: {}, rawHeaders: [] });
    assert(await access({ tenant: A, request: request(), version: 3 }));
    assert.equal(f.queries.length, 1, 'AUTHZ_DISCOVERY_ONE_QUERY');
    f.states.set(A, ['denied']);
    assert(await access({ tenant: A, request: request(), version: 3 }));
    assert.equal(f.queries.length, 2, 'not shared between requests');
  });

  it('control: removing operation-local reuse restores repeated queries and makes the cost assertion red', async function () {
    const f = await fixture();
    const authority = { ...f.authority }; delete authority.permissionSnapshot;
    const socket = createSocketAuthority({ authority, secrets: { async verifyLegacyCredential () { return { kind: 'anonymous' }; } },
      verifierContext: async tenant => ({ tenant }), admission: { allows: async () => true } });
    await socket.verify({ tenant: A, namespace: '/', credential: {} });
    assert.equal(f.queries.length, 9, 'control really restores the per-permission SQL path');
    assert.throws(() => assert.equal(f.queries.length, 1, 'AUTHZ_SOCKET_ONE_QUERY'), /AUTHZ_SOCKET_ONE_QUERY/);
  });

  it('control: retaining a snapshot across requests permits revoked access and makes the refusal assertion red', async function () {
    const f = await fixture(), saved = await f.authority.permissionSnapshot({ tenant: A, principal: { kind: 'anonymous' } });
    const authority = { ...f.authority, permissionSnapshot: async () => saved };
    const socket = createSocketAuthority({ authority, secrets: { async verifyLegacyCredential () { return { kind: 'anonymous' }; } },
      verifierContext: async tenant => ({ tenant }), admission: { allows: async () => true } });
    f.states.set(A, ['denied']);
    const result = await socket.verify({ tenant: A, namespace: '/', credential: {} });
    assert.equal(result.permissions.read, true, 'stale snapshot mutation actually permits the revoked read');
    assert.throws(() => assert.equal(result.permissions.read, false, 'AUTHZ_NEXT_OPERATION_REVOKED'), /AUTHZ_NEXT_OPERATION_REVOKED/);
    assert.equal((await f.socket({ kind: 'anonymous' }).verify({ tenant: A, namespace: '/', credential: {} })).permissions.read, false);
  });
});
