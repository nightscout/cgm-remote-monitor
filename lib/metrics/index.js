'use strict';

// Opt-in Prometheus metrics for multitenant role processes (alignment decision
// prometheus-metrics-narrow). NS_METRICS=true turns them on; the default is
// off. Off, every hook below is a shared no-op, the client library is never loaded,
// no metric is registered and no pool, client or app is touched.
//
// On, the process's private listener (serve.internal) answers GET /metrics in
// the Prometheus text format, next to /healthz/*. It is never the public api
// port.
//
// Labels are bounded by construction: role, slice, phase, outcome,
// application_name, method, route (an Express template), status_class and
// namespace. No label carries a tenant id: route templates are sanitized and
// capped, application_name accepts only the source-owned nightscout-* names,
// and anything else is reported as 'other'.
const { performance } = require('node:perf_hooks');

const NOOP = () => {};
const END = () => NOOP;
const KEY = 'NS_METRICS';
const PHASES = Object.freeze(['begin', 'settings', 'acquisition', 'time', 'completion', 'consumers']);
const NAMESPACES = Object.freeze(['/', '/storage', '/alarm']);
const MAX_ROUTES = 128, MAX_APPLICATIONS = 48;
const APPLICATION = /^nightscout-[a-z][a-z0-9-]{0,47}$/;
// A path segment that may stand in a route label as written: a short word.
// Anything else (ids, hex, digits, dots) becomes ':value'.
const STATIC_SEGMENT = /^(?::[A-Za-z_][A-Za-z0-9_]*\??|\*|v[0-9]{1,2}|[A-Za-z][A-Za-z_-]{0,31})$/;
// Fast buckets for single phases and statements; wider for round trips.
const PHASE_BUCKETS = [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const HTTP_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
// Stage lag (decision latency-objectives): resolves the 1 s and 30 s
// objectives and the 120 s clinical deadline, with room past it.
const LAG_BUCKETS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 300, 600];
const LAG_STAGES = Object.freeze(['evaluator', 'realtime']);

class MetricsConfigError extends Error {
  constructor (message) { super(message); this.code = 'METRICS_CONFIG_REFUSED'; }
}

// NS_METRICS: unset, empty or 'false' is off; 'true' is on; anything else refuses.
function settings (source = process.env) {
  const raw = source && Object.hasOwn(source, KEY) ? String(source[KEY]).trim().toLowerCase() : '';
  if (raw === '' || raw === 'false') return { enabled: false };
  if (raw === 'true') return { enabled: true };
  throw new MetricsConfigError(KEY + ' must be true or false');
}

const OFF = Object.freeze({
  enabled: false,
  phase: END,
  observePool: pool => pool,
  middleware: null,
  realtime: NOOP,
  evaluator: NOOP,
  lag: NOOP,
  realtimePending: NOOP,
  consumerRefusal: NOOP,
  setSlice: NOOP,
  handle: null,
  text: async () => '',
  contentType: 'text/plain'
});

function statusClass (code) {
  return Number.isInteger(code) && code >= 100 && code < 600 ? Math.floor(code / 100) + 'xx' : 'other';
}
function routeLabel (req) {
  const template = req.route && typeof req.route.path === 'string' ? req.route.path : null;
  if (template === null) return 'unmatched';
  const text = String(req.baseUrl || '') + template;
  const segments = text.split('/').map(segment => segment === '' || STATIC_SEGMENT.test(segment) ? segment : ':value');
  return segments.join('/').slice(0, 96) || '/';
}
// Values the label guard rejects: anything that could be a tenant id.
const TENANTISH = [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, /[0-9a-f]{16,}/i];
const tenantLike = value => TENANTISH.some(pattern => pattern.test(String(value)));

function create ({ roles = [], client = require('@prometheus-io/client') } = {}) {
  const register = new client.Registry();
  const role = [...roles].sort().join('+') || 'none';
  register.setDefaultLabels({ role });
  client.collectDefaultMetrics({ register, eventLoopMonitoringPrecision: 20 });
  let slice = 'all';
  const metrics = {};
  const lazy = (name, make) => metrics[name] || (metrics[name] = make());
  const phaseHistogram = () => lazy('phase', () => new client.Histogram({ name: 'nightscout_evaluator_phase_seconds', registers: [register],
    help: 'Evaluator wall time per phase of one write or cycle, measured with performance.now() around the phase (includes awaited I/O).',
    labelNames: ['slice', 'phase'], buckets: PHASE_BUCKETS }));
  let phaseChildren = null;
  const bindPhases = () => { const h = phaseHistogram(); phaseChildren = Object.fromEntries(PHASES.map(name => [name, h.labels(slice, name)])); };

  function phase (name) {
    if (!phaseChildren) bindPhases();
    const child = phaseChildren[name];
    if (!child) return NOOP;
    const start = performance.now();
    let done = false;
    return () => { if (done) return; done = true; child.observe((performance.now() - start) / 1000); };
  }

  // Statements are counted per pooled client, once per physical client, at the
  // pool core already builds (lib/storage/postgres-connection.js). pg is never
  // patched globally. At about 170 statements per write, a client observe
  // per statement (it validates and hashes labels each call) cost about 0.8 us
  // each offline, so statements accumulate in plain numbers per
  // application_name and are published at scrape time: a count and a seconds
  // total, no per-statement histogram.
  const applications = new Map();
  const statements = () => lazy('sql', () => ({
    total: new client.Counter({ name: 'nightscout_pg_statements_total', registers: [register],
      help: 'SQL statements issued through observed pools, by the pool\'s application_name.', labelNames: ['application_name', 'outcome'],
      collect () { this.reset(); for (const [name, r] of applications) { this.inc({ application_name: name, outcome: 'ok' }, r.ok); this.inc({ application_name: name, outcome: 'error' }, r.failed); } } }),
    seconds: new client.Counter({ name: 'nightscout_pg_statement_seconds_total', registers: [register],
      help: 'Client-side statement time (query call to result) summed, by the pool\'s application_name; divide by statements for the mean.', labelNames: ['application_name'],
      collect () { this.reset(); for (const [name, r] of applications) this.inc({ application_name: name }, r.seconds); } })
  }));
  const OTHER = 'other';
  function record (name) {
    let label = typeof name === 'string' && APPLICATION.test(name) ? name : OTHER;
    if (!applications.has(label) && applications.size >= MAX_APPLICATIONS) label = OTHER;
    if (!applications.has(label)) applications.set(label, { ok: 0, failed: 0, seconds: 0 });
    return applications.get(label);
  }
  const wrapped = new WeakSet();
  function wrapClient (client, bound) {
    if (!client || wrapped.has(client) || typeof client.query !== 'function') return;
    wrapped.add(client);
    const query = client.query;
    client.query = function (...args) {
      const last = args.length - 1, callback = args[last], config = args[0];
      // Submittables (cursors, streams) are counted, not timed.
      if (config && typeof config === 'object' && typeof config.submit === 'function') { bound.ok++; return query.apply(this, args); }
      const start = performance.now();
      let done = false;
      const finish = failed => { if (done) return; done = true; bound.seconds += (performance.now() - start) / 1000; if (failed) bound.failed++; else bound.ok++; };
      if (typeof callback === 'function') {
        args[last] = function (error, ...rest) { finish(!!error); return callback.call(this, error, ...rest); };
        try { return query.apply(this, args); } catch (error) { finish(true); throw error; }
      }
      let result;
      try { result = query.apply(this, args); } catch (error) { finish(true); throw error; }
      if (!result || typeof result.then !== 'function') { finish(false); return result; }
      return result.then(value => { finish(false); return value; }, error => { finish(true); throw error; });
    };
  }
  function observePool (pool, applicationName) {
    if (!pool || typeof pool.on !== 'function') return pool;
    statements();
    const bound = record(applicationName ?? pool.options?.application_name);
    pool.on('connect', client => wrapClient(client, bound));
    return pool;
  }

  const routes = new Set();
  const requests = () => lazy('http', () => new client.Histogram({ name: 'nightscout_http_request_seconds', registers: [register],
    help: 'api request duration by method, Express route template and status class.',
    labelNames: ['method', 'route', 'status_class'], buckets: HTTP_BUCKETS }));
  const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
  function middleware (req, res, next) {
    const start = performance.now();
    res.once('finish', () => {
      let route = routeLabel(req);
      if (!routes.has(route)) { if (routes.size >= MAX_ROUTES) route = 'other'; else routes.add(route); }
      requests().labels(METHODS.has(req.method) ? req.method : 'other', route, statusClass(res.statusCode))
        .observe((performance.now() - start) / 1000);
    });
    next();
  }

  // Read at scrape time; nothing on the socket path.
  function realtime (io) {
    if (!io || typeof io.of !== 'function') return;
    lazy('sockets', () => new client.Gauge({ name: 'nightscout_realtime_connected_sockets', registers: [register],
      help: 'Socket.IO sockets connected to the realtime role, by namespace.', labelNames: ['namespace'],
      collect () { for (const name of NAMESPACES) { try { this.set({ namespace: name }, io.of(name).sockets.size); } catch { /* scrape only */ } } } }));
  }

  // Pending work, read at scrape time from the runtime's own in-memory state.
  function evaluator (summary) {
    if (typeof summary !== 'function') return;
    let last = null;
    const read = () => { try { last = summary(); } catch { last = null; } return last; };
    lazy('pendingAge', () => new client.Gauge({ name: 'nightscout_evaluator_pending_oldest_age_seconds', registers: [register],
      help: 'Age of the oldest input this evaluator still owes a completion for, across its tenants (0 when none).', labelNames: ['slice'],
      collect () { const s = read(); if (s) this.set({ slice }, Math.max(0, s.oldestAgeMs || 0) / 1000); } }));
    lazy('pendingTenants', () => new client.Gauge({ name: 'nightscout_evaluator_pending_tenants', registers: [register],
      help: 'Tenants with input pending a durable completion in this evaluator.', labelNames: ['slice'],
      collect () { if (last) this.set({ slice }, last.pending); } }));
    lazy('queuedCycles', () => new client.Gauge({ name: 'nightscout_evaluator_queued_cycles', registers: [register],
      help: 'Tenants with an acquisition or time cycle queued or running in this evaluator (backlog).', labelNames: ['slice'],
      collect () { if (last) this.set({ slice }, last.queued); } }));
    lazy('tenants', () => new client.Gauge({ name: 'nightscout_evaluator_tenants', registers: [register],
      help: 'Tenants this evaluator holds state for.', labelNames: ['slice'],
      collect () { if (last) this.set({ slice }, last.tenants); } }));
    lazy('residents', () => new client.Gauge({ name: 'nightscout_evaluator_resident_tenants', registers: [register],
      help: 'Tenants holding an evaluated instance in this evaluator (the resident cache size when NS_EVALUATOR_RESIDENT_MAX bounds it); warm-up is complete when it reaches the owned count.', labelNames: ['slice'],
      collect () { if (last && Number.isSafeInteger(last.residents)) this.set({ slice }, last.residents); } }));
  }

  // Stage lag (M1), observed once per event where both instants are already
  // known: evaluator, oldest covered input -> durable completion; realtime,
  // completed output known to this process -> first frame sent. No tenant
  // label. Inputs are milliseconds; a negative difference (clocks of two
  // processes) is observed as 0 and counted, so the offset stays visible.
  const lagHistogram = () => lazy('lag', () => ({
    evaluator: new client.Histogram({ name: 'nightscout_evaluator_completion_lag_seconds', registers: [register],
      help: 'Per durable completion that covers the oldest input this evaluator owed for the tenant: completion time minus that input\'s pending mark (the writer\'s durable observation or this process\'s hint receipt, whichever is older).',
      labelNames: ['slice'], buckets: LAG_BUCKETS }),
    realtime: new client.Histogram({ name: 'nightscout_realtime_frame_lag_seconds', registers: [register],
      help: 'Per realtime fanout that sent a frame: send time minus the time this process first learned the completed output revision was available.',
      labelNames: [], buckets: LAG_BUCKETS }),
    skew: new client.Counter({ name: 'nightscout_stage_lag_negative_total', registers: [register],
      help: 'Stage lag observations whose end preceded their start (clock offset between processes); observed as 0.',
      labelNames: ['stage'] })
  }));
  function lag (stage, ms) {
    if (!LAG_STAGES.includes(stage) || typeof ms !== 'number' || !Number.isFinite(ms)) return;
    const series = lagHistogram();
    if (ms < 0) { series.skew.inc({ stage }); ms = 0; }
    if (stage === 'evaluator') series.evaluator.labels(slice).observe(ms / 1000);
    else series.realtime.observe(ms / 1000);
  }
  // Realtime backlog (M2), read at scrape time from the runtime's memory:
  // tenants whose completed output this process knows of but has not yet
  // published, and the age of the oldest such notice.
  function realtimePending (summary) {
    if (typeof summary !== 'function') return;
    let last = null;
    const read = () => { try { last = summary(); } catch { last = null; } return last; };
    lazy('realtimePendingAge', () => new client.Gauge({ name: 'nightscout_realtime_pending_oldest_age_seconds', registers: [register],
      help: 'Age of the oldest completed-output notice this realtime process has not yet published (0 when none).',
      collect () { const s = read(); if (s) this.set(Math.max(0, s.oldestAgeMs || 0) / 1000); } }));
    lazy('realtimePendingTenants', () => new client.Gauge({ name: 'nightscout_realtime_pending_tenants', registers: [register],
      help: 'Tenants with a completed-output notice this realtime process has not yet published.',
      collect () { if (last) this.set(last.pending); } }));
  }

  // A refused consumer pass, by a bounded code (lib/server/serve/evaluator-consumers.js
  // refusalLog caps the distinct codes). No tenant label.
  function consumerRefusal (code) {
    lazy('consumerRefusals', () => new client.Counter({ name: 'nightscout_evaluator_consumer_refusals_total', registers: [register],
      help: 'Evaluator notification consumer passes refused (EVALUATOR_CONSUMER_REFUSED), by refusal code.', labelNames: ['slice', 'code'] }))
      .inc({ slice, code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(code) ? code : 'OTHER' });
  }

  // The slice is read from the evaluator's configuration after boot; never derived here.
  function setSlice (value) {
    const text = value === undefined || value === null ? 'all' : String(value);
    slice = /^[0-9]{1,4}$/.test(text) ? text : 'all';
    if (phaseChildren) bindPhases();
  }

  async function handle (req, res) {
    const body = await register.metrics();
    res.writeHead(200, { 'content-type': register.contentType, 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
    res.end(body);
  }

  return Object.freeze({ enabled: true, register, phase, observePool, middleware, realtime, evaluator, lag, realtimePending, consumerRefusal, setSlice, handle,
    text: () => register.metrics(), contentType: register.contentType });
}

// The process's metrics: OFF until configure() runs with NS_METRICS=true.
let current = OFF;
function configure (roles, source = process.env) {
  if (!settings(source).enabled) { current = OFF; return current; }
  if (!current.enabled) current = create({ roles });
  return current;
}
function reset () { if (current.enabled) current.register.clear(); current = OFF; }

module.exports = {
  KEY, PHASES, LAG_BUCKETS, MetricsConfigError, settings, create, configure, reset, routeLabel, tenantLike,
  get current () { return current; },
  // Hot-path hooks: each forwards to the configured instance or to OFF's no-op.
  phase: name => current.phase(name),
  consumerRefusal: code => current.consumerRefusal(code),
  observePool: (pool, name) => current.observePool(pool, name),
  lag: (stage, ms) => current.lag(stage, ms)
};
