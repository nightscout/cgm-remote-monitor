'use strict';

// covers: lib/server/serve/admin-config.js, lib/server/serve/admin-preview.js, lib/server/serve/roles.js, lib/server/serve/index.js, lib/cli/commands/multitenant.js, deploy/multitenant/config.js

// The multitenant `admin` role's operator composition without a database: its
// configuration, its listener's exact route table, its refusals in serve, and
// the deployment plan's ownership_operator grants. The PostgreSQL/process run is
// tests/admin-role-ownership.integration.test.js. Synthetic identifiers only.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const serve = require('../lib/server/serve');
const { ROLES, describeComposition } = require('../lib/server/serve/roles');
const adminConfig = require('../lib/server/serve/admin-config');
const { PreviewConfigError } = require('../lib/server/serve/preview-config');
const { operatorHandler } = require('../lib/server/serve/admin-preview');
const ownershipService = require('../lib/tenant-ownership/service');
const clients = require('../lib/server/internal-api/clients');
const contracts = require('../lib/server/internal-api/contracts');
const plan = require('../deploy/multitenant/config');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const SOURCE = { NS_OWNERSHIP_PG: 'postgres://synthetic_ownership:synthetic-only@127.0.0.1:5432/nightscout_test' };
const valid = () => ({ version: 1, maxBytes: 65536, timeoutMs: 10000,
  ownership: { connectionEnv: 'NS_OWNERSHIP_PG', namespace: 'nsadm_authorization', lifecycleNamespace: 'nsadm_control',
    operator: { principal: 'synthetic_operator', consumer: 'operator_plane' }, tenants: [A, B] } });

describe('admin role: operator configuration', function () {
  it('parses the explicit ownership composition and keeps the connection in the environment reference', function () {
    const parsed = adminConfig.parse(valid(), SOURCE);
    assert.equal(parsed.ownership.connectionString, SOURCE.NS_OWNERSHIP_PG);
    assert.deepEqual(parsed.ownership.tenants, [A, B]);
    assert.equal(parsed.ownership.lifecycleNamespace, 'nsadm_control');
    assert.deepEqual(parsed.ownership.operator, { principal: 'synthetic_operator', consumer: 'operator_plane' });
    assert.equal(parsed.maxBytes, 65536);
  });

  it('refuses every malformed or widened configuration', function () {
    const cases = {
      'unknown top-level key': config => { config.modules = []; },
      'missing ownership': config => { delete config.ownership; },
      'version 2': config => { config.version = 2; },
      'unbounded request size': config => { config.maxBytes = 1048577; },
      'zero timeout': config => { config.timeoutMs = 0; },
      'inline connection string': config => { config.ownership.connectionEnv = SOURCE.NS_OWNERSHIP_PG; },
      'unset connection reference': config => { config.ownership.connectionEnv = 'NS_UNSET_PG'; },
      'system namespace': config => { config.ownership.namespace = 'pg_catalog'; },
      'public namespace': config => { config.ownership.namespace = 'public'; },
      'missing lifecycle namespace': config => { delete config.ownership.lifecycleNamespace; },
      'system lifecycle namespace': config => { config.ownership.lifecycleNamespace = 'pg_catalog'; },
      'lifecycle namespace equal to the authorization namespace': config => { config.ownership.lifecycleNamespace = 'nsadm_authorization'; },
      'operator with an extra field': config => { config.ownership.operator.tenant = A; },
      'operator principal with punctuation': config => { config.ownership.operator.principal = 'a b'; },
      'empty tenant list': config => { config.ownership.tenants = []; },
      'duplicate tenant': config => { config.ownership.tenants = [A, A]; },
      'nil tenant': config => { config.ownership.tenants = ['00000000-0000-0000-0000-000000000000']; },
      'uppercase tenant': config => { config.ownership.tenants = ['ABCDEF01-1111-4111-8111-111111111111']; },
      'extra ownership key': config => { config.ownership.credential = 'synthetic'; }
    };
    for (const [name, mutate] of Object.entries(cases)) {
      const config = valid(); mutate(config);
      assert.throws(() => adminConfig.parse(config, SOURCE), PreviewConfigError, name);
    }
    for (const url of ['mysql://u:p@h/d', 'postgres://u@h/d', 'postgres://u:p@h/d?sslmode=prefer', 'postgres://u:p@h/']) {
      assert.throws(() => adminConfig.parse(valid(), { NS_OWNERSHIP_PG: url }), PreviewConfigError, url);
    }
  });

  it('composes pool-operations on its own or beside ownership, for the listed kinds, and needs at least one service', function () {
    const POOLS = { ...SOURCE, NS_POOL_OPERATOR_PG: 'postgres://synthetic_pool_operator:synthetic-only@127.0.0.1:5432/nightscout_test' };
    const pools = { connectionEnv: 'NS_POOL_OPERATOR_PG', namespace: 'nsadm_pool', kinds: ['evaluator', 'vcpool'] };
    const only = adminConfig.parse({ version: 1, maxBytes: 65536, timeoutMs: 10000, pools }, POOLS);
    assert.equal(only.ownership, undefined); assert.deepEqual(only.pools.kinds, ['evaluator', 'vcpool']);
    assert.ok(adminConfig.parse({ ...valid(), pools }, POOLS).ownership);
    for (const bad of [{ version: 1, maxBytes: 65536, timeoutMs: 10000 }, { ...valid(), pools: { ...pools, kinds: [] } },
      { ...valid(), pools: { ...pools, kinds: ['Evaluator'] } }, { ...valid(), pools: { ...pools, kinds: ['evaluator', 'evaluator'] } },
      { ...valid(), pools: { ...pools, namespace: 'public' } }, { ...valid(), pools: { ...pools, members: 3 } }]) {
      assert.throws(() => adminConfig.parse(bad, POOLS), PreviewConfigError, JSON.stringify(bad.pools || 'no service'));
    }
  });
  it('requires MULTITENANT_ADMIN_CONFIG and refuses an unreadable or invalid file', function () {
    assert.throws(() => adminConfig.load({}), /admin requires MULTITENANT_ADMIN_CONFIG/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-admin-config-'));
    try {
      const file = path.join(dir, 'config.json');
      fs.writeFileSync(file, '{"version":1');
      assert.throws(() => adminConfig.load({ MULTITENANT_ADMIN_CONFIG: file, ...SOURCE }), /invalid explicit admin operator configuration/);
      fs.writeFileSync(file, JSON.stringify(valid()));
      assert.equal(adminConfig.load({ MULTITENANT_ADMIN_CONFIG: file, ...SOURCE }).ownership.namespace, 'nsadm_authorization');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('admin role: composition', function () {
  it('is a multitenant internal-plane writer with a runtime', function () {
    assert.equal(ROLES.admin.multitenant, true);
    assert.equal(typeof ROLES.admin.start, 'function');
    assert.equal(ROLES.admin.start(), require('../lib/server/serve/admin-preview'));
    assert.deepEqual(describeComposition(['admin']), { writers: ['admin'], readers: [], listeners: ['admin'], feedConsumers: [], egress: [] });
  });

  it('serves exactly the ownership-operations routes, through the named client', async function () {
    const calls = [];
    const ownership = {
      list: async (context, body) => { calls.push(['list', context, body]); return { owners: [] }; },
      add: async () => { throw new Error('unexpected'); }, transfer: async () => { throw new Error('unexpected'); }, recover: async () => { throw new Error('unexpected'); }
    };
    const operator = { principal: 'synthetic_operator', consumer: 'operator_plane' };
    const handler = operatorHandler([{ service: ownershipService.contract,
      create: token => ownershipService.operations({ token, ownership, operator }) }], { maxBytes: 65536, timeoutMs: 5000 }, () => true);
    assert.deepEqual([...handler.routes].sort(), Object.values(contracts.ownershipOperations.operations).map(op => 'POST ' + op.path).sort());
    const server = http.createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const client = clients.ownershipOperations({ url: 'http://127.0.0.1:' + server.address().port + '/', trust: 'network', maxBytes: 65536, timeoutMs: 5000 });
      assert.deepEqual(await client.listOwners({ tenant: A }), { outcome: 'listed', owners: [] });
      assert.deepEqual(calls, [['list', operator, { tenant: A }]]);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });

  it('refuses a composition without a module or with a missing handler before any listener binds', function () {
    assert.throws(() => operatorHandler([], { maxBytes: 65536, timeoutMs: 5000 }, () => true), { code: 'INTERNAL_API_COMPOSITION_INVALID' });
    const partial = { service: ownershipService.contract, create: () => ({ listOwners: async () => ({}), addOwner: async () => ({}), recoverOwner: async () => ({}) }) };
    assert.throws(() => operatorHandler([partial], { maxBytes: 65536, timeoutMs: 5000 }, () => true), /handlers must match the service contract exactly/);
  });

  it('serve refuses admin without its configuration and inside a lifecycle operation cohort', async function () {
    const env = { HOSTNAME: '127.0.0.1', PORT: 1337 }, source = { ADMIN_HOSTNAME: '127.0.0.2', ADMIN_PORT: '0' };
    await assert.rejects(serve.start(['admin'], env, null, source, {}), /admin requires explicit operator configuration/);
    await assert.rejects(serve.start(['admin'], env, null, source, { adminPreview: {}, operationConfig: {} }),
      /admin is not a lifecycle operation cohort participant/);
    // The plane rule: by default admin (127.0.0.1:1338) shares the consumer
    // fallback address on another port and passes it, reaching the configuration
    // check; on the consumer listener's own port it refuses before any boot.
    await assert.rejects(serve.start(['admin'], env, null, {}, {}), /admin requires explicit operator configuration/);
    await assert.rejects(serve.start(['admin'], env, null, { ADMIN_PORT: '1337' }, {}), /would share the consumer listener/);
  });
});

describe('admin role: deployment plan ownership_operator identity', function () {
  const layout = plan.layout('nsadm');
  const who = '"' + layout.roles.ownership_operator + '"';
  const ns = '"' + layout.namespaces.authorization + '"';

  it('grants exactly the ownership store\'s table shape and the lifecycle phase reads, nothing else', function () {
    const granted = plan.grants(layout).filter(sql => sql.includes(who));
    const control = '"' + layout.namespaces.control + '"';
    assert.deepEqual(granted, [
      'GRANT USAGE ON SCHEMA ' + ns + ' TO ' + who,
      'GRANT SELECT,UPDATE(owner_fence) ON ' + ns + '."tenant_authorization_config" TO ' + who,
      'GRANT SELECT,UPDATE(owner_fence) ON ' + ns + '."tenant_owner_policy" TO ' + who,
      'GRANT SELECT,INSERT,UPDATE(active,can_update,delegable) ON ' + ns + '."tenant_owner_actors" TO ' + who,
      'GRANT SELECT ON ' + ns + '."tenant_authorization_subjects" TO ' + who,
      'GRANT INSERT ON ' + ns + '."tenant_subject_admin_audit" TO ' + who,
      'GRANT USAGE ON SCHEMA ' + control + ' TO ' + who,
      ...['tenant_lifecycle_windows', 'tenant_lifecycle_requests', 'tenant_lifecycle_ceremony']
        .map(table => 'GRANT SELECT ON ' + control + '."' + table + '" TO ' + who)
    ]);
    // No grant names a clinical table: the restore census accepts these backends.
    for (const kind of require('../lib/tenant-lifecycle/clinical-catalogue').CLINICAL) {
      assert.equal(granted.some(sql => sql.includes('"' + kind + '"')), false, kind);
    }
  });

  it('is a separate identity from the owner, data and platform operator identities', function () {
    const roles = Object.values(layout.roles);
    assert.equal(new Set(roles).size, roles.length);
    for (const other of ['owner_writer', 'owner_reader', 'api', 'operator']) assert.notEqual(layout.roles[other], layout.roles.ownership_operator);
  });
});
