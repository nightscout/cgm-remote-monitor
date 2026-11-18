'use strict';

// Selected private observations over the production transport. All facts and
// identifiers are synthetic; these tests open only finite local sockets.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const vm = require('node:vm');
const Module = require('node:module');
const transport = require('../lib/server/internal-api/transport');
const clients = require('../lib/server/internal-api/clients');
const contracts = require('../lib/server/internal-api/contracts');
const { validate } = require('../lib/server/internal-api/schema');
const { create } = require('../lib/server/serve/evaluator-readiness-witness');
const internalListener = require('../lib/server/serve/internal-listener');
const listenerConfig = require('../lib/server/internal-api/listener-config');
const service = contracts.evaluatorReadinessWitness;
const operation = service.operations.inspectReadinessWitness;
const RUNTIME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FOREIGN_RUNTIME = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LIMITS = Object.freeze({ maxBytes: 1048576, timeoutMs: 5000 });
const ids = Array.from({ length: 129 }, (_, i) => '00000000-0000-4000-8000-' + i.toString(16).padStart(12, '0'));
const copy = value => JSON.parse(JSON.stringify(value));
const selection = (tenants = ids.slice(0, 2)) => ({ runtimeId: RUNTIME, tenants: [...tenants] });

function facts () {
  let reads = 0;
  const count = fn => (...args) => { reads++; return fn(...args); };
  const identity = 'a'.repeat(64), sourceIdentity = 'b'.repeat(64);
  const inspect = create({ runtimeId: RUNTIME, hasTenant: tenant => ids.includes(tenant),
    runtimeFacts: count(selected => ({ runtimeId: RUNTIME, observedAt: 1700000000000, closed: false,
      tenants: selected.map(tenant => ({ tenant, generation: 1, acquired: true, inactive: false, withdrawn: false,
        booting: false, running: false, metadataPaused: false, verificationPending: false, code: null,
        pendingSince: null, pendingBoundMs: 120001, identity, sourceIdentity, settingsVersion: '1', policyGeneration: '1',
        proof: { tenant, runtimeId: RUNTIME, generation: 1, workerGeneration: 2, identity, sourceIdentity, settingsVersion: '1', policyGeneration: '1', windowCurrent:true } })) })),
    workerFacts: count(() => ({ available: true, generation: 2 })),
    windowFacts: count(() => ({ closed: false, operational: true, verifying: false, verificationFailed: false, sessionLost: false, probeFailed: false })),
    platformFacts: count(() => ({ ready: true, code: null })),
    sourceFacts: count(() => ({ healthy: true, schemaBlocked: false, schemaInFlight: 0, acceptedCutReady: true, ownerAvailable: true })),
    metadataFacts: count(() => ({ registryActive: true, assigned: true, sourceIdentity, settingsVersion: '1', policyGeneration: '1',paused:false,suspended:false }))
  });
  return { inspect, reads: () => reads };
}
const dto = body => facts().inspect(body);

async function unusedPort () {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function fixture (kind = 'uds', implementation = transport, limits = LIMITS) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-witness-'));
  fs.chmodSync(dir, 0o700);
  let listener, endpoint;
  try {
    endpoint = { ...(kind === 'uds' ? { socketPath: path.join(dir, 'w.sock') }
      : { url: 'http://127.0.0.1:' + await unusedPort(), trust: 'network' }), ...limits };
  } catch (error) { fs.rmSync(dir, { recursive: true, force: true }); throw error; }
  return { dir, endpoint,
    async open (handler, bounds = LIMITS, siblings = []) {
      listener = await implementation.compose(endpoint, [{ service, bounds, create: token => ({
        inspectReadinessWitness: (context, body) => { assert.equal(context.transport, token); return handler(body); }
      }) }, ...siblings]);
      return clients.evaluatorReadinessWitness(endpoint);
    },
    async close () { try { await listener?.close(); } finally { fs.rmSync(dir, { recursive: true, force: true }); } }
  };
}
function raw (endpoint, body, { headers, method = 'POST', route = operation.path } = {}) {
  const bytes = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const target = endpoint.socketPath ? { socketPath: endpoint.socketPath }
    : { hostname: '127.0.0.1', port: new URL(endpoint.url).port };
  return new Promise((resolve, reject) => {
    const req = http.request({ ...target, method, path: route, agent: false, headers: {
      'content-type': 'application/json', 'content-length': bytes.length,
      'x-nightscout-internal-service': service.id, 'x-nightscout-internal-version': String(service.version), ...headers
    } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(5000, () => req.destroy(new Error('SYNTHETIC_REQUEST_TIMEOUT')));
    req.on('error', reject); req.end(bytes);
  });
}
function refused (reply, error = 'SOCKET_IPC_UNAVAILABLE') {
  assert.equal(reply.status, 503, 'PRIVATE_REQUEST_MUST_REFUSE');
  assert.deepEqual(JSON.parse(reply.body), { error });
}
function load (relative, replacements, overrides = {}) {
  const filename = require.resolve(relative), original = fs.readFileSync(filename, 'utf8');
  let source = original;
  for (const [before, after] of replacements) {
    assert.equal(source.split(before).length, 2, 'CONTROL_MARKER_MUST_MATCH_ONCE: ' + before);
    source = source.replace(before, after);
  }
  const local = Module.createRequire(filename), output = { exports: {} };
  vm.runInThisContext('(function(require,module,exports){' + source + '\n})', { filename })(
    name => Object.hasOwn(overrides, name) ? overrides[name] : local(name), output, output.exports);
  return output.exports;
}
async function red (name, criterion, broken) {
  await assert.rejects(criterion(broken), error => {
    assert.equal(error.code, 'ERR_ASSERTION', 'Control must fail at its named assertion');
    console.log('EVALUATOR_WITNESS_TRANSPORT_CONTROL ' + JSON.stringify({ name, code: error.code,
      message: error.message, ...(error.actual === undefined ? {} : { actual: error.actual }),
      ...(error.expected === undefined ? {} : { expected: error.expected }) }));
    return true;
  });
}

describe('selected evaluator readiness witness v1 private transport', function () {
  this.timeout(15000);

  it('keeps one closed v1 service separate from the existing closed evaluator v3 contract', function () {
    assert.equal(service.id, 'evaluator-readiness-witness'); assert.equal(service.version, 1);
    assert.deepEqual(Object.keys(service.operations), ['inspectReadinessWitness']);
    assert.equal(operation.path, '/evaluator/readiness-witness');
    assert(Object.isFrozen(service)); assert(Object.isFrozen(operation.request));
    assert.equal(contracts.evaluatorInspection.version, 3);
    assert.throws(() => validate(contracts.evaluatorInspection.operations.inspectEvaluator.request, selection()), { code: 'INTERNAL_API_SCHEMA_REFUSED' });
    const oldDiagnostics = contracts.evaluatorInspection.operations.inspectEvaluator.request.properties.diagnostics;
    assert.throws(() => validate(oldDiagnostics, 'readiness-witness-v1'), { code: 'INTERNAL_API_SCHEMA_REFUSED' });
    validate(operation.request, selection()); validate(operation.response, dto(selection()));
  });

  for (const kind of ['uds', 'http']) {
    it(kind + ' refuses malformed and foreign scope before reading any fact provider', async function () {
      const f = await fixture(kind), observed = facts(); let handlers = 0;
      try {
        const client = await f.open(body => { handlers++; return observed.inspect(body); });
        const malformed = [{}, [], null, { tenants: [ids[0]] }, { runtimeId: RUNTIME },
          { ...selection(), unexpected: true }, { ...selection(), runtimeId: RUNTIME.toUpperCase() },
          { ...selection(), runtimeId: 'not-a-uuid' }, { ...selection(), tenants: null }, selection([]),
          selection([ids[0], ids[0]]), selection(ids), selection([42]), selection(['not-a-uuid']), '{invalid'];
        for (const body of malformed) {
          refused(await raw(f.endpoint, body));
          if (typeof body !== 'string') await assert.rejects(client.inspectReadinessWitness(body));
        }
        assert.equal(handlers, 0, 'Closed transport request validation must precede the composer');
        assert.equal(observed.reads(), 0);
        for (const body of [{ ...selection(), runtimeId: FOREIGN_RUNTIME }, selection([FOREIGN_RUNTIME])]) {
          refused(await raw(f.endpoint, body));
          await assert.rejects(client.inspectReadinessWitness(body));
          assert.equal(observed.reads(), 0, 'Unknown tenant/runtime must precede all cached fact providers');
        }
        const before = handlers;
        for (const version of ['0', '2', '01', '', '1, 1']) refused(await raw(f.endpoint, selection(), { headers: { 'x-nightscout-internal-version': version } }));
        for (const id of ['', contracts.evaluatorInspection.id, 'evaluator-readiness-witness, evaluator-inspection']) {
          refused(await raw(f.endpoint, selection(), { headers: { 'x-nightscout-internal-service': id } }));
        }
        for (const route of ['/evaluator/readiness-witness?all=true', '/evaluator/readiness-witness/', '/evaluator/inspect', '/%65valuator/readiness-witness']) {
          refused(await raw(f.endpoint, selection(), { route }));
        }
        refused(await raw(f.endpoint, selection(), { method: 'GET' }));
        refused(await raw(f.endpoint, selection(), { headers: { 'content-type': 'text/plain' } }));
        assert.equal(handlers, before); assert.equal(observed.reads(), 0);
        const reply = await client.inspectReadinessWitness(selection());
        assert.deepEqual(reply.tenants.map(row => row.tenant), selection().tenants);
        assert(reply.tenants.every(row => row.classification === 'ready'));
        assert(observed.reads() > 0, 'Restored selected request must reach the fact providers');
      } finally { await f.close(); }
    });

    it(kind + ' correlates otherwise valid replies with the exact sent runtime and tenant order', async function () {
      const f = await fixture(kind); let change = value => value;
      try {
        const client = await f.open(body => change(dto(body)));
        assert.deepEqual(Object.keys(client), ['inspectReadinessWitness']); assert(Object.isFrozen(client));
        const corruptions = [value => { value.runtimeId = FOREIGN_RUNTIME; },
          value => { value.tenants[0].tenant = ids[2]; }, value => { value.tenants.reverse(); },
          value => { value.tenants.pop(); }, value => { value.tenants[1] = copy(value.tenants[0]); },
          value => { value.tenants.push({ ...copy(value.tenants[0]), tenant: ids[2] }); }];
        for (const corrupt of corruptions) {
          change = value => { corrupt(value); validate(operation.response, value); return value; };
          await assert.rejects(client.inspectReadinessWitness(selection()), { code: 'EVALUATOR_READINESS_SELECTION_MISMATCH' });
        }
        change = value => value;
        const body = selection(), expected = copy(body), pending = client.inspectReadinessWitness(body);
        body.runtimeId = FOREIGN_RUNTIME; body.tenants.reverse(); body.tenants.push(ids[2]);
        const reply = await pending;
        assert.equal(reply.runtimeId, expected.runtimeId); assert.deepEqual(reply.tenants.map(row => row.tenant), expected.tenants);
        // Mutating the caller's object in the same turn must not make a foreign
        // response match a request that has already been serialized for sending.
        change = value => { value.runtimeId = FOREIGN_RUNTIME; value.tenants.reverse(); return value; };
        const attacked = selection(), refusedPending = client.inspectReadinessWitness(attacked);
        attacked.runtimeId = FOREIGN_RUNTIME; attacked.tenants.reverse();
        await assert.rejects(refusedPending, { code: 'EVALUATOR_READINESS_SELECTION_MISMATCH' });
        change = value => value;
        assert.deepEqual((await client.inspectReadinessWitness(selection())).tenants.map(row => row.tenant), selection().tenants);
      } finally { await f.close(); }
    });
  }

  it('rejects additional/missing nested fields, invented statuses, unbounded codes, and malformed nullable facts', async function () {
    const base = dto(selection([ids[0]])), mutations = [];
    const objects = [{ path: [], value: base }, ...Object.entries(base.tenants[0])
      .filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value))
      .map(([key, value]) => ({ path: ['tenants', 0, key], value })) , { path: ['tenants', 0], value: base.tenants[0] }];
    const at = (value, keys) => keys.reduce((current, key) => current[key], value);
    for (const entry of objects) {
      mutations.push(value => { at(value, entry.path).unexpected = 'synthetic'; });
      for (const key of Object.keys(entry.value)) mutations.push(value => { delete at(value, entry.path)[key]; });
      if (Object.hasOwn(entry.value, 'status')) mutations.push(value => { at(value, entry.path).status = 'healthy'; });
    }
    mutations.push(value => { value.kind = 'evaluator-inspection'; }, value => { value.version = 2; },
      value => { value.observedAt = Number.MAX_SAFE_INTEGER + 1; }, value => { value.observedAt = -1; },
      value => { value.tenants[0].generation = 1.5; }, value => { value.tenants[0].source.schemaInFlight = -1; },
      value => { value.tenants[0].worker.available = 'true'; }, value => { value.tenants[0].clinical.pendingBoundMs = '120001'; },
      value => { value.tenants[0].runtime.underlyingCode = 'raw exception details'; },
      value => { value.tenants[0].runtime.underlyingCode = 'EVALUATOR_' + 'X'.repeat(55); },
      value => { value.tenants[0].platform.code = 'SYNTHETIC_PROVIDER_EXCEPTION'; },
      value => { value.tenants[0].independentStatus = 'healthy'; }, value => { value.tenants[0].classification = 'admitted'; },
      value => { value.tenants[0].faults = ['SYNTHETIC_PROVIDER_EXCEPTION']; },
      value => { value.tenants[0].faults = ['WORKER_UNKNOWN', 'WORKER_UNKNOWN']; },
      value => { value.tenants = []; }, value => { value.tenants = Array(129).fill(copy(value.tenants[0])); });
    const f = await fixture(); let returned = base;
    try {
      const client = await f.open(() => returned);
      await client.inspectReadinessWitness(selection([ids[0]]));
      for (const mutate of mutations) {
        returned = copy(base); mutate(returned);
        assert.throws(() => validate(operation.response, returned), { code: 'INTERNAL_API_SCHEMA_REFUSED' });
        refused(await raw(f.endpoint, selection([ids[0]])));
        await assert.rejects(client.inspectReadinessWitness(selection([ids[0]])), /SOCKET_IPC_UNAVAILABLE/);
      }
      returned = copy(base);
      returned.tenants[0].runtime.underlyingCode = 'EVALUATOR_' + 'X'.repeat(54);
      await client.inspectReadinessWitness(selection([ids[0]]));
      console.log('EVALUATOR_WITNESS_MALFORMED_RESPONSE_CASES ' + mutations.length);
    } finally { await f.close(); }
  });

  it('the named client independently rejects malformed raw-peer responses and bounds reply bytes', async function () {
    let body = dto(selection()), status = 200, contentType = 'application/json';
    const server = http.createServer((req, res) => {
      req.resume(); req.on('end', () => { res.writeHead(status, { 'content-type': contentType }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const endpoint = { url: 'http://127.0.0.1:' + server.address().port, trust: 'network', ...LIMITS };
    try {
      const client = clients.evaluatorReadinessWitness(endpoint);
      await client.inspectReadinessWitness(selection());
      for (const invalid of [{ ...dto(selection()), unexpected: true }, { ...dto(selection()), version: 2 },
        { ...dto(selection()), tenants: [] }, 'null', '{invalid', JSON.stringify(dto(selection())) + ' '.repeat(LIMITS.maxBytes)]) {
        body = invalid; await assert.rejects(client.inspectReadinessWitness(selection()), /SOCKET_IPC_UNAVAILABLE/);
      }
      body = dto(selection()); status = 201;
      await assert.rejects(client.inspectReadinessWitness(selection()), /SOCKET_IPC_UNAVAILABLE/);
      status = 200; contentType = 'text/plain';
      await assert.rejects(client.inspectReadinessWitness(selection()), /SOCKET_IPC_UNAVAILABLE/);
      contentType = 'application/json'; await client.inspectReadinessWitness(selection());
    } finally { await new Promise(resolve => server.close(resolve)); }
  });

  it('fits the schema maximum selected DTO within one MiB and refuses selection 129 before effects', async function () {
    // Every required field gets its longest valid JSON representation. Faults
    // contain the entire unique closed vocabulary; numeric facts use MAX_SAFE.
    function largest (schema) {
      if (schema.enum) return schema.enum.map(copy).sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0];
      if (Object.hasOwn(schema, 'const')) return schema.const;
      if (schema.anyOf) return schema.anyOf.map(largest).sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0];
      if (schema.type === 'object') return Object.fromEntries(Object.entries(schema.properties).map(([key, child]) => [key, largest(child)]));
      if (schema.type === 'array') {
        assert(schema.items.enum, 'Only the closed fault array is expanded by this helper');
        return schema.items.enum.slice(0, schema.maxItems).map(copy);
      }
      if (schema.type === 'integer') return schema.maximum;
      if (schema.type === 'boolean') return false;
      if (schema.type === 'null') return null;
      if (schema.type === 'string' && schema.pattern.includes('EVALUATOR_')) return 'EVALUATOR_' + 'W'.repeat(54);
      if (schema.type === 'string' && schema.pattern.includes('[0-9a-f]')) return 'ffffffff-ffff-ffff-ffff-ffffffffffff';
      throw new Error('Unhandled witness schema bound');
    }
    const row = largest(operation.response.properties.tenants.items);
    const maximum = { kind: service.id, version: service.version, runtimeId: RUNTIME, observedAt: Number.MAX_SAFE_INTEGER,
      tenants: ids.slice(0, 128).map(tenant => ({ ...copy(row), tenant })) };
    validate(operation.response, maximum);
    const bytes = Buffer.byteLength(JSON.stringify(maximum));
    assert(bytes <= LIMITS.maxBytes, 'MAXIMUM_SELECTED_DTO_MUST_FIT_OWN_ROUTE_BOUND');
    console.log('EVALUATOR_WITNESS_MAXIMUM_DTO ' + JSON.stringify({ tenants: maximum.tenants.length, bytes, maxBytes: LIMITS.maxBytes }));
    const f = await fixture(); let calls = 0;
    try {
      const client = await f.open(() => { calls++; return maximum; });
      assert.deepEqual(await client.inspectReadinessWitness(selection(ids.slice(0, 128))), maximum);
      await assert.rejects(client.inspectReadinessWitness(selection(ids)), { code: 'INTERNAL_API_SCHEMA_REFUSED' });
      refused(await raw(f.endpoint, selection(ids)));
      assert.equal(calls, 1, 'Next selection bound must refuse before invoking the provider');
    } finally { await f.close(); }
  });

  it('keeps its own one-MiB request bound on a wider shared listener and honors exact response byte limits', async function () {
    const f = await fixture('uds', transport, { maxBytes: 4194304, timeoutMs: 5000 }); let calls = 0;
    try {
      await f.open(body => { calls++; return dto(body); }, LIMITS, [{ service: contracts.evaluatorInspection,
        bounds: { maxBytes: 4194304, timeoutMs: 5000 }, create: () => ({ inspectEvaluator: () => { throw Error('UNSELECTED_OLD_INSPECTION'); } }) }]);
      const text = JSON.stringify(selection()), exact = text + ' '.repeat(LIMITS.maxBytes - Buffer.byteLength(text));
      assert.equal((await raw(f.endpoint, exact)).status, 200);
      refused(await raw(f.endpoint, exact + ' ')); assert.equal(calls, 1);
    } finally { await f.close(); }
    const response = dto(selection()), responseBytes = Buffer.byteLength(JSON.stringify(response));
    for (const maxBytes of [responseBytes - 1, responseBytes]) {
      const exact = await fixture();
      try {
        await exact.open(() => response, { ...LIMITS, maxBytes });
        const reply = await raw(exact.endpoint, selection());
        if (maxBytes < responseBytes) refused(reply); else { assert.equal(reply.status, 200); assert.deepEqual(JSON.parse(reply.body), response); }
      } finally { await exact.close(); }
    }
  });

  it('uses only existing explicit network trust and private Unix directory/socket ownership', async function () {
    let created = 0;
    for (const trust of [undefined, false, true, 'authenticated', 'untrusted']) {
      const endpoint = { url: 'http://127.0.0.1:1', trust, ...LIMITS };
      assert.throws(() => clients.evaluatorReadinessWitness(endpoint), { code: 'SOCKET_IPC_CONFIG_REFUSED' });
      await assert.rejects(transport.compose(endpoint, [{ service, create: () => { created++; return {}; } }]), { code: 'SOCKET_IPC_CONFIG_REFUSED' });
    }
    assert.equal(created, 0, 'Untrusted configuration must refuse before operation factory/provider reads');
    const f = await fixture(); let calls = 0;
    try {
      const client = await f.open(body => { calls++; return dto(body); });
      fs.chmodSync(f.dir, 0o755);
      await assert.rejects(client.inspectReadinessWitness(selection()), { code: 'SOCKET_IPC_DIRECTORY_REFUSED' });
      fs.chmodSync(f.dir, 0o700); fs.chmodSync(f.endpoint.socketPath, 0o666);
      await assert.rejects(client.inspectReadinessWitness(selection()), { code: 'SOCKET_IPC_OWNERSHIP_REFUSED' });
      assert.equal(calls, 0);
      fs.chmodSync(f.endpoint.socketPath, 0o600); await client.inspectReadinessWitness(selection()); assert.equal(calls, 1);
    } finally { await f.close(); }
  });

  it('composes only under evaluator inspection opt-in, refuses foreign ownership, and keeps unbound calls not ready', async function () {
    for (const evaluatorPreview of [undefined, {}, { inspection: false }, { inspection: 'true' }]) assert.deepEqual(internalListener.plan(['evaluator'], { evaluatorPreview }), []);
    for (const role of ['api', 'realtime', 'tenant-admin', 'vcpool']) assert.deepEqual(internalListener.plan([role], { evaluatorPreview: { inspection: true } }), []);
    const rows = internalListener.plan(['evaluator'], { evaluatorPreview: { inspection: true } });
    assert.deepEqual(rows.map(row => row.id), [contracts.evaluatorInspection.id, service.id]);
    assert.deepEqual(rows.find(row => row.id === service.id), { id: service.id, roles: ['evaluator'], tenantScoped: false, bounds: LIMITS });
    assert.deepEqual(Object.entries(internalListener.OWNED).filter(([, owned]) => owned.includes(service.id)).map(([role]) => role), ['evaluator']);
    const f = await fixture(), observed = facts(); let listener;
    try {
      const config = listenerConfig.resolve(['evaluator'], { NS_SERVE_INTERNAL_SOCKET: f.endpoint.socketPath });
      assert.equal(await internalListener.open(config, []), null);
      assert.equal(fs.existsSync(f.endpoint.socketPath), false);
      listener = await internalListener.open(config, rows);
      assert(listener.routes.includes('POST ' + operation.path));
      assert.throws(() => listener.assertBound(), { code: 'INTERNAL_API_CONTRACT_UNBOUND' });
      refused(await raw(f.endpoint, selection()), 'SOCKET_IPC_NOT_READY'); assert.equal(observed.reads(), 0);
      const binding = { create: () => ({ inspectReadinessWitness: (_context, body) => observed.inspect(body) }) };
      assert.throws(() => listener.bind('api', { [service.id]: binding }), { code: 'INTERNAL_API_CONTRACT_UNOWNED' });
      assert.throws(() => listener.bind('evaluator', { [service.id]: { create: () => ({}) } }), { code: 'INTERNAL_API_BINDING_INVALID' });
      assert.equal(observed.reads(), 0);
      listener.bind('evaluator', { [service.id]: binding });
      assert.throws(() => listener.assertBound(), { code: 'INTERNAL_API_CONTRACT_UNBOUND' });
      listener.bind('evaluator', { [contracts.evaluatorInspection.id]: { create: () => ({ inspectEvaluator: () => { throw Error('OLD_ROUTE_NOT_CALLED'); } }) } });
      listener.assertBound();
      const reply = await clients.evaluatorReadinessWitness(f.endpoint).inspectReadinessWitness(selection());
      assert.deepEqual(reply.tenants.map(row => row.tenant), selection().tenants); assert(observed.reads() > 0);
      assert.throws(() => listener.bind('evaluator', { [service.id]: binding }), { code: 'INTERNAL_API_BINDING_INVALID' });
    } finally { await listener?.close(); await f.close(); }
  });

  it('control: a bypassed client scope check fails on a valid-schema foreign runtime reply, then restores', async function () {
    const f = await fixture();
    try {
      await f.open(body => ({ ...dto(body), runtimeId: FOREIGN_RUNTIME }));
      const criterion = implementation => assert.rejects(implementation.evaluatorReadinessWitness(f.endpoint).inspectReadinessWitness(selection()),
        { code: 'EVALUATOR_READINESS_SELECTION_MISMATCH' });
      await criterion(clients);
      const broken = load('../lib/server/internal-api/clients', [[
        "if(reply.runtimeId!==wire.runtimeId||!equal(reply.tenants.map(row=>row.tenant),wire.tenants))",
        'if(false)'
      ]]);
      await red('client-selection-correlation', criterion, broken); await criterion(clients);
    } finally { await f.close(); }
  });

  it('control: a missing request snapshot lets same-turn mutation authorize a different reply, then restores', async function () {
    const f = await fixture();
    try {
      await f.open(body => ({ ...dto(body), runtimeId: FOREIGN_RUNTIME, tenants: dto(body).tenants.reverse() }));
      const criterion = implementation => {
        const body = selection(), pending = implementation.evaluatorReadinessWitness(f.endpoint).inspectReadinessWitness(body);
        body.runtimeId = FOREIGN_RUNTIME; body.tenants.reverse();
        return assert.rejects(pending, { code: 'EVALUATOR_READINESS_SELECTION_MISMATCH' });
      };
      await criterion(clients);
      const broken = load('../lib/server/internal-api/clients', [[
        "const reply=await raw.inspectReadinessWitness(wire,signal);",
        'wire=body; const reply=await raw.inspectReadinessWitness(wire,signal);'
      ]]);
      await red('client-request-snapshot', criterion, broken); await criterion(clients);
    } finally { await f.close(); }
  });

  for (const control of [
    { name: 'service-version-admission', before: " || req.headers['x-nightscout-internal-version'] !== route.service.version", after: '',
      body: () => selection(), options: { headers: { 'x-nightscout-internal-version': '2' } } },
    { name: 'closed-request-schema', before: 'validate(route.request, body);', after: 'void body;',
      body: () => ({ ...selection(), unexpected: true }) },
    { name: 'route-request-byte-bound', before: 'if (size > route.maxBytes)', after: 'if (false)',
      body: () => JSON.stringify(selection()) + ' '.repeat(LIMITS.maxBytes) }
  ]) it('control: ' + control.name + ' fails at admission when bypassed, then restores', async function () {
    const criterion = async implementation => {
      const f = await fixture('uds', implementation); let reads = 0;
      try {
        await f.open(() => { reads++; return dto(selection()); });
        refused(await raw(f.endpoint, control.body(), control.options));
        assert.equal(reads, 0, 'Admission must precede provider reads');
        assert.equal((await raw(f.endpoint, selection())).status, 200); assert.equal(reads, 1);
      } finally { await f.close(); }
    };
    await criterion(transport);
    const broken = load('../lib/server/internal-api/transport', [[control.before, control.after]]);
    await red(control.name, criterion, broken); await criterion(transport);
  });

  it('control: accepting untrusted network configuration fails before any I/O, then restores', async function () {
    const criterion = async implementation => assert.throws(() => implementation.client({ url: 'http://127.0.0.1:1', trust: 'untrusted', ...LIMITS }, service),
      { code: 'SOCKET_IPC_CONFIG_REFUSED' });
    await criterion(transport);
    const broken = load('../lib/server/internal-api/transport', [["value.trust !== 'network'", 'false']]);
    await red('explicit-network-trust', criterion, broken); await criterion(transport);
  });
});
