'use strict';

const assert = require('node:assert/strict');
const { validate, compile } = require('../lib/server/internal-api/schema');
const contracts = require('../lib/server/internal-api/contracts');
const A = '11111111-1111-4111-8111-111111111111';
const request = '00000000-0000-4000-8000-000000000001';
const identity = { window: 1, operations: 2 };
const status = { version: 1, participant: 'api_1', incarnation: request, namespace: 'lifecycle', roles: ['api'], tenants: [A], namespaces: ['clinical'], identity,
  datastore: { database: 'synthetic', database_oid: '16384', server_address: '127.0.0.1', server_port: 5432, postmaster_birth: '1700000000.0' },
  backends: [{ pid: 123, role: 'synthetic_api', birth: '1700000001.0' }], request };
const authorize = contracts.socketAuthority.operations.authorizeSocket;
const mutate = contracts.socketAuthority.operations.executeSocketMutation;
const alarm = contracts.alarmDelivery.operations.deliverAlarm;
const lifecycle = contracts.lifecycleParticipant.operations;
const refused = fn => assert.throws(fn, error => error.code === 'INTERNAL_API_SCHEMA_REFUSED' && error.message === 'INTERNAL_API_SCHEMA_REFUSED');

describe('Internal service API contracts', function () {
  it('fixes service ownership, names, wire paths and immutable versioned descriptors', function () {
    assert.deepEqual(Object.keys(contracts.socketAuthority.operations), ['authorizeSocket', 'executeSocketMutation']);
    assert.deepEqual(Object.keys(contracts.alarmDelivery.operations), ['deliverAlarm']);
    assert.deepEqual(Object.keys(contracts.lifecycleParticipant.operations), ['getStatus', 'invalidateTenant']);
    assert.deepEqual(Object.keys(contracts.ownershipOperations.operations), ['listOwners', 'addOwner', 'transferOwner', 'recoverOwner']);
    assert.deepEqual(Object.keys(contracts.connectorInspection.operations), ['inspectConnectors']);
    const paths = Object.values(contracts).flatMap(service => {
      // Connector metadata, alarm/cohort fencing and evaluator scheduling observations use v2.
      assert.equal(service.version, ['connector-inspection', 'alarm-delivery', 'lifecycle-participant', 'evaluator-inspection'].includes(service.id) ? 2 : 1);
      assert(Object.isFrozen(service.operations));
      return Object.values(service.operations).map(operation => {
        assert(Object.isFrozen(operation.request)); assert(Object.isFrozen(operation.response));
        return operation.path;
      });
    });
    assert.deepEqual(paths, ['/authorize', '/mutate', '/alarm', '/cohort/status', '/cohort/invalidate',
      '/ownership/list', '/ownership/add', '/ownership/transfer', '/ownership/recover', '/vcpool/inspect',
        '/evaluator/inspect', '/pool/get', '/pool/members']);
    assert.throws(() => { contracts.alarmDelivery.operations.getStatus = lifecycle.getStatus; }, TypeError);
  });
  it('accepts socket authority wire values and refuses unknown envelope, credential and permission fields', function () {
    const body = { host: 'a.example.test', tenant: A, namespace: '/', credential: { humanToken: 'synthetic-token' } };
    validate(authorize.request, body);
    validate(authorize.request, { ...body, credential: {} });
    validate(authorize.response, { denied: true });
    const response = { permissions: { read: true, write: false, write_treatment: false, ack: false }, collections: ['entries'], display: { units: 'mg/dl', showSeconds: false } };
    validate(authorize.response, response);
    for (const bad of [{ ...body, service: 'lifecycle-participant' }, { ...body, tenant: 'a' }, { ...body, credential: { root: true } }, { ...body, credential: { secret: 42 } }, { ...body, namespace: '/admin' }]) refused(() => validate(authorize.request, bad));
    for (const bad of [{ denied: false }, { ...response, denied: true }, { ...response, permissions: { ...response.permissions, admin: true } }, { ...response, collections: ['secrets'] }]) refused(() => validate(authorize.response, bad));
  });
  it('preserves canonical mutation payloads while rejecting unsupported event/namespace combinations and extra envelope fields', function () {
    const envelope = { tenant: A, credential: {}, namespace: '/', event: 'dbAdd', args: [{ collection: 'entries', data: { arbitraryDomainField: ['synthetic', 12] } }] };
    validate(mutate.request, { host: 'a.example.test', envelope });
    validate(mutate.request, { host: 'a.example.test', envelope: { ...envelope, namespace: '/alarm', event: 'ack', args: [1, 'synthetic-group', 60000] } });
    validate(mutate.response, { replyArgs: [[{ _id: 'synthetic', customField: true }]] });
    validate(mutate.response, { replyArgs: [] });
    for (const patch of [{ event: 'dropDatabase' }, { namespace: '/storage' }, { namespace: '/alarm' }, { transport: 'owned' }, { args: {} }]) refused(() => validate(mutate.request, { host: 'a.example.test', envelope: { ...envelope, ...patch } }));
    refused(() => validate(mutate.response, { replyArgs: [], accepted: true }));
  });
  it('fixes ownership operation identifiers and refuses credential-bearing or ambiguous ownership wire values', function () {
    const ownership = contracts.ownershipOperations.operations;
    const owner = { principal: 'subject_a', consumer: 'tenant-admin' };
    const body = { tenant: A, owner, delegable: ['api:*:read'], expectedOwners: [owner] };
    validate(ownership.addOwner.request, body);
    validate(ownership.recoverOwner.request, { ...body, expectedOwners: [] });
    validate(ownership.transferOwner.request, { tenant: A, from: owner, to: { ...owner, principal: 'subject_b' }, expectedOwners: [owner] });
    validate(ownership.listOwners.request, { tenant: A });
    for (const bad of [{ ...body, credential: 'x' }, { ...body, owner: { ...owner, token: 'x' } }, { ...body, tenant: 'A' },
      { ...body, expectedOwners: [owner, owner] }, { ...body, owner: { principal: 'a b', consumer: 'c' } }]) refused(() => validate(ownership.addOwner.request, bad));
    refused(() => validate(ownership.transferOwner.request, { tenant: A, from: owner, expectedOwners: [] }));
    validate(ownership.addOwner.response, { outcome: 'applied', code: null, event: request, owners: [owner] });
    validate(ownership.addOwner.response, { outcome: 'refused', code: 'OWNERSHIP_CONFLICT', event: request, owners: [] });
    validate(ownership.addOwner.response, { outcome: 'denied', code: 'OWNERSHIP_FORBIDDEN', event: null });
    validate(ownership.listOwners.response, { outcome: 'listed', owners: [owner] });
    for (const bad of [{ outcome: 'applied', code: null, event: request, owners: [] },
      { outcome: 'applied', code: null, event: request, owners: [owner], credential: 'x' },
      { outcome: 'refused', code: 'OWNERSHIP_FORBIDDEN', event: request, owners: [] },
      { outcome: 'denied', code: 'OWNERSHIP_FORBIDDEN', event: null, owners: [owner] },
      { outcome: 'denied', code: 'OWNERSHIP_CONFLICT', event: null }]) refused(() => validate(ownership.addOwner.response, bad));
    refused(() => validate(ownership.listOwners.response, { outcome: 'listed', owners: [{ ...owner, secret: 'x' }] }));
  });
  it('fixes the connector inspection read: counts and codes only, never an endpoint or credential', function () {
    const inspect = contracts.connectorInspection.operations.inspectConnectors;
    validate(inspect.request, {});
    refused(() => validate(inspect.request, { tenant: A }));
    const member = { mode: 'standalone', members: 1, ordinal: 0, eligible: true, reason: null, cycles: 3, liveOrdinals: null, conflicts: 0,
      observedReason: null, refusals: [{ key: 'source:401', count: 2 }] };
    const tenant = { tenant: A, status: 'refused', code: 'CONNECTOR_SOURCE_AUTH_FAILED', cycles: 3, lastSuccessAt: null,
      pulled: { entries: 0, treatments: 0, devicestatus: 0, profiles: 0 }, refusals: [{ key: 'source:401', count: 2 }],
      lastRefusal: { phase: 'source', status: 401, code: 'ERR_BAD_REQUEST', at: '2026-11-10T00:00:00.000Z' } };
    validate(inspect.response, { kind: 'vcpool', member, egress: { proxy: false }, tenants: [tenant] });
    for (const bad of [{ ...tenant, endpoint: 'https://ns.example.org/' }, { ...tenant, lastRefusal: { ...tenant.lastRefusal, url: 'x' } },
      { ...tenant, refusals: [{ key: 'source:https://x', count: 1 }] }, { ...tenant, status: 'running' }]) {
      refused(() => validate(inspect.response, { kind: 'vcpool', member, egress: { proxy: false }, tenants: [bad] }));
    }
    refused(() => validate(inspect.response, { kind: 'vcpool', member, egress: { proxy: 'http://proxy:3128' }, tenants: [] }));
  });
  it('preserves extensible notification payloads and fixes the handoff response without claiming device delivery', function () {
    const body = { tenant: A, id: request, attempt: 1, notification: { title: 'Synthetic', level: 2, customPluginField: true }, receipts: [{ providerSpecific: [1, null] }] };
    validate(alarm.request, body);
    validate(alarm.response, { accepted: true, receipt: null, clearedRequestIds: [] });
    refused(() => validate(alarm.request, { ...body, notification: [] }));
    refused(() => validate(alarm.request, { ...body, attempt: 0 }));
    refused(() => validate(alarm.request, { ...body, callback: 'ignored' }));
    refused(() => validate(alarm.response, { accepted: true, receipt: { deviceAcknowledged: true }, clearedRequestIds: [] }));
    refused(() => validate(alarm.response, { accepted: true, receipt: null, clearedRequestIds: [request] }));
  });
  it('requires complete lifecycle identities and exact invalidation acknowledgements', function () {
    validate(lifecycle.getStatus.request, { request }); validate(lifecycle.getStatus.response, status);
    validate(lifecycle.getStatus.response, { ...status, tenants: ['registry:synthetic_registry'] });
    validate(lifecycle.invalidateTenant.response, { ...status, tenant: A, tenants: ['registry:synthetic_registry'] });
    for (const tenants of [['registry:synthetic_registry', A], ['registry:one','registry:two'], ['registry:public'], ['registry:pg_private'], ['arbitrary']]) refused(() => validate(lifecycle.getStatus.response, { ...status, tenants }));
    validate(lifecycle.invalidateTenant.request, { request, tenant: A, incarnation: request, identity });
    validate(lifecycle.invalidateTenant.response, { ...status, tenant: A });
    for (const bad of [{ ...status, tenant: A }, { ...status, identity: {} }, { ...status, roles: ['api', 'api'] }, { ...status, roles: ['recovery'] }, { ...status, datastore: { ...status.datastore, password: 'synthetic' } }, { ...status, backends: [{ ...status.backends[0], pid: 0 }] }]) refused(() => validate(lifecycle.getStatus.response, bad));
    refused(() => validate(lifecycle.invalidateTenant.response, status));
    refused(() => validate(lifecycle.invalidateTenant.request, { request, tenant: A, incarnation: request, identity, force: true }));
  });
  it('fails unsupported schema vocabulary and exercises the implemented JSON Schema subset', function () {
    assert.throws(() => compile({ type: 'object', patternProperties: {} }), /Unsupported internal API schema/);
    assert.throws(() => compile({ type: 'unrecognized' }), /Unsupported internal API schema/);
    assert.throws(() => compile({ oneOf: [] }), /Unsupported internal API schema/);
    assert.throws(() => compile({ minItems: -1 }), /Unsupported internal API schema/);
    const schema = { type: 'object', minProperties: 1, maxProperties: 2, required: ['count'], properties: { count: { type: 'integer', minimum: 1, maximum: 4 }, label: { type: 'string', minLength: 1, maxLength: 2, pattern: '^[a-z]+$' } }, additionalProperties: false };
    validate(schema, { count: 1, label: 'ab' });
    for (const bad of [{}, { count: 1.5 }, { count: 5 }, { count: 1, label: 'abc' }, { count: 1, label: 'A' }, { count: 1, label: '' }, { count: 1, unknown: true }]) refused(() => validate(schema, bad));
    validate({ anyOf: [{ type: 'null' }, { type: 'number' }] }, null);
    refused(() => validate({ anyOf: [{ type: 'null' }, { type: 'number' }] }, '1'));
    refused(() => validate({ type: 'array', maxItems: 1, items: { type: 'boolean' } }, [true, false]));
    refused(() => validate({ type: 'array', minItems: 1, items: { type: 'boolean' } }, []));
    refused(() => validate({ type: 'array', items: { type: 'boolean' } }, [1]));
    refused(() => validate({ oneOf: [true, true] }, {}));
    refused(() => validate({ type: 'object', required: ['inherited'] }, Object.create({ inherited: true })));
  });
  it('ablation: the unknown-field guard goes red when additional-property rejection is removed', function () {
    const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path'), Module = require('node:module');
    const file = path.resolve(__dirname, '../lib/server/internal-api/schema.js');
    const source = fs.readFileSync(file, 'utf8');
    const marker = 'const additional = schema.additionalProperties === undefined ? () => true : compile(schema.additionalProperties);';
    assert(source.includes(marker), 'Schema ablation marker must match actual source');
    const output = { exports: {} };
    vm.runInThisContext('(function(require,module,exports){' + source.replace(marker, 'const additional = () => true;') + '\n})', { filename: file })(Module.createRequire(file), output, output.exports);
    const body = { host: 'a.example.test', tenant: A, namespace: '/', credential: {}, service: 'lifecycle-participant' };
    const guard = check => assert.throws(() => check(authorize.request, body), error => error.code === 'INTERNAL_API_SCHEMA_REFUSED');
    guard(validate);
    assert.throws(() => guard(output.exports.validate), error => error.code === 'ERR_ASSERTION' && error.message === 'Missing expected exception.');
  });
});
