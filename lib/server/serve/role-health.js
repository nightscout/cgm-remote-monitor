'use strict';

// A role process's health endpoints (decision platform-verification-removal),
// served as GET on its private listener (serve.internal), over TCP and over the
// Unix socket, whichever the process listens on. One concern each; operators
// compose liveness, readiness and start-up from them:
//
//   GET /healthz/live       the process answers. No I/O. Stays 200 while the
//                           datastore is down, so liveness never restarts a
//                           role that is waiting for its datastore.
//   GET /healthz/ready      every role in the process booted and can serve:
//                           not stopping, datastore admitted, and each role's
//                           own state (api storage, evaluator, realtime
//                           registry and ownership). In memory, cheap.
//   GET /healthz/datastore  each serving login connects and answers now.
//   GET /healthz/schema     each migration ledger the roles read is current.
//   GET /healthz/isolation  each serving login cannot bypass row-level
//                           security, and every tenant-data table its
//                           catalogues create still has row-level security
//                           enabled and forced, with its policies. One
//                           catalogue query per login (role-readiness.js
//                           isolation). The start check runs the same.
//
// 200 {"check":NAME,"status":"ok"} or 503 {"check":NAME,"status":"unavailable"}
// with a typed code when one is known; never a message, address or credential.
// `nightscout healthcheck --endpoint NAME` asks one of them
// (lib/cli/commands/healthcheck.js).
const { Client } = require('pg');
const readiness = require('./role-readiness');

const PATHS = Object.freeze({ '/healthz/live': 'live', '/healthz/ready': 'ready', '/healthz/datastore': 'datastore', '/healthz/schema': 'schema', '/healthz/isolation': 'isolation' });
const SERVING = Object.freeze(['api', 'evaluator', 'realtime', 'vcpool']);
const TIMEOUT_MS = 5000;

function send (res, status, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': bytes.length, 'cache-control': 'no-store' });
  res.end(bytes);
}
const typed = error => typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : undefined;

async function reachable (connectionString) {
  const client = new Client({ connectionString, connectionTimeoutMillis: TIMEOUT_MS, statement_timeout: TIMEOUT_MS,
    query_timeout: TIMEOUT_MS, application_name: 'nightscout-health' });
  client.on('error', () => {});
  try { await client.connect(); await client.query('SELECT 1'); } finally { await client.end().catch(() => {}); }
}

// create({ configs: () => {role: config}, ready: () => boolean }) -> (req, res)
// `configs` lists the serving roles' parsed configurations; `ready` is the
// process's in-memory readiness (lib/server/serve/index.js).
function create ({ configs, ready }) {
  const inflight = new Map();
  // Concurrent probes of the same check share one evaluation.
  function once (name, run) {
    if (!inflight.has(name)) inflight.set(name, Promise.resolve().then(run).finally(() => inflight.delete(name)));
    return inflight.get(name);
  }
  const serving = () => Object.entries(configs()).filter(([role, config]) => SERVING.includes(role) && config);
  const checks = {
    live: async () => {},
    ready: async () => { if (ready() !== true) throw Object.assign(new Error('ROLE_NOT_READY'), { code: 'ROLE_NOT_READY' }); },
    datastore: () => once('datastore', async () => {
      const seen = new Set();
      for (const [role, config] of serving()) {
        const connectionString = readiness.servingConnection(config, role);
        if (seen.has(connectionString)) continue;
        seen.add(connectionString);
        await reachable(connectionString);
      }
    }),
    schema: () => once('schema', async () => { for (const [role, config] of serving()) await readiness.schema(config, role); }),
    isolation: () => once('isolation', async () => { for (const [role, config] of serving()) await readiness.isolation(config, role); })
  };
  return async function health (req, res) {
    const check = PATHS[new URL(req.url, 'http://internal.invalid').pathname];
    if (!check) return send(res, 404, { error: 'NOT_FOUND' });
    try {
      await checks[check]();
      send(res, 200, { check, status: 'ok' });
    } catch (error) {
      const code = typed(error);
      send(res, 503, { check, status: 'unavailable', ...(code ? { code } : {}) });
    }
  };
}

module.exports = { PATHS, create };
