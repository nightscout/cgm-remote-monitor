'use strict';

const scope = require('../../storage/tenant-scope');
const connect = require('../../storage/postgres-connection');
const makeStore = require('../../tenant-notifications/postgres');
const makeNotifier = require('../../tenant-notifications/component');
const makeReader = require('../../tenant-alarms/postgres').createReader;
const makeProducer = require('../../tenant-notifications/producer');
const { armed } = require('../../tenant-notifications/producer-state');
// An overdue repeat time can never re-arm faster than this (no busy loop).
const REPEAT_WAKE_FLOOR_MS = 1000;
const { createAdapter } = require('../realtime/alarm-transport');
const readiness = require('./evaluator-consumer-readiness');

// The same coordinator is used by the selected role and source-protocol tests.
// Jobs are independent from clinical scheduling and serialized only per tenant.
//
// Work on change (decision cost-proportional-to-activity): a tenant's delivery
// runs when the evaluator revises its output (revised), at its alarm repeat time
// (arm) and on explicit wakes. The pollIntervalMs/retryIntervalMs loops visit
// only ACTIVE tenants, those with a pending or refused request or an armed
// repeat clock (an alarm already delivered), so an ack, snooze or retry is seen
// as promptly as before where it can matter. A newly alarming tenant is found by
// the revision wake (the primary path) or, failing that, the backstop. Every tenant is
// visited by the slow backstop (backstopIntervalMs, default 60000). Every pass
// works at most maxConcurrentTenants tenants at once (default 4).
function coordinate ({ tenants, route, current, currentConfig, isCurrent, store, reader, adapter, operationWindow, jobContext, activity, pool, schedule = setInterval,
  cancel = clearInterval, delay = (fn, ms) => setTimeout(fn, ms), undelay = timer => clearTimeout(timer), now = Date.now, recoveryPageSize, dynamic = false, maxTenants = 10000, ...limits }) {
  if (!Array.isArray(tenants) || (!dynamic && !tenants.length) || new Set(tenants).size !== tenants.length ||
      [current, currentConfig, isCurrent, schedule, cancel, delay, undelay, now].some(fn => typeof fn !== 'function') ||
      [limits.pollIntervalMs, limits.retryIntervalMs].some(n => !Number.isSafeInteger(n) || n < 1 || n > 2147483647)) {
    throw new TypeError('Explicit evaluator consumer tenants/current output/schedules required');
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
  if (pool !== undefined && [pool?.admits, pool?.reason].some(fn => typeof fn !== 'function')) throw new TypeError('Consumer pool gate required');
  const producer = makeProducer({store, reader, current, currentConfig, isCurrent, consumer: adapter.id, now,
    maxRows: limits.maxRows, maxBytes: limits.maxBytes, maxPayloadBytes: limits.maxPayloadBytes});
  // Load telemetry: every producer selection is one or more SQL transactions.
  const select = tenant => { const state = states.get(tenant); if (state) state.selections++; return producer.select(tenant); };
  const notifier = makeNotifier({ store, adapter, selectCycle: select, isCurrent, requireIntentOrigin: true,
    mayAttempt: async ({tenant, notification}) => notification.clear === true || current(tenant)?.eligible === true,
    allows: request => reader.allows(request), now, normalPolicy: 'realtime-cycle',
    maxRows: limits.maxRows, maxPayloadBytes: limits.maxPayloadBytes, maxInflight: limits.maxInflight,
    attemptTimeoutMs: limits.attemptTimeoutMs, retryDelayMs: limits.retryDelayMs });
  tenants = [...tenants];
  const makeState = tenant => ({ tenant, run: false, retry: false, running: null, runningParent: null, runTicket: null, retryTicket: null, parentRunTicket: null, parentRetryTicket: null,
    state: 'starting', code: null, intents: [], observedAt: null, lastHandoffAcceptedAt: null, passes: 0, selections: 0, repeatAt: null, repeatTimer: null });
  const states = new Map(tenants.map(tenant => [tenant,makeState(tenant)]));
  const activeSet = new Set();
  if (recoveryPageSize !== undefined && (!Number.isSafeInteger(recoveryPageSize) || recoveryPageSize < 1 || recoveryPageSize > 1024)) throw new TypeError('Bounded consumer recovery page required');
  let recoveryCursor = 0;
  const recoveryPage = () => recoveryPageSize === undefined ? tenants : Array.from({ length: Math.min(recoveryPageSize,tenants.length) },() => { const tenant = tenants[recoveryCursor]; recoveryCursor = (recoveryCursor+1)%tenants.length; return tenant; });
  const timers = []; let started = false, closed = false, closing;
  const backstopIntervalMs = limits.backstopIntervalMs ?? 60000, maxConcurrentTenants = limits.maxConcurrentTenants ?? 4;
  if ([backstopIntervalMs, maxConcurrentTenants].some(n => !Number.isSafeInteger(n) || n < 1 || n > 2147483647)) {
    throw new TypeError('Explicit evaluator consumer backstop interval and concurrency required');
  }
  const sweeping = new Set(), counters = { sweeps: 0, revisedWakes: 0 };
  // One pass of `kind` over `list`, bounded; a pass of the same name still
  // running makes the next one a no-op (its tenants are already coalescing).
  async function sweep (name, kind, list) {
    if (sweeping.has(name) || closed || !started) return;
    sweeping.add(name); counters.sweeps++;
    try {
      let next = 0;
      const worker = async () => { while (next < list.length && !closed) await enqueue(list[next++], kind).catch(() => {}); };
      await Promise.all(Array.from({ length: Math.min(maxConcurrentTenants, list.length) }, worker));
    } finally { sweeping.delete(name); }
  }
  function active (tenant) {
    const state = states.get(tenant);
    return !!state && (state.state === 'pending' || state.state === 'refused' || state.repeatAt !== null);
  }
  // One-shot wake at the producer's alarm repeat time, for a tenant whose
  // current output requests a notification; cleared when it no longer does.
  function arm (state, repeatAt) {
    if (state.repeatTimer) { undelay(state.repeatTimer); state.repeatTimer = null; }
    state.repeatAt = Number.isSafeInteger(repeatAt) ? repeatAt : null;
    if (state.repeatAt === null || closed || state.removed) return;
    state.repeatTimer = delay(() => { state.repeatTimer = null; enqueue(state.tenant, 'run').catch(() => {}); },
      Math.min(2147483647, Math.max(REPEAT_WAKE_FLOOR_MS, state.repeatAt - now())));
    state.repeatTimer?.unref?.();
  }
  const parentBusy = () => Object.assign(new Error('EVALUATOR_JOB_PARENT_BUSY'), { code: 'EVALUATOR_JOB_PARENT_BUSY' });
  const parentOf = tenant => operationWindow ? require('../../tenant-lifecycle/operation-window').schedulingParent(operationWindow, tenant) : null;
  async function drain (state, parent) {
    while (!closed && !state.removed) {
      const runKey = parent ? 'parentRunTicket' : 'runTicket', retryKey = parent ? 'parentRetryTicket' : 'retryTicket';
      const key = state[runKey] ? runKey : state[retryKey] ? retryKey : null;
      if (!key) return;
      const ticket = state[key]; state[key] = null;
      state.run = !!(state.runTicket || state.parentRunTicket); state.retry = !!(state.retryTicket || state.parentRetryTicket);
      try {
        // Pool membership: a tenant outside this member's slice (or every tenant
        // while membership is refused) gets no selection, attempt, retry or
        // repeat wake here; another member owns its delivery.
        if (pool && !pool.admits(state.tenant)) {
          arm(state, null); activeSet.delete(state.tenant);
          state.state = 'inactive'; state.code = 'EVALUATOR_CONSUMER_' + (pool.reason() || 'POOL_NOT_IN_SLICE'); state.observedAt = now();
          continue;
        }
        if (activity) {
          // Paused/suspended tenants deliver nothing, including retries and clears.
          const checked = await activity.check('notification', state.tenant);
          if (closed || state.removed) return;
          if (!checked.eligible) { arm(state,null); activeSet.delete(state.tenant); state.state = 'inactive'; state.code = 'EVALUATOR_CONSUMER_' + checked.code; state.observedAt = now(); continue; }
        }
        state.passes++;
        try {
          const observe = async () => {
          const selected = await select(state.tenant);
          if (closed || state.removed) return;
          arm(state, selected?.repeatAt);
          const observed = await notifier.retry(state.tenant);
          if (closed || state.removed) return;
          state.observedAt = now(); state.intents = observed.results || [];
          const pending = state.intents.some(row => !['accepted', 'cancelled'].includes(row.state));
          const accepted = state.intents.some(row => row.state === 'accepted');
          state.state = pending ? 'pending' : accepted ? 'handoff-accepted' : 'idle';
          state.code = pending ? 'EVALUATOR_CONSUMER_HANDOFF_PENDING' : null;
          if (accepted) state.lastHandoffAcceptedAt = state.observedAt;
          };
          if (operationWindow) await operationWindow.run(state.tenant, observe);
          else await observe();
        } catch {
          if (closed || state.removed) return;
          state.state = 'refused'; state.code = 'EVALUATOR_CONSUMER_REFUSED'; state.intents = [];
          state.observedAt = now();
        }
        if (state.removed) return;
        if (active(state.tenant)) activeSet.add(state.tenant); else activeSet.delete(state.tenant);
      } finally { ticket.resolve(); }
    }
  }
  function pump (state, parent = null) {
    if (state.running) return;
    state.runningParent = parent;
    const run = () => drain(state,parent);
    const finish = () => {
      state.running = null; state.runningParent = null;
      for (const key of ['parentRunTicket','parentRetryTicket']) if (state[key]) { state[key].reject(parentBusy()); state[key] = null; }
      state.run = !!state.runTicket; state.retry = !!state.retryTicket;
      if (!closed && !state.removed && (state.run || state.retry)) pump(state);
    };
    state.running = (jobs && !parent ? jobs.run(run) : run()).finally(jobs ? jobs.bind(finish) : finish);
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
    async removeTenant (tenant) { if(!dynamic)throw new Error('Dynamic consumer tenant refused');const state=states.get(tenant);if(!state)return;state.removed=true;arm(state,null);clearTickets(state);activeSet.delete(tenant);notifier.cancelTenant(tenant);states.delete(tenant);const index=tenants.indexOf(tenant);if(index>=0)tenants.splice(index,1);recoveryCursor=tenants.length?recoveryCursor%tenants.length:0;await Promise.allSettled([state.running]); },
    start () {
      if (closed) throw new Error('Evaluator consumers are closed');
      if (started) return;
      started = true;
      timers.push(schedule(() => { sweep('run', 'run', recoveryPageSize === undefined ? tenants.filter(active) : [...activeSet]); }, limits.pollIntervalMs));
      timers.push(schedule(() => { sweep('retry', 'retry', recoveryPageSize === undefined ? tenants.filter(active) : [...activeSet]); }, limits.retryIntervalMs));
      timers.push(schedule(() => { sweep('backstop', 'run', recoveryPage()); }, backstopIntervalMs));
      sweep('start', 'run', tenants);
    },
    async invalidateTenant (tenant) {
      const state = states.get(tenant);
      if (!state || closed) throw new Error('Evaluator consumer tenant is not configured');
      while (state.running) await state.running;
      arm(state, null);
      clearTickets(state); state.intents = [];
      state.state = 'starting'; state.code = null; state.observedAt = null; state.lastHandoffAcceptedAt = null;
    },
    wake: tenant => enqueue(tenant, 'run', true),
    // A content-change revision from the evaluator (its own timers included).
    // Only a tenant with a pending request, an armed repeat clock or a current
    // output that requests a notification is woken; others wait for the poll.
    revised (tenant) {
      const state = states.get(tenant);
      if (!state || closed || !started) return;
      // A changed output that newly requests a notification is woken here; a
      // tenant with nothing to deliver is left to the backstop.
      if (state.state === 'pending' || state.repeatAt !== null || armed(current(tenant))) { counters.revisedWakes++; enqueue(tenant, 'run').catch(() => {}); }
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
      return { enabled: true, closed, normalPolicy: 'realtime-cycle', route, backstopIntervalMs, maxConcurrentTenants, ...counters,
        tenants: rows.map(state => ({ tenant: state.tenant, clinicalEligible: !!current(state.tenant)?.eligible,
          state: state.state, code: state.code, observedIntents: state.intents, observedAt: state.observedAt,
          lastHandoffAcceptedAt: state.lastHandoffAcceptedAt, passes: state.passes, selections: state.selections, repeatAt: state.repeatAt })) };
    },
    close () {
      if (closing) return closing;
      closed = true; timers.forEach(cancel); producer.close();
      const stopped = notifier.close(); // abort owned adapter waits before draining jobs
      for (const state of states.values()) { clearTickets(state); arm(state, null); }
      closing = (async () => { await stopped; await Promise.allSettled([...states.values()].map(state => state.running)); })().finally(() => jobs?.close());
      return closing;
    }
  };
  return Object.freeze(value);
}

async function prepare ({ config, clinicalConnection, current, isCurrent, operationWindow, jobContext, activity, pool }) {
  const selected = config.consumers?.realtime;
  if (!selected) return null; // default-off, no extra pool, timer, socket or SQL
  const owned = []; let coordinator, closing;
  async function close () {
    if (closing) return closing;
    closing = (async () => {
      const errors = [];
      try { if (coordinator) await coordinator.close(); } catch (error) { errors.push(error); }
      const ended = await Promise.allSettled(owned.map(connection => connection.end()));
      errors.push(...ended.filter(value => value.status === 'rejected').map(value => value.reason));
      try { selected.placement?.close(); } catch (error) { errors.push(error); }
      if (errors.length) throw new globalThis.AggregateError(errors, 'Evaluator consumer connection shutdown refused');
    })();
    return closing;
  }
  try {
    const open = async settings => {
      const connection = await connect({ connectionString: settings.connectionString, max: settings.maxConnections,
        connectionTimeoutMillis: 5000, statement_timeout: 5000, application_name: 'nightscout-evaluator-consumer-preview' });
      owned.push(connection); return connection;
    };
    const outboxConnection = await open(selected.outbox), suppressionConnection = await open(selected.suppression);
    const tenants = [...config.tenants.keys()];
    const metadataTenant = '00000000-0000-0000-0000-000000000000';
    // These unconditional read-only catalogue/ACL checks are independent of
    // tenant phase, including when every configured tenant is suspended.
    await scope.withTenant(metadataTenant, () => outboxConnection.transaction(() =>
      require('../../tenant-notifications/readiness')(outboxConnection, selected.outbox.namespace)));
    await scope.withTenant(metadataTenant, () => suppressionConnection.snapshotTransaction(() =>
      readiness.suppression(suppressionConnection, selected.suppression.namespace, {operationWindow})));
    await readiness.sameDatastore(clinicalConnection, [outboxConnection, suppressionConnection], metadataTenant);
    const store = makeStore({ connection: outboxConnection, namespace: selected.outbox.namespace,
      maxRows: selected.outbox.maxRows, maxBytes: selected.outbox.maxBytes });
    // The stronger role/schema/ledger guard is consumed by EVERY actual reader
    // snapshot, not merely checked on a separate connection at startup.
    // The guard runs the full check whenever the catalogue epoch read in this
    // snapshot is not one it admitted (decision admission-epoch-everywhere).
    const guard = readiness.suppressionGuard(suppressionConnection, selected.suppression.namespace, {operationWindow});
    const screened = { ...suppressionConnection,
      snapshotTransaction: fn => suppressionConnection.snapshotTransaction(async () => {
        await guard(); return fn();
      }) };
    const reader = makeReader({ connection: screened, namespace: selected.suppression.namespace,
      maxRows: selected.suppression.maxRows, maxBytes: selected.suppression.maxBytes });
    // Bounded, not one tenant after another (NS_TENANT_STARTUP_CONCURRENCY);
    // the first failure still refuses the boot, as before.
    const startup = require('./tenant-startup');
    const prepared = await startup.settleLimited(tenants, require('./pool-config').startupConcurrency(), tenant =>
      startup.attempt(operationWindow, tenant, async () => {
        await scope.withTenant(tenant, () => store.ready(tenant));
        await reader.read({ tenant, at: Date.now() });
      }));
    const refused = prepared.find(result => result.status === 'rejected');
    if (refused) throw refused.reason;
    const {id: routeId, ...routeEndpoint} = selected.route;
    const realAdapter = selected.placement ? require('../realtime/alarm-transport').createPlacementAdapter({ placement: selected.placement }) : createAdapter(routeEndpoint);
    coordinator = coordinate({ tenants, dynamic: !!config.registry, maxTenants: config.maxTenants, ...(config.changeFeed ? { recoveryPageSize: config.changeFeed.pageSize } : {}), operationWindow, jobContext, activity, pool, current, currentConfig:config.readCurrent, isCurrent, store, reader,
      adapter: Object.freeze({ id: routeId, send: realAdapter.send }), route: routeId,
      maxRows: selected.outbox.maxRows, maxBytes: selected.outbox.maxBytes, maxPayloadBytes: selected.maxPayloadBytes, maxInflight: selected.maxInflight,
      attemptTimeoutMs: selected.attemptTimeoutMs, retryDelayMs: selected.retryDelayMs,
      pollIntervalMs: selected.pollIntervalMs, retryIntervalMs: selected.retryIntervalMs,
      ...(selected.backstopIntervalMs !== undefined ? { backstopIntervalMs: selected.backstopIntervalMs } : {}),
      ...(selected.maxConcurrentTenants !== undefined ? { maxConcurrentTenants: selected.maxConcurrentTenants } : {}) });
    return Object.freeze({ ...coordinator,
      prepareTenant: tenant => startup.attempt(operationWindow,tenant,async()=>{await scope.withTenant(tenant,()=>store.ready(tenant));await reader.read({tenant,at:Date.now()});}), close });
  } catch (error) { await close(); throw error; }
}
module.exports = { prepare, coordinate };
