'use strict';

// Source-only driver controls. No database, listener, container or product
// restore verdict: these prove that the demonstration refuses false witnesses.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateConfig, argumentsFor } = require('./restore');
const { runDemo, request } = require('./demo');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const env = { A_TOKEN: 'private-a-token', B_TOKEN: 'private-b-token', NS_OPERATOR_PG: 'postgres://operator:private-password@postgres/demo',
  NS_SOURCE_COMMIT: 'a'.repeat(40), NS_DEMO_CONFIRM_SYNTHETIC: '1' };
const config = () => ({ version: 1, tenants: [{ id: A, host: 'one.example.test', tokenEnv: 'A_TOKEN' }, { id: B, host: 'two.example.test', tokenEnv: 'B_TOKEN' }],
  apiOrigin: 'http://api:1337', control: { namespace: 'control', locks: [{ tenant: A, key: '1' }, { tenant: B, key: '2' }], participants: [{}] },
  namespaces: { entries: 'demo_entries' }, catalogues: [{ kind: 'entries', candidate: {} }], drainTimeoutMs: 5000 });

test('operator config refuses a public target, shared lock and missing explicit drain bound', () => {
  assert.equal(validateConfig(config(), env).control.namespace, 'control');
  const external = config(); external.apiOrigin = 'https://example.com';
  assert.throws(() => validateConfig(external, env), { code: 'COMPOSE_OPERATOR_CONFIG_REFUSED' });
  const lock = config(); lock.control.locks[1].key = '1';
  assert.throws(() => validateConfig(lock, env), { code: 'COMPOSE_OPERATOR_CONFIG_REFUSED' });
  const noBound = config(); delete noBound.drainTimeoutMs;
  assert.throws(() => validateConfig(noBound, env), { code: 'COMPOSE_OPERATOR_CONFIG_REFUSED' });
  assert.equal(validateConfig(config(), env).drainTimeoutMs, 5000);
});

test('operator CLI requires an explicit tenant, private directory and exact restore digest', () => {
  assert.equal(argumentsFor(['export', '--tenant', A, '--directory', '/run/ns-artifacts']).command, 'export');
  assert.throws(() => argumentsFor(['restore', '--tenant', A, '--directory', '/run/ns-artifacts']), { code: 'COMPOSE_OPERATOR_USAGE' });
  assert.throws(() => argumentsFor(['export', '--tenant', A, '--directory', '../artifact']), { code: 'COMPOSE_OPERATOR_USAGE' });
  assert.equal(argumentsFor(['restore', '--tenant', A, '--directory', '/run/ns-artifacts', '--digest', 'a'.repeat(64)]).digest, 'a'.repeat(64));
});

test('HTTP failures with sensitive bodies are refused without returning their payload', async () => {
  let cancelled = false;
  await assert.rejects(request(config(), config().tenants[0], '/api/v3/entries', { env,
    fetchImpl: async () => ({ status: 403, body: { cancel: async () => { cancelled = true; } }, json: () => { throw new Error(env.A_TOKEN); } }) }),
  error => error.code === 'COMPOSE_DEMO_REQUEST_REFUSED');
  // The tenant must be one of the exact selected objects, not a forged copy.
  const c = config();
  await assert.rejects(request(c, c.tenants[0], '/api/v3/entries', { env,
    fetchImpl: async () => ({ status: 403, body: { cancel: async () => { cancelled = true; } } }) }),
  error => error.code === 'COMPOSE_DEMO_HTTP_REFUSED' && !error.message.includes(env.A_TOKEN));
  assert.equal(cancelled, true);
});

function scenario (control) {
  const c = config(), rows = new Map([[A, new Map()], [B, new Map()]]); let stamp = 1794000000000, snapshot, count = 0;
  const call = async (unused, tenant, route, options = {}) => {
    const id = route.split('/')[4], table = rows.get(tenant.id);
    if (route.includes('/history/')) return { status: 200, result: [...table.values()].filter(row => row.srvModified > Number(route.split('/history/')[1].split('?')[0])) };
    if (options.method === 'PUT') table.set(id, { ...structuredClone(options.body), srvCreated: ++stamp, srvModified: stamp });
    else if (options.method === 'PATCH') table.set(id, { ...table.get(id), ...options.body, srvModified: ++stamp });
    return { status: 200, result: structuredClone(table.get(id)) };
  };
  return { config: c, env, call, now: () => stamp,
    uuid: () => '00000000-0000-4000-8000-' + String(++count).padStart(12, '0'),
    capture: async () => { snapshot = structuredClone(rows.get(A)); return { digest: 'a'.repeat(64), manifest: { tenant: A } }; }, save: async () => {},
    restore: async (unused, artifact, unusedEnv, hooks) => {
      if (control !== 'no-during') await hooks.onRow();
      const live = rows.get(A);
      if (control !== 'no-restore') for (const [id, doc] of snapshot) live.set(id, { ...doc, srvModified: ++stamp });
      if (control !== 'no-tombstone') for (const [id, doc] of live) if (!snapshot.has(id)) live.set(id, { ...doc, isValid: false, srvModified: ++stamp });
      if (control === 'b-corruption') rows.get(B).values().next().value.sgv = 999;
      await hooks.onCommitted({}); return {};
    } };
}

test('demo ordinary protocol passes; missing A restoration, deletion, B progress or B fidelity fail', async () => {
  assert.equal((await runDemo(scenario())).state, 'passed');
  await assert.rejects(runDemo(scenario('no-restore')), /COMPOSE_DEMO_A_NOT_RESTORED/);
  await assert.rejects(runDemo(scenario('no-tombstone')), /COMPOSE_DEMO_FORWARD_DELETION_MISSING/);
  await assert.rejects(runDemo(scenario('no-during')), { code: 'COMPOSE_DEMO_REQUIRED_PHASE_NOT_OBSERVED' });
  await assert.rejects(runDemo(scenario('b-corruption')), /COMPOSE_DEMO_OLD_B_CHANGED/);
  assert.equal((await runDemo(scenario())).state, 'passed');
});
