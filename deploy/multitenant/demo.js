'use strict';

// Synthetic, destructive-to-A demonstration. This is not a general backup or
// operator recovery policy. Uses the real API and private restore controller.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const operator = require('./restore');
const fail = code => Object.assign(new Error(code), { code });

async function responseJson (url, options, fetchImpl, prefix, statuses) {
  let response;
  try { response = await fetchImpl(url, options); } catch { throw fail(prefix + '_UNAVAILABLE'); }
  if (!statuses.includes(response.status)) {
    try { await response.body?.cancel(); } catch { /* Preserve the redacted refusal. */ }
    throw fail(prefix + '_REFUSED');
  }
  try { return { status: response.status, value: await response.json() }; } catch { throw fail(prefix + '_SHAPE'); }
}

async function exchange (config, tenant, { env = process.env, fetchImpl = fetch } = {}) {
  if (!config.tenants.includes(tenant)) throw fail('COMPOSE_DEMO_REQUEST_REFUSED');
  const credential = env[tenant.tokenEnv];
  if (typeof credential !== 'string' || !credential || credential.length > 8192) throw fail('COMPOSE_DEMO_CREDENTIAL_REFUSED');
  // The existing browser exchanges its legacy subject token in this path.
  // It receives a JWT, not an API3 response envelope. Never log this URL or
  // propagate fetch/JSON errors which may include its credential.
  const issued = (await responseJson(config.apiOrigin + '/api/v2/authorization/request/' + encodeURIComponent(credential), {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { host: tenant.host, accept: 'application/json' }
  }, fetchImpl, 'COMPOSE_DEMO_EXCHANGE', [200])).value;
  if (!issued || typeof issued !== 'object' || Array.isArray(issued) ||
      Object.keys(issued).sort().join(',') !== 'exp,iat,permissionGroups,sub,token' ||
      typeof issued.token !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(issued.token) ||
      !Number.isSafeInteger(issued.iat) || !Number.isSafeInteger(issued.exp) || issued.iat < 0 || issued.exp - issued.iat !== 28800 ||
      typeof issued.sub !== 'string' || !issued.sub || !Array.isArray(issued.permissionGroups) ||
      !issued.permissionGroups.every(group => Array.isArray(group) && group.every(permission => typeof permission === 'string'))) {
    throw fail('COMPOSE_DEMO_EXCHANGE_SHAPE');
  }
  return issued.token;
}

async function request (config, tenant, route, { method = 'GET', body, env = process.env, fetchImpl = fetch } = {}) {
  if (!route.startsWith('/api/v3/entries') || route.includes('://') || route.includes('#') || !config.tenants.includes(tenant)) throw fail('COMPOSE_DEMO_REQUEST_REFUSED');
  // Exchange per operation: no cross-tenant token cache or stale-credential
  // fallback. Current subject authority is checked by the actual issuer/API.
  const token = await exchange(config, tenant, { env, fetchImpl });
  const { status, value } = await responseJson(config.apiOrigin + route, { method, redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { host: tenant.host, accept: 'application/json', authorization: 'Bearer ' + token,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
  fetchImpl, 'COMPOSE_DEMO_HTTP', [200, 201]);
  if (value?.status !== status) throw fail('COMPOSE_DEMO_HTTP_SHAPE');
  return value;
}

function document (identifier, date, sgv) {
  return { identifier, date, dateString: new Date(date).toISOString(), utcOffset: 0,
    type: 'sgv', sgv, direction: 'Flat', device: 'synthetic-compose-demo', app: 'synthetic-compose-demo' };
}

async function runDemo ({ config, env = process.env, call = request, ready = operator.ready, capture = operator.capture, restore = operator.restore,
  save = async artifact => require('../../lib/tenant-lifecycle/filesystem-artifact').saveTenantArtifact(artifact, { directory: '/run/ns-artifacts' }),
  now = Date.now, uuid = randomUUID } = {}) {
  if (env.NS_DEMO_CONFIRM_SYNTHETIC !== '1') throw fail('COMPOSE_DEMO_SYNTHETIC_CONFIRMATION_REQUIRED');
  await ready(config);
  const [a, b] = config.tenants, date = now();
  const [kept, extra, beforeB, duringB] = [uuid(), uuid(), uuid(), uuid()];
  const api = (tenant, route, options = {}) => call(config, tenant, route, { ...options, env });
  const write = (tenant, id, value) => api(tenant, '/api/v3/entries/' + id, { method: 'PUT', body: value });
  const read = async (tenant, id) => (await api(tenant, '/api/v3/entries/' + id)).result;
  await write(a, kept, document(kept, date - 3000, 123));
  await write(b, beforeB, document(beforeB, date - 2000, 151));
  const original = await read(a, kept), oldB = await read(b, beforeB);
  if (!original || original.sgv !== 123 || !Number.isSafeInteger(original.srvModified)) throw fail('COMPOSE_DEMO_SEED_NOT_OBSERVED');

  const artifact = await capture(config, a.id, env);
  await save(artifact);
  await api(a, '/api/v3/entries/' + kept, { method: 'PATCH', body: { sgv: 234 } });
  await write(a, extra, document(extra, date - 1000, 145));
  const changed = await read(a, kept), newRow = await read(a, extra);
  if (changed.sgv !== 234 || newRow.sgv !== 145) throw fail('COMPOSE_DEMO_MUTATION_NOT_OBSERVED');
  const cursor = Math.max(changed.srvModified, newRow.srvModified);
  if (!Number.isSafeInteger(cursor)) throw fail('COMPOSE_DEMO_CURSOR_INVALID');

  let committed = false, during = false, bDuring;
  const summary = await restore(config, artifact, env, {
    onRow: async () => {
      if (during) return;
      if (committed) throw fail('COMPOSE_DEMO_B_NOT_DURING_TRANSACTION');
      await write(b, duringB, document(duringB, date, 152));
      bDuring = await read(b, duringB);
      if (bDuring.sgv !== 152) throw fail('COMPOSE_DEMO_B_WRITE_NOT_OBSERVED');
      during = true;
    },
    onCommitted: () => { committed = true; }
  });
  if (!during || !committed) throw fail('COMPOSE_DEMO_REQUIRED_PHASE_NOT_OBSERVED');
  const restored = await read(a, kept);
  assert.equal(restored.sgv, 123, 'COMPOSE_DEMO_A_NOT_RESTORED');
  assert.equal(restored.identifier, original.identifier, 'COMPOSE_DEMO_PUBLIC_ID_CHANGED');
  assert.equal(restored.date, original.date, 'COMPOSE_DEMO_CLINICAL_DATE_CHANGED');
  assert(restored.srvModified > cursor, 'COMPOSE_DEMO_RESTORED_CURSOR_REWOUND');
  assert.deepEqual(await read(b, beforeB), oldB, 'COMPOSE_DEMO_OLD_B_CHANGED');
  assert.deepEqual(await read(b, duringB), bDuring, 'COMPOSE_DEMO_DURING_B_CHANGED');
  const history = (await api(a, '/api/v3/entries/history/' + cursor + '?limit=1000')).result;
  if (!Array.isArray(history)) throw fail('COMPOSE_DEMO_HISTORY_SHAPE');
  const correction = history.find(row => row.identifier === kept), deletion = history.find(row => row.identifier === extra);
  assert(correction?.sgv === 123 && correction.srvModified > cursor, 'COMPOSE_DEMO_FORWARD_CORRECTION_MISSING');
  assert(deletion?.isValid === false && deletion.srvModified > cursor, 'COMPOSE_DEMO_FORWARD_DELETION_MISSING');
  // Apply the actual incremental reply to the previously observed client rows.
  const client = new Map([[kept, changed], [extra, newRow]]);
  for (const row of history) { if (row.isValid === false) client.delete(row.identifier); else client.set(row.identifier, row); }
  assert.equal(client.get(kept)?.sgv, 123, 'COMPOSE_DEMO_CLIENT_NOT_CONVERGED');
  assert.equal(client.has(extra), false, 'COMPOSE_DEMO_CLIENT_RETAINS_DELETED_ROW');
  return { demo: 'tenant-local-logical-restore', state: 'passed', tenant: a.id, unaffectedTenant: b.id, artifactDigest: artifact.digest,
    observations: { restoredClinicalValue: true, publicIdPreserved: true, bCommittedDuringRestore: true,
      priorAndConcurrentBRowsPreserved: true, historyCorrection: true, historyDeletion: true, clientConverged: true,
      actualControllerCommittedAndReactivated: true },
    boundary: 'Synthetic Compose entries/history demonstration; not whole-M6, provider login, all-client or capacity acceptance.',
    summary };
}

async function main () { return runDemo({ config: operator.loadConfig() }); }
if (require.main === module) main().then(result => process.stdout.write(JSON.stringify(result) + '\n'), error => {
  process.stderr.write(JSON.stringify({ error: /^[A-Z][A-Z0-9_]{1,100}$/.test(error.code || '') ? error.code : 'COMPOSE_DEMO_FAILED',
    recovery: 'Retain artifacts and inspect persisted operation state; no automatic restore retry or tenant reopening.' }) + '\n');
  process.exitCode = 1;
});
module.exports = { exchange, request, document, runDemo, main };
