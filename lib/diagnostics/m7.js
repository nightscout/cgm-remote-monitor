'use strict';

const NOOP = () => {}, OFF = Object.freeze({ status: 'UNMEASURED', reason: 'disabled' });
const KINDS = ['storage', 'operation'];
const STAGES = ['pool.wait_storage', 'pool.wait_operation', 'pool.query_storage', 'pool.query_operation',
  'window.admission', 'window.register', 'window.body_response_inclusive', 'window.complete_inclusive', 'lifetime.queue_wait',
  'api.authorize', 'realtime.authorize_rpc', 'api.authorize_socket'];
const GAUGES = ['lifetime.queue_pending', 'lifetime.critical_active', 'lifetime.lease_holders', 'window.outer_bodies'];
const BOUNDS = [0.1, 0.5, 1, 2, 5, 10, 20, 50, 100, 250, 1000, 5000, Infinity];
const MAX_POOLS = 64, MAX_BYTES = 8192;
function workerSink () {
  const { Worker } = require('node:worker_threads');
  const worker = new Worker(require.resolve('./m7-log-worker'), { execArgv: [], env: {}, resourceLimits: { maxOldGenerationSizeMb: 8, maxYoungGenerationSizeMb: 2, stackSizeMb: 1 } });
  let pending, dead = false;
  const complete = okay => { const callback = pending; pending = null; if (callback) callback(okay); };
  worker.on('message', okay => complete(okay === true));
  worker.on('error', () => { dead = true; complete(false); });
  worker.on('exit', () => { dead = true; complete(false); });
  worker.unref();
  return {
    state () { if (dead) return 'unavailable'; if (pending) return 'busy'; return process.stdout.writableNeedDrain || process.stdout.writableLength ? 'backpressure' : 'ready'; },
    send (bytes, callback) {
      if (dead || pending) return false;
      pending = callback;
      try { worker.postMessage(bytes, [bytes]); return true; }
      catch { pending = null; dead = true; return false; }
    },
    close () { dead = true; complete(false); worker.terminate().catch(NOOP); }
  };
}
function create ({ enabled = false, intervalMs = 5000, sinkFactory = workerSink, clock = () => Number(process.hrtime.bigint()) / 1e6 } = {}) {
  if (!enabled) return Object.freeze({ enabled: false, observePool: pool => pool, time: () => NOOP, delta: NOOP, configureRoles: NOOP,
    wrapAsync: fn => fn, snapshot: () => OFF, emit: () => false, close: NOOP });
  const stages = new Map(STAGES.map(name => [name, { count: 0, sumMs: 0, maxMs: 0, invalid: 0, buckets: BOUNDS.map(() => 0) }]));
  const gauges = new Map(GAUGES.map(name => [name, { value: 0, observations: 0, invalid: 0 }]));
  const pools = new Set(), seenPools = new WeakSet(), seenClients = new WeakMap();
  const logging = { attempted: 0, written: 0, dropped: 0, busy: 0, backpressure: 0, unavailable: 0, oversized: 0 };
  let roles = [], rolesMeasured = false, poolOverflow = 0, unknownStages = 0, closed = false, sink;
  try { sink = sinkFactory(); } catch { logging.unavailable++; }
  function time (name) {
    const hist = stages.get(name); if (!hist || closed) { if (!hist) unknownStages++; return NOOP; }
    let start; try { start = clock(); } catch { hist.invalid++; return NOOP; }
    let finished = false;
    return () => {
      if (finished) return; finished = true;
      try {
        const elapsed = clock() - start;
        if (!Number.isFinite(elapsed) || elapsed < 0) { hist.invalid++; return; }
        hist.count++; hist.sumMs += elapsed; hist.maxMs = Math.max(hist.maxMs, elapsed);
        hist.buckets[BOUNDS.findIndex(upper => elapsed <= upper)]++;
      } catch { hist.invalid++; }
    };
  }
  function delta (name, amount) {
    const gauge = gauges.get(name); if (!gauge || closed) return;
    if (!Number.isSafeInteger(amount) || gauge.value + amount < 0) { gauge.invalid++; return; }
    gauge.value += amount; gauge.observations++;
  }
  function clientQueries (client, record) {
    const previous = seenClients.get(client);
    if (previous) { if (previous !== record) record.unknown++; return; }
    if (!client || typeof client.query !== 'function') { record.unknown++; return; }
    seenClients.set(client, record);
    const query = client.query;
    client.query = function (...args) {
      const config = args[0], last = args.length - 1, callback = args[last];
      if (config == null || typeof config !== 'string' && (typeof config !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(config)) || Object.hasOwn(config, 'submit') || Object.hasOwn(config, 'callback'))) {
        record.unknown++; return query.apply(this, args);
      }
      const end = time('pool.query_' + record.kind); record.active++; record.queries++;
      let complete = false;
      const done = () => { if (!complete) { complete = true; record.active--; end(); } };
      if (typeof callback === 'function') {
        args[last] = function (...values) { done(); return callback.apply(this, values); };
        try { return query.apply(this, args); } catch (error) { done(); throw error; }
      }
      let result;
      try { result = query.apply(this, args); } catch (error) { done(); throw error; }
      if (!result || typeof result.then !== 'function') { record.unknown++; done(); return result; }
      return result.then(value => { done(); return value; }, error => { done(); throw error; });
    };
  }
  function observePool (pool, kind) {
    if (closed || seenPools.has(pool)) return pool;
    if (!KINDS.includes(kind) || pools.size >= MAX_POOLS || !pool || typeof pool.connect !== 'function' || typeof pool.end !== 'function') { poolOverflow++; return pool; }
    seenPools.add(pool);
    const record = { pool, kind, active: 0, queries: 0, unknown: 0 }; pools.add(record);
    const connect = pool.connect, endPool = pool.end;
    pool.connect = function (...args) {
      if (args.length && args[0] !== undefined && typeof args[0] !== 'function') { record.unknown++; return connect.apply(this, args); }
      const end = time('pool.wait_' + kind);
      if (typeof args[0] === 'function') {
        const callback = args[0]; args[0] = function (...values) { end(); if (!values[0]) clientQueries(values[1], record); return callback.apply(this, values); };
        try { return connect.apply(this, args); } catch (error) { end(); throw error; }
      }
      let result;
      try { result = connect.apply(this, args); } catch (error) { end(); throw error; }
      if (!result || typeof result.then !== 'function') { record.unknown++; end(); return result; }
      return result.then(client => { end(); clientQueries(client, record); return client; }, error => { end(); throw error; });
    };
    pool.end = function (...args) {
      if (typeof args[0] === 'function') {
        const callback = args[0]; args[0] = function (...values) { if (!values[0]) pools.delete(record); return callback.apply(this, values); };
        return endPool.apply(this, args);
      }
      const result = endPool.apply(this, args);
      if (!result || typeof result.then !== 'function') return result;
      return result.then(value => { pools.delete(record); return value; });
    };
    return pool;
  }
  function snapshot () {
    const selected = {};
    for (const kind of KINDS) {
      const value = { status: 'UNMEASURED', tracked: 0, total: 0, idle: 0, checkedout: 0, waiting: 0, activeSQL: 0, sqlObservations: 0, sqlStatus: 'UNMEASURED', unsupportedQueryForms: 0 };
      let invalid = false;
      for (const record of pools) if (record.kind === kind) {
        try {
          const { totalCount: total, idleCount: idle, waitingCount: waiting } = record.pool;
          if (![total, idle, waiting].every(n => Number.isSafeInteger(n) && n >= 0) || idle > total) { invalid = true; continue; }
          value.tracked++; value.total += total; value.idle += idle; value.checkedout += total - idle; value.waiting += waiting;
          value.activeSQL += record.active; value.sqlObservations += record.queries; value.unsupportedQueryForms += record.unknown;
        } catch { invalid = true; }
      }
      if (value.tracked && !invalid && !poolOverflow) value.status = 'MEASURED';
      if (value.status === 'MEASURED' && value.sqlObservations && !value.unsupportedQueryForms) value.sqlStatus = 'MEASURED';
      selected[kind] = value;
    }
    return { version: 1, process: process.pid, coverage: { pools: 'observed_pg_pools_only', directClients: 'UNMEASURED', sql: 'outstanding_client_query_calls' }, roles: [...roles], rolesStatus: rolesMeasured ? 'MEASURED' : 'UNMEASURED', at: Date.now(),
      pools: selected, poolOverflow, unknownStages, bucketsUpperMs: BOUNDS.map(n => Number.isFinite(n) ? n : null),
      durations: Object.fromEntries([...stages].map(([name, hist]) => [name, { status: hist.count && !hist.invalid ? 'MEASURED' : 'UNMEASURED', ...hist, buckets: [...hist.buckets] }])),
      gauges: Object.fromEntries([...gauges].map(([name, gauge]) => [name, { status: gauge.observations && !gauge.invalid ? 'MEASURED' : 'UNMEASURED', ...gauge }])),
      logging: { status: logging.written && !logging.dropped && !logging.unavailable ? 'MEASURED' : 'UNMEASURED', ...logging } };
  }
  function emit () {
    if (closed) return false;
    logging.attempted++;
    let state;
    try { state = sink ? sink.state() : 'unavailable'; } catch { state = 'unavailable'; }
    if (state !== 'ready') { logging.dropped++; logging[['busy', 'backpressure', 'unavailable'].includes(state) ? state : 'unavailable']++; return false; }
    try {
      const text = '\nNS_M7_DIAGNOSTICS ' + JSON.stringify(snapshot()) + '\n', size = Buffer.byteLength(text);
      if (size > MAX_BYTES) { logging.dropped++; logging.oversized++; return false; }
      const bytes = new ArrayBuffer(size); Buffer.from(bytes).write(text);
      if (sink.send(bytes, okay => { if (okay) logging.written++; else { logging.dropped++; logging.unavailable++; } })) return true;
    } catch { /* Diagnostics never changes application results. */ }
    logging.dropped++; logging.unavailable++; return false;
  }
  const interval = setInterval(emit, intervalMs); interval.unref();
  return Object.freeze({ enabled: true, time, delta, observePool, snapshot, emit,
    configureRoles (names) {
      const allowed = Object.keys(require('../server/serve/roles').ROLES);
      if (Array.isArray(names) && names.length && names.every(name => allowed.includes(name)) && new Set(names).size === names.length) { roles = [...names].sort(); rolesMeasured = true; }
      else { roles = []; rolesMeasured = false; }
    },
    wrapAsync (fn, stage) { return async function (...args) { const end = time(stage); try { return await fn.apply(this, args); } finally { end(); } }; },
    close () { if (closed) return; closed = true; clearInterval(interval); try { sink?.close(); } catch { /* No drain dependency on diagnostics. */ } }
  });
}
function environment () {
  if (process.env.NS_M7_DIAGNOSTICS !== '1') return { enabled: false };
  const raw = process.env.NS_M7_DIAGNOSTICS_INTERVAL_MS;
  if (raw !== undefined && (!/^[1-9][0-9]*$/.test(raw) || Number(raw) < 1000 || Number(raw) > 60000)) return { enabled: false };
  return { enabled: true, intervalMs: raw === undefined ? 5000 : Number(raw) };
}
module.exports = { ...create(environment()), create };
