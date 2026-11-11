'use strict';

// Owned synthetic services/processes come from the frozen replica fixture.
// No clock candidate is loaded until an explicitly enabled suite calls setup.
const assert = require('node:assert/strict');
const path = require('node:path');
const { Client } = require('pg');
const { run } = require('../../lib/migrations/postgres');
const { setTimeout: delay } = require('node:timers/promises');
const createReplicaFixture = require('./multitenant-preview-replicas');

const CLOCK = 'preview_clock';
const MAX_STAMP = 8640000000000000;
const BLOCK_DEADLINE_MS = 2000; // shorter than the actual API statement timeout

function tracked (operation) {
  const result = { settled: false, response: null, error: null };
  result.promise = Promise.resolve(operation).then(response => {
    result.settled = true;
    result.response = response;
    return result;
  }, error => {
    result.settled = true;
    result.error = error;
    return result;
  });
  return result;
}

function requestSummary (request) {
  return request.error ? 'transport failure' : 'HTTP ' + request.response?.status;
}

module.exports = function createClockHttpFixture ({ clockEnabled = true } = {}) {
  assert.equal(typeof clockEnabled, 'boolean');
  const base = createReplicaFixture();
  const clients = new Set();
  const locked = new Set();
  const backendFaultTargets = new WeakSet();

  function configuration () {
    const config = base.configuration();
    if (clockEnabled) {
      config.writeClock = true;
      config.postgres.namespaces.clock = CLOCK;
    }
    return config;
  }

  async function client () {
    // The operator connection is fixture-owned, generated at runtime. Do not log
    // or serialize these parameters, errors containing them, or a derived URI.
    const params = base.admin.connectionParameters;
    const connection = new Client({ host: params.host, port: params.port,
      user: params.user, password: params.password, database: params.database,
      ssl: params.ssl, application_name: 'tenant-clock-http-control',
      connectionTimeoutMillis: 2000, statement_timeout: 4000 });
    clients.add(connection);
    await connection.connect();
    return connection;
  }

  async function closeClient (connection) {
    const errors = [];
    if (locked.has(connection)) {
      try { await connection.query('ROLLBACK'); } catch (error) { errors.push(error); }
      finally { locked.delete(connection); }
    }
    try { await connection.end(); } catch (error) { errors.push(error); }
    finally { clients.delete(connection); }
    if (errors.length) throw new AggregateError(errors, 'Owned clock control connection cleanup failed');
  }

  async function releaseControls () {
    const errors = [];
    for (const connection of [...clients]) {
      try { await closeClient(connection); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Clock HTTP control cleanup failed');
  }

  async function setup () {
    await base.setup();
    const catalogue = require('../../migrations/candidates/postgres-write-clock-v1.json');
    const params = base.admin.connectionParameters;
    // Build the URI privately for the existing operator migration runner only.
    const uri = new URL('postgres://127.0.0.1/');
    uri.hostname = params.host; uri.port = String(params.port);
    uri.username = params.user; uri.password = params.password;
    uri.pathname = '/' + params.database;
    await run('up', { direct: true, connectionString: uri.toString(), namespace: CLOCK, catalogue });
    for (const tenant of base.tenants) {
      const config = base.configuration();
      const pieces = config.domains.map(name => `SELECT doc FROM "${config.postgres.namespaces[name]}"."${name}" WHERE tenant_id=$1`);
      const highest = await base.admin.query(`SELECT COALESCE(ceil(max((doc->>'srvModified')::numeric)),0)::text AS stamp
        FROM (${pieces.join(' UNION ALL ')}) admitted
        WHERE jsonb_typeof(doc->'srvModified')='number'
          AND (doc->>'srvModified')::numeric>=0 AND (doc->>'srvModified')::numeric<$2`, [tenant, MAX_STAMP]);
      await base.admin.query('INSERT INTO preview_clock.tenant_write_clock (tenant_id,last_stamp) VALUES ($1,$2)',
        [tenant, highest.rows[0].stamp]);
    }
    await base.admin.query('GRANT USAGE ON SCHEMA preview_clock TO preview_app, preview_check');
    await base.admin.query('GRANT SELECT, UPDATE(last_stamp,last_delete_stamp) ON preview_clock.tenant_write_clock TO preview_app');
    await base.admin.query('GRANT SELECT ON preview_clock.schema_migrations TO preview_check');
  }

  async function cleanup () {
    const errors = [];
    try { await releaseControls(); } catch (error) { errors.push(error); }
    try { await base.cleanup(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Clock HTTP fixture cleanup failed');
  }

  function start (extra = {}) { return base.start(configuration(), extra); }
  async function pair (extra = {}, firstExtra = {}) {
    const first = start({ ...extra, ...firstExtra }), second = start(extra);
    await base.ready(first); await base.ready(second);
    return [first, second];
  }
  const rows = async (tenant, identifier) => (await base.admin.query(
    "SELECT doc FROM preview_data.entries WHERE tenant_id=$1 AND doc->>'identifier'=$2", [tenant, identifier])).rows.map(row => row.doc);
  const floor = async tenant => clockEnabled ? Number((await base.admin.query(
    'SELECT last_stamp FROM preview_clock.tenant_write_clock WHERE tenant_id=$1', [tenant])).rows[0].last_stamp) : null;
  const storedEntriesWatermark = async tenant => Number((await base.admin.query(
    "SELECT COALESCE(max((doc->>'srvModified')::numeric),0)::text AS stamp FROM preview_data.entries WHERE tenant_id=$1 AND jsonb_typeof(doc->'srvModified')='number'",
    [tenant])).rows[0].stamp);
  const foreignRows = async tenant => (await base.admin.query(
    'SELECT doc FROM preview_data.entries WHERE tenant_id=$1 ORDER BY doc::text', [tenant])).rows;

  async function lockEntry (tenant, identifier) {
    const connection = await client();
    await connection.query('BEGIN');
    locked.add(connection);
    const found = await connection.query(
      "SELECT doc FROM preview_data.entries WHERE tenant_id=$1 AND doc->>'identifier'=$2 FOR UPDATE", [tenant, identifier]);
    assert.equal(found.rows.length, 1, 'barrier requires one existing actual data row');
    const pid = Number((await connection.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    let released = false;
    return { connection, pid, row: found.rows[0].doc,
      async release () {
        if (released) return;
        released = true;
        await closeClient(connection);
      } };
  }

  async function backendState (pid) {
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    const result = await base.admin.query(`SELECT pid, usename, application_name,
      state, wait_event_type, wait_event, pg_blocking_pids(pid) AS blockers
      FROM pg_stat_activity WHERE pid=$1 AND datname=current_database()`, [pid]);
    return result.rows[0] || null;
  }

  async function terminateBackend (pid, worker) {
    assert.ok(base.workers.has(worker), 'fault target must be an owned API child');
    const backend = await backendState(pid);
    assert.ok(backend, 'exact previously observed writer backend must still exist');
    assert.equal(backend.usename, 'preview_app', 'operator termination targets only the owned API writer');
    assert.equal(backend.application_name, 'nightscout-preview-data');
    const terminated = (await base.admin.query('SELECT pg_terminate_backend($1::int) AS terminated', [pid])).rows[0].terminated;
    if (terminated) backendFaultTargets.add(worker);
    return terminated;
  }

  function workerDiagnostic (worker) {
    // Capture only error headings/emitter/stack frames, never arbitrary stderr.
    // Runtime credentials are random; redact their known shapes and every URI.
    const sourceRoot = path.resolve(__dirname, '../..') + path.sep;
    const redact = line => line
      .replaceAll(sourceRoot, '[worktree]/')
      .replace(/\b(?:postgres(?:ql)?|mongodb(?:\+srv)?|https?):\/\/[^\s"'<>)]*/gi, '[redacted-uri]')
      .replace(/\bhv[bsr]\.[A-Za-z0-9._-]+\b/g, '[redacted-vault-token]')
      .replace(/\b[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g, '[redacted-token]')
      .replace(/\b[0-9a-f]{32,}\b/gi, '[redacted-hex]')
      .replace(/\bsameviewer-[A-Za-z0-9_-]+\b/g, '[redacted-legacy-credential]')
      .slice(0, 320);
    const stderrStack = worker.stderr.split('\n')
      .filter(line => /^\s*at\s|^Emitted 'error' event on |^(?:Error|TypeError|RangeError|error):|^node:[^ ]+:\d+/.test(line))
      .slice(0, 24).map(redact);
    const monitor = worker.stderr.split('\n').find(line => line.startsWith('CLOCK_FATAL_DIAGNOSTIC '));
    let fatalMonitor = null;
    if (monitor) {
      const observed = JSON.parse(monitor.slice('CLOCK_FATAL_DIAGNOSTIC '.length));
      fatalMonitor = {
        origin: ['uncaughtException', 'unhandledRejection'].includes(observed.origin) ? observed.origin : 'other',
        name: ['Error', 'DatabaseError', 'AggregateError'].includes(observed.name) ? observed.name : 'other',
        code: /^[0-9A-Z]{5}$/.test(observed.code || '') ? observed.code : null,
        connectionTerminated: observed.connectionTerminated === true,
        locations: (observed.locations || []).filter(value => typeof value === 'string' &&
          /^(?:node:events|node_modules\/pg\/lib\/client\.js|node_modules\/pg-pool\/index\.js|lib\/storage\/postgres-connection\.js|lib\/storage\/postgres-write-clock\.js):[0-9]+(?::[0-9]+)?$/.test(value)).slice(0, 16)
      };
    }
    return { exit: worker.exit, portPresent: Number.isInteger(worker.port),
      listeningMarker: /Listening/.test(worker.stdout),
      backendFaultInjected: backendFaultTargets.has(worker),
      stderrStack, fatalMonitor,
      stderrSignals: {
        administratorTermination: /administrator command|57P01/.test(worker.stderr),
        unhandledError: /Unhandled 'error'|unhandledRejection|uncaughtException/.test(worker.stderr),
        connectionTerminated: /Connection terminated|connection terminated/.test(worker.stderr),
        storageShutdownFailure: /storage shutdown failed/.test(worker.stderr)
      } };
  }

  async function disposeBackendFaultTarget (worker) {
    assert.ok(base.workers.has(worker) && backendFaultTargets.has(worker),
      'only the confirmed owned backend-fault child may use fault disposal');
    const before = workerDiagnostic(worker);
    const forcedKill = worker.exit === null;
    if (forcedKill) worker.child.kill('SIGKILL');
    await Promise.race([worker.exited, delay(5000).then(() => {
      throw new Error('Injected backend-fault child did not exit during disposal');
    })]);
    assert.ok(worker.exit, 'fault disposal must confirm actual process exit');
    assert.ok(Number.isInteger(worker.port), 'injected child previously bound its owned listener');
    await assert.rejects(fetch('http://127.0.0.1:' + worker.port + '/', { signal: AbortSignal.timeout(1000) }));
    const after = workerDiagnostic(worker);
    base.workers.delete(worker);
    console.log('TENANT_COMMIT_CLOCK_FAULT_TARGET_DISPOSAL ' + JSON.stringify({
      scope: 'explicit injected-fault child disposal; no graceful-exit or survival guarantee',
      forcedKill, before, after, socketClosed: true
    }));
  }

  async function connectionSettings () {
    // These settings belong to the operator/control connection. They do not
    // inspect another backend's per-session GUCs. API source configures5000ms.
    const connectionCheck = (await base.admin.query('SHOW client_connection_check_interval')).rows[0];
    const timeout = (await base.admin.query('SHOW statement_timeout')).rows[0];
    return { ...connectionCheck, ...timeout };
  }

  async function waitForBlocked (request, blockerPid, kind, deadline = Date.now() + BLOCK_DEADLINE_MS) {
    while (Date.now() < deadline) {
      if (request.settled) assert.fail(kind + ' completed before its required lock wait: ' + requestSummary(request));
      const state = await base.admin.query(`SELECT pid, query, wait_event_type,
          pg_blocking_pids(pid) AS blockers,
          extract(epoch FROM (clock_timestamp()-query_start))*1000 AS waiting_ms FROM pg_stat_activity
        WHERE usename='preview_app' AND state='active' AND wait_event_type='Lock'
          AND $1::int=ANY(pg_blocking_pids(pid))`, [blockerPid]);
      for (const row of state.rows) {
        const isData = /\bUPDATE\b/i.test(row.query) && /preview_data/.test(row.query) && /entries/.test(row.query);
        const isClock = /\bSELECT\s+last_stamp\b/i.test(row.query) && /tenant_write_clock/.test(row.query) && /FOR\s+UPDATE/i.test(row.query);
        if ((kind === 'data-update' && isData) || (kind === 'clock-select' && isClock)) {
          return { pid: Number(row.pid), blockers: row.blockers, kind,
            // Stop well before the preview data transaction's5s timeout. All
            // later probes share this remaining budget rather than adding it.
            deadline: Date.now() + Math.max(0, 3500 - Number(row.waiting_ms)) };
        }
      }
      await delay(20);
    }
    assert.fail(kind + ' never reached its actual PostgreSQL lock barrier (not counted as a passing wait)');
  }

  async function assertClockHeld (tenant) {
    const probe = await client();
    try {
      await probe.query('BEGIN'); locked.add(probe);
      await assert.rejects(probe.query(
        'SELECT last_stamp FROM preview_clock.tenant_write_clock WHERE tenant_id=$1 FOR UPDATE NOWAIT', [tenant]),
      error => error.code === '55P03', 'the data-blocked writer must still hold its tenant clock row');
    } finally { await closeClient(probe); }
  }

  async function completed (request, status, label, deadline = Date.now() + BLOCK_DEADLINE_MS) {
    while (!request.settled && Date.now() < deadline) await delay(20);
    assert.ok(request.settled, label + ' did not progress while unrelated row was blocked');
    assert.equal(request.error, null, label + ' must complete actual HTTP');
    assert.equal(request.response.status, status, label + ' response');
    return request.response;
  }

  return { ...base, setup, cleanup, configuration, start, pair, rows, floor,
    foreignRows, storedEntriesWatermark, lockEntry, waitForBlocked, assertClockHeld, completed,
    backendState, terminateBackend, connectionSettings, workerDiagnostic, disposeBackendFaultTarget,
    tracked, releaseControls,
    get admin () { return base.admin; }, get workers () { return base.workers; } };
};

// Explicit workload reporting only: this does not assert a latency budget.
module.exports.metrics = function metrics (samples, elapsedMs, workload) {
  const successful = samples.filter(sample => sample.ok).map(sample => sample.ms).sort((a, b) => a - b);
  const percentile = p => successful.length ? successful[Math.max(0, Math.ceil(successful.length * p) - 1)] : null;
  return { workload, elapsedMs, successful: successful.length,
    errors: samples.filter(sample => !sample.ok).length,
    transportErrors: samples.filter(sample => sample.transportError).length,
    httpStatusCounts: samples.filter(sample => sample.status !== undefined).reduce((counts, sample) => {
      counts[sample.status] = (counts[sample.status] || 0) + 1;
      return counts;
    }, {}),
    retries: samples.reduce((sum, sample) => sum + (sample.retries || 0), 0),
    successfulRequestsPerSecond: elapsedMs > 0 ? successful.length * 1000 / elapsedMs : null,
    latencyMs: { p50: percentile(0.5), p95: percentile(0.95) },
    lockWaitMs: null, lockWaitNote: 'not separately instrumented; end-to-end latency includes lock waiting' };
};
