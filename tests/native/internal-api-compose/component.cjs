'use strict';
// One separated component process for the composed-listener Compose instrument.
// Production pieces: serve.internal configuration (listener-config: own
// NS_SERVE_INTERNAL_* and peer NS_<ROLE>_INTERNAL_* addresses), the role
// listener composition and binding (serve/internal-listener), the transport with
// its graceful shutdown, checked-in contracts, named clients, operation-window
// and operation-cohort lifecycle handlers. Instrument stand-ins (labelled, synthetic): the window's
// PostgreSQL is the recording protocol fixture whose tenant phase row is read
// from /state/phases.json on every query; API authority decisions are read from
// /state/authority.json on every call; role contexts only record invalidation.
// Not evidence of PostgreSQL locks, Vault, real authority or clinical behaviour.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '../../..');
const contracts = require(root + '/lib/server/internal-api/contracts');
const clients = require(root + '/lib/server/internal-api/clients');
const listenerConfig = require(root + '/lib/server/internal-api/listener-config');
const internalListener = require(root + '/lib/server/serve/internal-listener');
const manifest = require(root + '/lib/server/serve/operation-cohort-manifest');
const windowFixture = require(root + '/tests/fixtures/operation-window-runtime-protocol');

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const HOSTS = { [A]: 'one.example.test', [B]: 'two.example.test' };
const role = process.argv[2];
const STATE = process.env.NS_LC_STATE_DIR;
const LIMITS = { maxBytes: 65536, timeoutMs: 3000 };
const readJSON = (name, fallback) => { try { return JSON.parse(fs.readFileSync(path.join(STATE, name), 'utf8')); } catch { return fallback; } };
const append = (name, row) => fs.appendFileSync(path.join(STATE, name), JSON.stringify({ at: Date.now(), ...row }) + '\n');
const log = (...args) => console.log(new Date().toISOString(), role, ...args);

// This process's serve.internal and every peer address come from the
// environment through the production resolver, never from request content.
const internal = listenerConfig.resolve([role], process.env);
const peer = name => internal.peer(name, LIMITS);
const participants = manifest.validate(listenerConfig.ROLES.map(name => ({ id: name.replace('-', '_'), roles: [name], namespaces: ['clinical'], endpoint: internal.participant([name], LIMITS) })));

function cohortModule () {
  const file = path.join(root, 'lib/server/serve/operation-cohort.js'), output = { exports: {} };
  const original = Module.createRequire(file);
  const DATA = { database: 'disposable_test', database_oid: '16384', server_address: '127.0.0.1', server_port: 5432, postmaster_birth: '1700000000.000000' };
  const context = { boot: async () => ({ close: async () => {}, invalidateTenant: async tenant => append(role + '-invalidated.jsonl', { tenant }) }) };
  const overrides = {
    '../../storage/postgres-connection': { installOperationWindow: () => () => {}, cohortDatastore: () => DATA,
      cohortBackends: () => [{ pid: process.pid, role: 'synthetic_' + role.replace('-', '_'), birth: '1700000000.' + process.pid }] },
    './preview-api': context, './preview-realtime': context, './evaluator-preview': context, './owner-preview': context
  };
  vm.runInThisContext('(function(require,module,exports){' + fs.readFileSync(file, 'utf8') + '\n})', { filename: file })(
    name => Object.hasOwn(overrides, name) ? overrides[name] : original(name), output, output.exports);
  return output.exports;
}
const until = async (probe, ms = 20) => { while (!probe()) await new Promise(resolve => setTimeout(resolve, ms)); };

async function main () {
  const options = { get phases () { return readJSON('phases.json', {}); } };
  const f = windowFixture(options);
  const cohorts = cohortModule();
  const participant = participants.find(row => row.roles[0] === role);
  const cohort = await cohorts.create({ window: f.window, names: [role], tenants: [A, B], namespaces: ['clinical'], participant });
  await cohort.boot(role, { tenantIds: [A, B], namespaces: { clinical: 'clinical' } }); cohort.complete();
  // The rows serve/internal-listener.plan() derives from role settings.
  const rows = [...(role === 'api' ? [{ id: 'socket-authority', roles: [role], tenantScoped: true, bounds: LIMITS }] : []),
    ...(role === 'realtime' ? [{ id: 'alarm-delivery', roles: [role], tenantScoped: true, bounds: LIMITS }] : []),
    { id: 'lifecycle-participant', roles: [role], tenantScoped: false, bounds: LIMITS }];
  const listener = await internalListener.open(internal, rows, { operationWindow: f.window });
  const bindings = {};
  if (role === 'api') bindings['socket-authority'] = { resolveTenant: async body => body.tenant || body.envelope.tenant, create: () => ({
    async authorizeSocket (ctx, body) {
      f.window.assertCurrent(body.tenant);
      const call = randomUUID(); append('api-calls.jsonl', { call, tenant: body.tenant, phase: 'start' });
      await until(() => !fs.existsSync(path.join(STATE, 'hold-' + body.tenant)));
      const decision = readJSON('authority.json', {})[body.tenant];
      append('api-calls.jsonl', { call, tenant: body.tenant, phase: 'finish', decision });
      return decision === 'allow' ? { permissions: { read: true, write: false, write_treatment: false, ack: true }, collections: ['entries'] } : { denied: true };
    },
    async executeSocketMutation () { return { replyArgs: [] }; } }) };
  if (role === 'realtime') {
    const api = clients.socketAuthority(peer('api'));
    bindings['alarm-delivery'] = { resolveTenant: async body => body.tenant, create: () => ({
      async deliverAlarm (ctx, body) {
        f.window.assertCurrent(body.tenant);
        // Current authority per delivery from the API process over HTTP; no cache.
        const actor = await api.authorizeSocket({ host: HOSTS[body.tenant], tenant: body.tenant, namespace: '/', credential: {} });
        if (actor.denied) throw Object.assign(new Error('REALTIME_RECIPIENT_DENIED'), { code: 'REALTIME_RECIPIENT_DENIED' });
        return { accepted: true, receipt: null, clearedRequestIds: [] };
      } }) };
  }
  bindings['lifecycle-participant'] = { create: () => cohorts.controlOperations(cohort) };
  listener.bind(role, bindings); listener.assertBound();
  log('READY', JSON.stringify({ routes: listener.routes, endpoint: internal.listen.url || internal.listen.socketPath, bind: internal.listen.bindHost || null, shutdownTimeoutMs: internal.shutdownTimeoutMs }));

  let stopping = false, cycles;
  if (role === 'evaluator') {
    const alarms = clients.alarmDelivery(peer('realtime'));
    cycles = (async () => {
      for (let cycle = 1; !stopping; cycle++) {
        for (const tenant of [A, B]) {
          try { await alarms.deliverAlarm({ tenant, id: randomUUID(), attempt: 1, notification: { title: 'Synthetic', level: 2 }, receipts: [] }); append('evaluator-cycles.jsonl', { cycle, tenant, ok: true }); }
          catch (error) { append('evaluator-cycles.jsonl', { cycle, tenant, ok: false, error: error.message }); }
        }
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    })();
  }
  process.once('SIGTERM', async () => {
    stopping = true; const started = Date.now();
    log('SIGTERM received; closing private listener and draining window');
    try {
      await cycles;
      await listener.close(); log('LISTENER_CLOSED', Date.now() - started + 'ms');
      await cohort.close(); log('WINDOW_DRAINED', Date.now() - started + 'ms');
      fs.writeFileSync(path.join(STATE, role + '-window.json'), JSON.stringify({ operations: [...f.pending.entries()].map(([id, finished]) => ({ id, finished })), drainedMs: Date.now() - started }) + '\n');
      process.exit(0);
    } catch (error) { log('CLOSE_FAILED', error.code || error.message); process.exit(1); }
  });
}
main().catch(error => { log('STARTUP_FAILED', error.code || error.message); process.exit(1); });
