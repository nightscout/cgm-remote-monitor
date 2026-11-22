'use strict';

const scope = require('../../storage/tenant-scope');
const connect = require('../../storage/postgres-connection');
const metrics = require('../../metrics');
const makeStore = require('../../tenant-notifications/postgres');
const makeNotifier = require('../../tenant-notifications/component');
const makeReader = require('../../tenant-alarms/postgres').createReader;
const makeProducer = require('../../tenant-notifications/producer');
const { armed } = require('../../tenant-notifications/producer-state');
const switches = require('./overload-switches');
// An overdue repeat time can never re-arm faster than this (no busy loop).
const REPEAT_WAKE_FLOOR_MS = 1000;
// One NS_EVAL_PRIORITY turn: how often held consumer passes get their share.
const PASS_TURN_MS = 100;
// Temporary switch (lane plannable-scale H3; deleted at adoption, or with the
// fix if refuted). On: the producer's authority/version checks, and where the
// ACK witness holds its suppression read, run before the outbox transaction
// (lib/tenant-notifications/producer.js), and refused passes are counted and
// logged (bounded, no tenant). Off: unchanged.
const PREREAD_KEY = 'NS_CONSUMER_PASS_PREREAD';
function prereadSwitch (source = process.env) {
  const raw = source && Object.hasOwn(source, PREREAD_KEY) ? String(source[PREREAD_KEY]).trim().toLowerCase() : '';
  if (raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  throw new TypeError(PREREAD_KEY + ' must be true or false');
}
const REFUSAL_LOG_MS = 10000, REFUSAL_CODES = 16;
const CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
function refusalCode (error) {
  if (typeof error?.code === 'string' && CODE.test(error.code)) return error.code;
  if (typeof error?.message === 'string' && CODE.test(error.message)) return error.message;
  if (error?.message === 'timeout exceeded when trying to connect') return 'POOL_CHECKOUT_TIMEOUT';
  if (typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code)) return 'SQLSTATE_' + error.code;
  return 'OTHER';
}
// Aggregate only: a count per bounded code and at most one line per
// REFUSAL_LOG_MS with the counts since the previous line. Never a tenant id.
function refusalLog (now, log = message => console.warn(message)) {
  const counts = new Map(), since = new Map(); let total = 0, lastAt = null;
  return {
    note (error) {
      let code = refusalCode(error);
      if (!counts.has(code) && counts.size >= REFUSAL_CODES) code = 'OTHER';
      total++; counts.set(code, (counts.get(code) || 0) + 1); since.set(code, (since.get(code) || 0) + 1);
      metrics.consumerRefusal(code);
      const at = now();
      if (lastAt === null || at - lastAt >= REFUSAL_LOG_MS) {
        log('Evaluator consumer passes refused since last report: ' + [...since].map(([key, n]) => key + '=' + n).join(' ') + ' (total ' + total + ')');
        since.clear(); lastAt = at;
      }
    },
    get total () { return total; },
    counts: () => Object.fromEntries(counts)
  };
}

// The same coordinator is used by the selected role and source-protocol tests.
// Jobs are independent from clinical scheduling and serialized only per tenant.
//
// Delivery follows output revisions, lifecycle wakes and durable deadlines.
// The standard role uses bounded discovery and tenant-scoped work. Explicit
// fixed-roster callers retain their active retry and repeat timers.
function coordinate ({ tenants, route, current, peek = current, version = current, currentConfig, isCurrent, store, reader, adapter, operationWindow, jobContext, activity, discovery, schedule = setInterval,
  cancel = clearInterval, delay = (fn, ms) => setTimeout(fn, ms), undelay = timer => clearTimeout(timer), now = Date.now, dynamic = false, maxTenants = 10000,
  preread = prereadSwitch(), ackWitness = false, refusalLogger, oneSelect = switches.oneSelect(), evaluationFirst = false, evaluatorBacklog, ...limits }) {
  if (!Array.isArray(tenants) || (!dynamic && !tenants.length) || new Set(tenants).size !== tenants.length ||
      [current, peek, version, currentConfig, isCurrent, schedule, cancel, delay, undelay, now].some(fn => typeof fn !== 'function') ||
      [limits.pollIntervalMs, limits.retryIntervalMs].some(n => !Number.isSafeInteger(n) || n < 1 || n > 2147483647)) {
    throw new TypeError('Explicit evaluator consumer tenants/current output/schedules required');
  }
  if (typeof oneSelect !== 'boolean' || typeof evaluationFirst !== 'boolean' || (evaluationFirst && typeof evaluatorBacklog !== 'function')) {
    throw new TypeError('Explicit consumer pass selection and priority required');
  }
  if(typeof dynamic!=='boolean' || !Number.isSafeInteger(maxTenants) || maxTenants<1)throw new TypeError('Explicit dynamic tenant bound required');
  if (operationWindow !== undefined && typeof operationWindow.run !== 'function') throw new TypeError('Consumer operation window required');
  if (!operationWindow && jobContext !== undefined) throw new TypeError('Consumer jobs require their selected operation window');
  const jobs = operationWindow ? require('./evaluator-job-context').claim(jobContext, 'delivery') : null;
  if (jobs) {
    const timer = delay, interval = schedule;
    delay = (fn, ms) => timer(jobs.bind(fn), ms);
    schedule = (fn, ms) => interval(jobs.bind(fn), ms);
  }
  if (activity !== undefined && typeof activity?.check !== 'function') throw new TypeError('Consumer activity eligibility required');
  if (discovery !== undefined && ['admit','pending','deadlines','acknowledge'].some(key => typeof discovery[key] !== 'function')) {
    throw new TypeError('Explicit notification recovery capabilities required');
  }
  const producer = makeProducer({store, reader, current, version, currentConfig, isCurrent, consumer: adapter.id, now,
    ...(preread && ackWitness ? {preread: true} : {}),
    ...(discovery ? {minimumRepeatMs: REPEAT_WAKE_FLOOR_MS} : {}),
    maxRows: limits.maxRows, maxBytes: limits.maxBytes, maxPayloadBytes: limits.maxPayloadBytes});
  // Load telemetry: every producer selection is one or more SQL transactions.
  const select = tenant => { const state = states.get(tenant); if (state) state.selections++; return producer.select(tenant); };
  const notifier = makeNotifier({ store, adapter, selectCycle: select, isCurrent, requireIntentOrigin: true,
    ...(oneSelect ? { revalidate: (tenant, selection) => producer.revalidate(selection) } : {}),
    ...(typeof store.beforeSend === 'function' ? {beforeSend:tenant=>store.beforeSend(tenant)} : {}),
    currentAuthority: async tenant => {
      const current = await currentConfig(tenant);
      return current?.tenant === tenant && await isCurrent(tenant, current.identity) === true;
    },
    mayAttempt: async ({tenant, notification}) => notification.clear === true || peek(tenant)?.eligible === true || !!discovery && (await current(tenant))?.eligible === true,
    allows: request => reader.allows(request), now, normalPolicy: 'realtime-cycle',
    maxRows: limits.maxRows, maxPayloadBytes: limits.maxPayloadBytes, maxInflight: limits.maxInflight,
    attemptTimeoutMs: limits.attemptTimeoutMs, retryDelayMs: limits.retryDelayMs });
  tenants = [...tenants];
  const makeState = tenant => ({ tenant, run: false, retry: false, running: null, runningParent: null, runTicket: null, retryTicket: null, parentRunTicket: null, parentRetryTicket: null,
    state: 'starting', code: null, intents: [], observedAt: null, lastHandoffAcceptedAt: null, passes: 0, selections: 0, repeatAt: null, repeatTimer: null });
  const states = new Map(tenants.map(tenant => [tenant,makeState(tenant)]));
  const activeSet = new Set(), retiredJobs = new Set();
  const deferred = new Map();
  const cadence = Math.min(limits.pollIntervalMs, limits.retryIntervalMs, 30000);
  const timers = []; let discoveryTimer, discoveryAt, started = false, closed = false, closing, recovering, recoverAgain = false;
  const maxConcurrentTenants = limits.maxConcurrentTenants ?? 4;
  if (!Number.isSafeInteger(maxConcurrentTenants) || maxConcurrentTenants < 1 || maxConcurrentTenants > 2147483647) {
    throw new TypeError('Explicit evaluator consumer concurrency required');
  }
  const sweeping = new Set(), counters = { sweeps: 0, revisedWakes: 0, ...(evaluationFirst ? { passesHeld: 0 } : {}) };
  const gate = evaluationFirst ? passGate() : null;
  // NS_EVAL_PRIORITY=evaluation-first: a consumer pass waits while the
  // evaluator owes a queued recompute (evaluatorBacklog() > 0, work not yet
  // dispatched). Every turn (PASS_TURN_MS) still admits up to
  // maxConcurrentTenants waiting passes, oldest first; with no backlog a turn
  // admits all. A waiting pass is never dropped: its tenant's ticket stays
  // owned, and later hints for that tenant coalesce into it.
  function passGate () {
    const waiting = []; let timer = null;
    const backlog = () => { try { return evaluatorBacklog() > 0; } catch { return false; } };
    function arm () { if (!timer && !closed && waiting.length) { timer = delay(turn, PASS_TURN_MS); timer?.unref?.(); } }
    function turn () {
      timer = null;
      let share = backlog() ? maxConcurrentTenants : waiting.length;
      while (share-- > 0 && waiting.length) waiting.shift()();
      arm();
    }
    return {
      enter () {
        if (closed || (!waiting.length && !backlog())) return Promise.resolve();
        counters.passesHeld++;
        return new Promise(resolve => { waiting.push(resolve); arm(); });
      },
      get waiting () { return waiting.length; },
      release () { if (timer) undelay(timer); timer = null; for (const resolve of waiting.splice(0)) resolve(); }
    };
  }
  const refusals = preread ? refusalLog(now, refusalLogger) : null;
  // One pass of `kind` over `list`, bounded; a pass of the same name still
  // running makes the next one a no-op (its tenants are already coalescing).
  async function sweep (name, kind, list) {
    if (sweeping.has(name) || closed || !started) return;
    sweeping.add(name); counters.sweeps++;
    try {
      let next = 0;
      const worker = async () => {
        while (next < list.length && !closed) {
          const tenant = list[next++];
          try {
            if (name === 'durable' && !await discovery.admit(tenant)) continue;
            await enqueue(tenant, kind);
          } catch { /* Discovery retries outstanding durable work. */ }
        }
      };
      await Promise.all(Array.from({ length: Math.min(maxConcurrentTenants, list.length) }, worker));
    } finally { sweeping.delete(name); }
  }
  function active (tenant) {
    const state = states.get(tenant);
    return !discovery && !!state && (state.state === 'refused' || state.state === 'pending' || state.repeatAt !== null);
  }
  // One-shot wake at the producer's alarm repeat time, for a tenant whose
  // current output requests a notification; cleared when it no longer does.
  function arm (state, repeatAt) {
    if (state.repeatTimer) { undelay(state.repeatTimer); state.repeatTimer = null; }
    state.repeatAt = Number.isSafeInteger(repeatAt) ? repeatAt : null;
    if (discovery || state.repeatAt === null || closed || state.removed) return;
    state.repeatTimer = delay(() => { state.repeatTimer = null; enqueue(state.tenant, 'run').catch(() => {}); },
      Math.min(2147483647, Math.max(REPEAT_WAKE_FLOOR_MS, state.repeatAt - now())));
    state.repeatTimer?.unref?.();
  }
  function armDiscovery (ms) {
    const at = now() + Math.max(0, ms);
    if (closed || discoveryTimer && discoveryAt <= at) return;
    if (discoveryTimer) undelay(discoveryTimer);
    discoveryAt = at;
    discoveryTimer = delay(() => {
      discoveryTimer = null;
      value.recover().catch(() => {});
    }, Math.max(0, ms));
    discoveryTimer?.unref?.();
  }
  async function discover () {
    const at = now();
    for (const [tenant, until] of deferred) if (until <= at) deferred.delete(tenant);
    const exclude = [...deferred.keys()];
    const pending = await discovery.pending(exclude);
    const deadlines = await discovery.deadlines(exclude, at + cadence);
    const due = new Set(pending.map(row => row.tenant));
    for (const row of deadlines) if (row.at <= at) due.add(row.tenant);
    const future = deadlines.find(row => row.at > at)?.at;
    if (due.size) {
      await sweep('durable', 'run', [...due]);
      // A still-overdue row (e.g. paused, refused or a busy transport) cannot
      // repeatedly displace later deadlines from the bounded head of the index.
      for (const tenant of due) {
        const state = states.get(tenant);
        if (!state || state.recoveryDeferred || ['inactive','refused'].includes(state.state)) deferred.set(tenant, now() + Math.min(cadence, 1000));
      }
    }
    const next = Math.min(future ?? Infinity, ...deferred.values());
    armDiscovery(due.size ? Math.min(cadence, 25) : Math.min(cadence, next - now()));
  }
  const parentBusy = () => Object.assign(new Error('EVALUATOR_JOB_PARENT_BUSY'), { code: 'EVALUATOR_JOB_PARENT_BUSY' });
  const parentOf = tenant => operationWindow ? require('../../tenant-lifecycle/generation-scope').schedulingParent(operationWindow, tenant) : null;
  async function drain (state, parent) {
    while (!closed && !state.removed) {
      const runKey = parent ? 'parentRunTicket' : 'runTicket', retryKey = parent ? 'parentRetryTicket' : 'retryTicket';
      const key = state[runKey] ? runKey : state[retryKey] ? retryKey : null;
      if (!key) return;
      const ticket = state[key]; state[key] = null;
      state.run = !!(state.runTicket || state.parentRunTicket); state.retry = !!(state.retryTicket || state.parentRetryTicket);
      try {
        if (activity) {
          // Paused/suspended tenants deliver nothing, including retries and clears.
          const checked = await activity.check('notification', state.tenant);
          if (closed || state.removed) return;
          if (!checked.eligible) { arm(state,null); if (!state.recoverOutbox) activeSet.delete(state.tenant); state.state = 'inactive'; state.code = 'EVALUATOR_CONSUMER_' + checked.code; state.observedAt = now(); continue; }
        }
        if (gate) { await gate.enter(); if (closed || state.removed) return; }
        state.passes++;
        try {
          const observe = async () => {
            const selected = await select(state.tenant);
            if (closed || state.removed) return;
            arm(state, selected?.repeatAt);
            if (discovery && selected?.consumedOutput) await discovery.acknowledge(state.tenant, selected.consumedOutput);
            const observed = await notifier.retry(state.tenant, oneSelect ? selected : undefined);
            if (closed || state.removed) return;
            state.recoverOutbox = false;
            state.recoveryDeferred = !selected?.consumedOutput || observed.results?.some(row => row.state === 'deferred');
            state.observedAt = now(); state.intents = observed.results || [];
            // Preserved attempts also remain visible before their deadline.
            const acceptedIds = new Set(state.intents.filter(row => row.state === 'accepted').map(row => row.id));
            const pending = state.intents.some(row => !['accepted', 'cancelled'].includes(row.state)) ||
              selected?.preserved?.some(id => !acceptedIds.has(id));
            const accepted = state.intents.some(row => row.state === 'accepted');
            state.state = pending ? 'pending' : accepted ? 'handoff-accepted' : 'idle';
            state.code = pending ? 'EVALUATOR_CONSUMER_HANDOFF_PENDING' : null;
            if (accepted) state.lastHandoffAcceptedAt = state.observedAt;
          };
          const endConsumers = metrics.phase('consumers');
          try {
            if (operationWindow) await operationWindow.run(state.tenant, observe);
            else await observe();
          } finally { endConsumers(); }
        } catch (error) {
          if (closed || state.removed) return;
          refusals?.note(error);
          state.state = 'refused'; state.code = 'EVALUATOR_CONSUMER_REFUSED'; state.intents = [];
          state.observedAt = now();
        }
        if (state.removed) return;
        if (discovery && !recovering) {
          deferred.delete(state.tenant);
          armDiscovery(0);
        }
        if (active(state.tenant)) activeSet.add(state.tenant); else activeSet.delete(state.tenant);
      } catch (error) { ticket.reject(error); throw error; } finally { ticket.resolve(); }
    }
  }
  function pump (state, parent = null) {
    if (state.running) return;
    state.runningParent = parent;
    const run = () => drain(state,parent);
    const finish = () => {
      state.running = null; state.runningParent = null;
      if (!closed && !state.removed && parent && (state.parentRunTicket?.parent === parent || state.parentRetryTicket?.parent === parent)) {
        let active = false; try { active = parentOf(state.tenant) === parent; } catch { /* expired parent remains refused */ }
        if (active) { pump(state, parent); return; }
      }
      for (const key of ['parentRunTicket','parentRetryTicket']) if (state[key]) { state[key].reject(parentBusy()); state[key] = null; }
      state.run = !!state.runTicket; state.retry = !!state.retryTicket;
      if (!closed && !state.removed && (state.run || state.retry)) pump(state);
    };
    state.running = (jobs && !parent ? jobs.run(run) : run()).finally(jobs && !parent ? jobs.bind(finish) : finish);
    // The explicit ticket carries the caller's failure. Observe the component's
    // separate drain promise too; flush still sees its original rejection.
    state.running.catch(() => {});
  }
  // Two work kinds, each with one owned and one borrowed slot: no parent
  // list and no unbounded deferred closures. Revisions/repeats use owned slots;
  // explicit wake/retry preserves a current same-tenant caller.
  function enqueue (tenant, kind, explicit = false) {
    const state = states.get(tenant);
    if (!state) return Promise.reject(new Error('Evaluator consumer tenant is not configured'));
    let parent; try { parent = explicit ? parentOf(tenant) : null; } catch (error) { return Promise.reject(error); }
    if (closed || !started) return Promise.resolve();
    const key = kind === 'run' ? (parent ? 'parentRunTicket' : 'runTicket') : (parent ? 'parentRetryTicket' : 'retryTicket');
    if (parent && (state.running && state.runningParent !== parent || state[key] && state[key].parent !== parent)) return Promise.reject(parentBusy());
    if (!state[key]) {
      const ticket = { parent }; ticket.promise = new Promise((resolve,reject) => { ticket.resolve = resolve; ticket.reject = reject; }); state[key] = ticket;
    }
    const ticket = state[key]; state[kind] = true; pump(state,parent); return ticket.promise;
  }
  function clearTickets (state) {
    for (const key of ['runTicket','retryTicket','parentRunTicket','parentRetryTicket']) { state[key]?.resolve(); state[key] = null; }
    state.run = false; state.retry = false;
  }
  const value = {
    addTenant (tenant) { if(!dynamic || closed || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tenant) || states.size>=maxTenants && !states.has(tenant))throw new Error('Dynamic consumer tenant refused');if(states.has(tenant))return;states.set(tenant,makeState(tenant));tenants.push(tenant); },
    async removeTenant (tenant) { if(!dynamic)throw new Error('Dynamic consumer tenant refused');const state=states.get(tenant);if(!state)return;state.removed=true;arm(state,null);clearTickets(state);activeSet.delete(tenant);notifier.cancelTenant(tenant);states.delete(tenant);const index=tenants.indexOf(tenant);if(index>=0)tenants.splice(index,1);await Promise.allSettled([state.running]); },
    start () {
      if (closed) throw new Error('Evaluator consumers are closed');
      if (started) return;
      started = true;
      if (discovery) {
        value.recover().catch(() => {});
        return;
      }
      timers.push(schedule(() => { sweep('run', 'run', [...activeSet]); }, limits.pollIntervalMs));
      // Both kinds select current output then retry the same durable intents.
      // Equal cadences need one active sweep, not two concurrent tickets.
      if (limits.retryIntervalMs !== limits.pollIntervalMs) timers.push(schedule(() => { sweep('retry', 'retry', [...activeSet]); }, limits.retryIntervalMs));
      sweep('start', 'run', tenants);
    },
    // Reconcile durable work after a lost wake or source recovery. The same
    // tenant gates and producer transactions govern every selected obligation.
    recover () {
      recoverAgain = true;
      if (!recovering) {
        const run = async () => {
          do {
            recoverAgain = false;
            if (discovery) {
              try { if (!closed) await discover(); }
              catch (error) { armDiscovery(cadence); throw error; }
            } else await sweep('recovery', 'run', [...tenants]);
          } while (recoverAgain && !closed);
        };
        recovering = Promise.resolve().then(() => jobs && discovery ? jobs.run(run) : run()).finally(() => { recovering = null; });
      }
      return recovering;
    },
    async invalidateTenant (tenant) {
      const state = states.get(tenant);
      if (!state || closed) throw new Error('Evaluator consumer tenant is not configured');
      // An already-dispatched transport attempt may settle after restore. Its
      // token still owns that durable request, never the new scheduler state.
      state.removed = true;
      const recovering = !!state.running || activeSet.has(tenant) || state.recoverOutbox;
      arm(state, null);
      clearTickets(state);
      if (state.running) {
        const old = state.running;
        retiredJobs.add(old);
        const finished = () => retiredJobs.delete(old);
        old.then(finished, finished);
      }
      const fresh = makeState(tenant);
      fresh.recoverOutbox = recovering;
      states.set(tenant, fresh);
      if (!discovery && recovering) activeSet.add(tenant);
    },
    // A fire-and-forget notification must own its delivery job. The transaction
    // that published the hint can close before notification selection starts.
    hint: tenant => enqueue(tenant, 'run'),
    wake: tenant => enqueue(tenant, 'run', true),
    // A content-change revision from the evaluator (its own timers included).
    // Only a tenant with a pending request, an armed repeat clock or a current
    // output that requests a notification is woken; quiet output needs no delivery.
    revised (tenant) {
      const state = states.get(tenant);
      if (!state || closed || !started) return;
      // A changed output that newly requests a notification is woken here; a
      // tenant with nothing to deliver needs no selection.
      if (state.state === 'pending' || state.repeatAt !== null || (peek(tenant)?.hasNotifications ?? armed(peek(tenant)))) { counters.revisedWakes++; enqueue(tenant, 'run').catch(() => {}); }
    },
    retry: tenant => enqueue(tenant, 'retry', true),
    async flush (tenant) {
      const state = states.get(tenant); if (!state) throw new Error('Evaluator consumer tenant is not configured');
      while (state.running) await state.running;
    },
    health (selected) {
      const rows = selected === undefined ? [...states.values()] : selected.map(tenant => {
        const state = states.get(tenant); if (!state) throw new Error('Evaluator consumer tenant is not configured'); return state;
      });
      return { enabled: true, closed, normalPolicy: 'realtime-cycle', route, maxConcurrentTenants, ...counters,
        ...(refusals ? { refusals: refusals.total, refusalCodes: refusals.counts() } : {}),
        tenants: rows.map(state => ({ tenant: state.tenant, clinicalEligible: !!peek(state.tenant)?.eligible,
          state: state.state, code: state.code, observedIntents: state.intents, observedAt: state.observedAt,
          lastHandoffAcceptedAt: state.lastHandoffAcceptedAt, passes: state.passes, selections: state.selections, repeatAt: state.repeatAt })) };
    },
    close () {
      if (closing) return closing;
      closed = true; timers.forEach(cancel); if (discoveryTimer) undelay(discoveryTimer); producer.close(); gate?.release();
      const stopped = notifier.close(); // abort owned adapter waits before draining jobs
      for (const state of states.values()) { clearTickets(state); arm(state, null); }
      closing = (async () => { await stopped; await Promise.allSettled([recovering, ...retiredJobs, ...[...states.values()].map(state => state.running)]); })().finally(() => jobs?.close());
      return closing;
    }
  };
  return Object.freeze(value);
}

async function prepare ({ config, current, peek, version, isCurrent, operationWindow, jobContext, activity, assertOperational, notificationRecovery, evaluatorBacklog }) {
  const selected = config.consumers?.realtime;
  if (!selected) return null; // default-off, no extra pool, timer, socket or SQL
  const owned = []; let coordinator, store, closing;
  async function close () {
    if (closing) return closing;
    closing = (async () => {
      const errors = [];
      try { if (coordinator) await coordinator.close(); } catch (error) { errors.push(error); }
      try { await store?.close(); } catch (error) { errors.push(error); }
      const ended = await Promise.allSettled(owned.map(connection => connection.end()));
      errors.push(...ended.filter(value => value.status === 'rejected').map(value => value.reason));
      // The configuration owner retains placement across partial construction.
      // This constructor closes only the connections and jobs it opens.
      if (errors.length) throw new globalThis.AggregateError(errors, 'Evaluator consumer connection shutdown refused');
    })();
    return closing;
  }
  try {
    const open = async settings => {
      const connection = await connect({ connectionString: settings.connectionString, max: settings.maxConnections,
        connectionTimeoutMillis: 5000, statement_timeout: 5000, application_name: 'nightscout-evaluator-consumer-preview', operationWindow });
      owned.push(connection); return connection;
    };
    // NS_OUTBOX_POOL sizes the outbox pool; unset keeps the configured size.
    const outboxConnection = await open({ ...selected.outbox, maxConnections: switches.outboxPool(selected.outbox.maxConnections) }), suppressionConnection = await open(selected.suppression);
    store = makeStore({ ...(config.pgstream && operationWindow?.trustedWorker === true && typeof assertOperational === 'function' ? {assertOperational} : {}),
      ...(operationWindow ? {currentGeneration: tenant => operationWindow.currentGeneration(tenant)} : {}),
      connection:outboxConnection,namespace:selected.outbox.namespace,maxRows:selected.outbox.maxRows,maxBytes:selected.outbox.maxBytes });
    const trustedAdmission = config.pgstream && operationWindow?.trustedWorker === true && typeof assertOperational === 'function';
    // Keep runtime operational authority on the actual tenant-scoped read.
    // Platform pre-start checked the configured suppression identity and table.
    const screened = trustedAdmission ? { ...suppressionConnection,
      readOnlyTransaction: fn => suppressionConnection.readOnlyTransaction(async () => {
        assertOperational(); return fn();
      }) } : suppressionConnection;
    const reader = makeReader({ connection: screened, namespace: selected.suppression.namespace,
      maxRows: selected.suppression.maxRows, maxBytes: selected.suppression.maxBytes });
    // Bounded, not one tenant after another (NS_TENANT_STARTUP_CONCURRENCY);
    // the first failure still refuses the boot, as before.
    const startup = require('./tenant-startup');
    const prepareTenant = async tenant => {
      return startup.attempt(operationWindow, tenant, async () => {
        await scope.withTenant(tenant, () => store.ready(tenant));
        await reader.read({ tenant, at: Date.now() });
      });
    };
    if (!notificationRecovery) {
      const tenants = [...config.tenants.keys()];
      const prepared = await startup.settleLimited(tenants, require('./pool-config').startupConcurrency(), prepareTenant);
      const refused = prepared.find(result => result.status === 'rejected');
      if (refused) throw refused.reason;
    }
    const {id: routeId, ...routeEndpoint} = selected.route;
    const realAdapter = require('../realtime/alarm-transport').createSliceAdapter({ peers: selected.slicePeers || {route: () => ({count: 1, ordinal: 0, endpoint: routeEndpoint})} });
    const discovery = notificationRecovery && { ...notificationRecovery, async deadlines (exclude, horizon) {
      assertOperational();
      const ns = '"' + selected.outbox.namespace + '"';
      const {count, ordinal} = config.processAssignment ?? {count:1, ordinal:0};
      const {rows} = await outboxConnection.readOnly('SELECT /* evaluator-notification-deadlines */ tenant_id::text AS tenant,deadline::text AS deadline FROM '+
        ns+'.tenant_notification_schedule($1,$2,$3,$4,$5) s ORDER BY s.deadline,s.tenant_id', [routeId, exclude, count, ordinal, horizon]);
      return rows.map(row => ({ tenant:row.tenant, at:Number(row.deadline) }));
    } };
    // The ACK witness needs every admitted ACK to mark the producer state:
    // the discovery catalogue's tenant_notification_mark_ack (ack-admission.js).
    const ackWitness = !!discovery && selected.expectedCatalogue === undefined;
    coordinator = coordinate({ tenants:[...config.tenants.keys()], discovery, ackWitness, dynamic: !!config.registry, maxTenants: config.maxTenants, operationWindow, jobContext, activity, current, ...(peek ? {peek} : {}), ...(version ? {version} : {}), currentConfig:config.readCurrent, isCurrent, store, reader,
      adapter: Object.freeze({ id: routeId, send: realAdapter.send }), route: routeId,
      maxRows: selected.outbox.maxRows, maxBytes: selected.outbox.maxBytes, maxPayloadBytes: selected.maxPayloadBytes, maxInflight: selected.maxInflight,
      attemptTimeoutMs: selected.attemptTimeoutMs, retryDelayMs: selected.retryDelayMs,
      pollIntervalMs: selected.pollIntervalMs, retryIntervalMs: selected.retryIntervalMs,
      ...(selected.maxConcurrentTenants !== undefined ? { maxConcurrentTenants: selected.maxConcurrentTenants } : {}),
      ...(switches.evaluationFirst() ? { evaluationFirst: true, evaluatorBacklog: evaluatorBacklog || (() => 0) } : {}) });
    return Object.freeze({ ...coordinator,
      prepareTenant, close });
  } catch (error) { await close(); throw error; }
}
module.exports = { prepare, coordinate, prereadSwitch, refusalCode, PREREAD_KEY };
