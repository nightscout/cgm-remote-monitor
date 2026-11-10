'use strict';
// In-network driver for the composed-listener Compose instrument. Runs inside
// the internal Compose network; addresses each participant by its own endpoint
// (service DNS name over HTTP, or the shared-volume Unix socket). Writes
// observations to /state/results-<phase>.json before asserting.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '../../..');
const clients = require(root + '/lib/server/internal-api/clients');
const transport = require(root + '/lib/server/internal-api/transport');

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const STATE = process.env.NS_LC_STATE_DIR;
const LIMITS = { maxBytes: 65536, timeoutMs: 3000 };
const write = (name, value) => fs.writeFileSync(path.join(STATE, name), JSON.stringify(value, null, 1) + '\n');
const lines = name => { try { return fs.readFileSync(path.join(STATE, name), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// The driver is not a role: it reads the same peer addresses the roles do.
const address = name => {
  const prefix = 'NS_' + name.toUpperCase().replace('-', '_') + '_INTERNAL_';
  return transport.options(process.env[prefix + 'URL'] ? { url: process.env[prefix + 'URL'], trust: 'network', ...LIMITS } : { socketPath: process.env[prefix + 'SOCKET'], ...LIMITS });
};
const ep = Object.fromEntries(['api', 'realtime', 'evaluator', 'tenant-admin'].map(name => [name, address(name)]));
const lifecycle = Object.fromEntries(Object.entries(ep).map(([name, value]) => [name, clients.lifecycleParticipant(value)]));
const authority = clients.socketAuthority(ep.api);
const authorizeBody = tenant => ({ host: tenant === A ? 'one.example.test' : 'two.example.test', tenant, namespace: '/', credential: {} });
function raw (target, requestPath, service, body) {
  const bytes = Buffer.from(JSON.stringify(body)), url = target.url ? new URL(target.url) : null;
  return new Promise((resolve, reject) => {
    const req = http.request({ ...(url ? { hostname: url.hostname, port: url.port } : { socketPath: target.socketPath }), path: requestPath, method: 'POST',
      headers: { 'content-type': 'application/json', 'x-nightscout-internal-service': service, 'x-nightscout-internal-version': '1' } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(bytes);
  });
}
// Evaluator cycles observed strictly after `since`, per tenant.
async function cyclesAfter (since, count = 3) {
  const deadline = Date.now() + 15000;
  for (;;) {
    const rows = lines('evaluator-cycles.jsonl').filter(row => row.at > since);
    const byTenant = { [A]: rows.filter(r => r.tenant === A), [B]: rows.filter(r => r.tenant === B) };
    if (byTenant[A].length >= count && byTenant[B].length >= count) return byTenant;
    assert(Date.now() < deadline, 'evaluator cycles did not progress');
    await delay(100);
  }
}
const summary = rows => ({ ok: rows.filter(r => r.ok).length, refused: rows.filter(r => !r.ok).length });

async function scenario () {
  const results = { started: new Date().toISOString(), phases: {} };
  for (;;) { try { await Promise.all(Object.values(lifecycle).map(c => c.getStatus({ request: randomUUID() }))); break; } catch { await delay(200); } }
  write('authority.json', { [A]: 'allow', [B]: 'allow' }); write('phases.json', {});
  let mark = Date.now(); await delay(50);
  const baseline = await cyclesAfter(mark);
  results.phases.baseline = { A: summary(baseline[A]), B: summary(baseline[B]) };

  // Current authority: revoke A at the API's decision store; realtime asks API on every delivery.
  write('authority.json', { [A]: 'deny', [B]: 'allow' }); mark = Date.now(); await delay(50);
  const revoked = await cyclesAfter(mark);
  results.phases.revokedA = { A: summary(revoked[A]), B: summary(revoked[B]) };
  write('authority.json', { [A]: 'allow', [B]: 'allow' });

  // Suspend A in the shared phase row: A application work refuses in every component,
  // B progresses, lifecycle status/invalidation stays callable on each participant.
  write('phases.json', { [A]: 'suspended' }); mark = Date.now(); await delay(50);
  const suspended = await cyclesAfter(mark);
  const directA = await authority.authorizeSocket(authorizeBody(A)).then(() => 'admitted', e => e.message);
  const directB = await authority.authorizeSocket(authorizeBody(B)).then(v => v.denied ? 'denied' : 'admitted', e => e.message);
  const control = {};
  for (const [name, client] of Object.entries(lifecycle)) {
    const step = async (label, fn) => { try { return await fn(); } catch (error) { throw new Error('lifecycle ' + label + ' of suspended A on ' + name + ': ' + error.message, { cause: error }); } };
    const current = await step('status', () => client.getStatus({ request: randomUUID() }));
    const reply = await step('invalidation', () => client.invalidateTenant({ request: randomUUID(), tenant: A, incarnation: current.incarnation, identity: current.identity }));
    control[name] = { participant: current.participant, roles: current.roles, statusOk: true, invalidated: reply.tenant, invalidationLog: lines(name + '-invalidated.jsonl').map(r => r.tenant) };
  }
  results.phases.suspendedA = { A: summary(suspended[A]), B: summary(suspended[B]), directA, directB, control };
  write('phases.json', {}); mark = Date.now(); await delay(50);
  const resumed = await cyclesAfter(mark);
  results.phases.resumed = { A: summary(resumed[A]), B: summary(resumed[B]) };

  // Route ownership across the network on composed listeners.
  results.phases.routes = {
    foreignOnApi: (await raw(ep.api, '/cohort/status', 'socket-authority', { request: randomUUID() })).status,
    unregisteredOnApi: (await raw(ep.api, '/alarm', 'alarm-delivery', { tenant: A })).status,
    foreignOnRealtime: (await raw(ep.realtime, '/cohort/status', 'alarm-delivery', { request: randomUUID() })).status,
    lifecycleOnRealtime: (await raw(ep.realtime, '/cohort/status', 'lifecycle-participant', { request: randomUUID() })).status
  };
  write('results-scenario.json', results);
  const p = results.phases;
  assert(p.baseline.A.ok >= 3 && p.baseline.A.refused === 0 && p.baseline.B.refused === 0, 'baseline A and B deliver');
  assert(p.revokedA.A.ok === 0 && p.revokedA.A.refused >= 3 && p.revokedA.B.refused === 0, 'revoked A refuses at current API authority, B delivers');
  assert(p.suspendedA.A.ok === 0 && p.suspendedA.B.refused === 0 && p.suspendedA.B.ok >= 3, 'suspended A refuses, B progresses');
  assert.equal(p.suspendedA.directA, 'SOCKET_IPC_UNAVAILABLE'); assert.equal(p.suspendedA.directB, 'admitted');
  for (const row of Object.values(p.suspendedA.control)) { assert.equal(row.invalidated, A); assert.deepEqual(row.invalidationLog, [A]); }
  assert(p.resumed.A.refused === 0 && p.resumed.A.ok >= 3, 'resumed A delivers');
  assert.deepEqual(p.routes, { foreignOnApi: 503, unregisteredOnApi: 503, foreignOnRealtime: 503, lifecycleOnRealtime: 200 });
  console.log('SCENARIO_PASS', JSON.stringify(results.phases));
}
// Hold one A application call open at the API; run.sh then SIGTERMs the API.
async function drainHold () {
  fs.writeFileSync(path.join(STATE, 'hold-' + A), '');
  const started = Date.now();
  const outcome = await authority.authorizeSocket(authorizeBody(A)).then(v => ({ result: v.denied ? 'denied' : 'admitted' }), e => ({ error: e.message }));
  write('results-drain-client.json', { ...outcome, elapsedMs: Date.now() - started });
  console.log('DRAIN_CLIENT', JSON.stringify(outcome));
}
({ scenario, 'drain-hold': drainHold })[process.argv[2]]().catch(error => { console.error('DRIVER_FAILED', error.message); process.exit(1); });
