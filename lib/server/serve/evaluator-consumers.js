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
// Delivery follows output revisions, explicit lifecycle wakes and repeat deadlines.
// Only pending/refused/repeating tenants use the active retry cadence. Startup
// and transport recovery reconcile persisted producer/intents with bounded
// tenant transactions; quiet tenants have no discovery timer.
function coordinate ({ tenants, route, current, currentConfig, isCurrent, store, reader, adapter, operationWindow, jobContext, activity, pool, schedule = setInterval,
  cancel = clearInterval, delay = (fn, ms) => setTimeout(fn, ms), undelay = timer => clearTimeout(timer), now = Date.now, dynamic = false, maxTenants = 10000, ...limits }) {
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
    ...(typeof store.beforeSend === 'function' ? {beforeSend:tenant=>store.beforeSend(tenant)} : {}),
    mayAttempt: async ({tenant, notification}) => notification.clear === true || current(tenant)?.eligible === true,
    allows: request => reader.allows(request), now, normalPolicy: 'realtime-cycle',
    maxRows: limits.maxRows, maxPayloadBytes: limits.maxPayloadBytes, maxInflight: limits.maxInflight,
    attemptTimeoutMs: limits.attemptTimeoutMs, retryDelayMs: limits.retryDelayMs });
  tenants = [...tenants];
  const makeState = tenant => ({ tenant, run: false, retry: false, running: null, runningParent: null, runTicket: null, retryTicket: null, parentRunTicket: null, parentRetryTicket: null,
    state: 'starting', code: null, intents: [], observedAt: null, lastHandoffAcceptedAt: null, passes: 0, selections: 0, repeatAt: null, repeatTimer: null });
  const states = new Map(tenants.map(tenant => [tenant,makeState(tenant)]));
  const activeSet = new Set();
  const timers = []; let started = false, closed = false, closing, recovering, recoverAgain = false;
  const maxConcurrentTenants = limits.maxConcurrentTenants ?? 4;
  if (!Number.isSafeInteger(maxConcurrentTenants) || maxConcurrentTenants < 1 || maxConcurrentTenants > 2147483647) {
    throw new TypeError('Explicit evaluator consumer concurrency required');
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
      timers.push(schedule(() => { sweep('run', 'run', [...activeSet]); }, limits.pollIntervalMs));
      // Both kinds select current output then retry the same durable intents.
      // Equal cadences need one active sweep, not two concurrent tickets.
      if (limits.retryIntervalMs !== limits.pollIntervalMs) timers.push(schedule(() => { sweep('retry', 'retry', [...activeSet]); }, limits.retryIntervalMs));
      sweep('start', 'run', tenants);
    },
    // Re-read persisted producer state and due intents after an explicit feed
    // recovery, even when an ephemeral output wake was lost. No RAM active-set
    // membership is required; each store transaction retains tenant bounds.
    recover () {
      recoverAgain = true;
      if (!recovering) recovering = (async () => {
        do {
          recoverAgain = false;
          await sweep('recovery', 'run', [...tenants]);
        } while (recoverAgain && !closed);
      })().finally(() => { recovering = null; });
      return recovering;
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
    // output that requests a notification is woken; quiet output needs no delivery.
    revised (tenant) {
      const state = states.get(tenant);
      if (!state || closed || !started) return;
      // A changed output that newly requests a notification is woken here; a
      // tenant with nothing to deliver needs no selection.
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
      return { enabled: true, closed, normalPolicy: 'realtime-cycle', route, maxConcurrentTenants, ...counters,
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

async function prepare ({ config, clinicalConnection, current, isCurrent, operationWindow, jobContext, activity, pool, coldAdmission, assertOperational, partition, onUnavailable }) {
  const selected = config.consumers?.realtime;
  if (!selected) return null; // default-off, no extra pool, timer, socket or SQL
  if (partition !== undefined && typeof onUnavailable !== 'function') throw new TypeError('Partitioned notification role failure hook required');
  // A selected route must be the exact SQL-fenced durable consumer, before any pool opens.
  if (partition !== undefined && partition?.consumer !== selected.route.id) throw new Error('NOTIFICATION_PARTITION_ROUTE_MISMATCH');
  const metadata = selected.partitionMetadata;
  if (partition !== undefined && metadata === undefined) throw new Error('NOTIFICATION_PARTITION_METADATA_REQUIRED');
  if (metadata !== undefined && partition === undefined) throw new Error('NOTIFICATION_PARTITION_RUNTIME_REQUIRED');
  if (metadata !== undefined) {
    const binding = { ...metadata, consumer: selected.route.id, evaluatorConsumer: config.consumer + '-completed' };
    const expected = require('../../tenant-notifications/partition-candidate').build(binding).catalogue;
    if (JSON.stringify(selected.expectedCatalogue) !== JSON.stringify(expected) ||
        Object.entries(binding).some(([key, value]) => partition[key] !== value)) throw new Error('NOTIFICATION_PARTITION_METADATA_MISMATCH');
  }
  const owned = [], coldPending = new Map(); let coordinator, store, closing;
  async function close () {
    if (closing) return closing;
    closing = (async () => {
      const errors = [];
      try { if (coordinator) await coordinator.close(); } catch (error) { errors.push(error); }
      if (coldAdmission) {
        for (const row of coldPending.values()) coldAdmission.cancel(row.key);
        const drained = await Promise.allSettled([...coldPending.values()].map(row => row.promise));
        // Cancellation is expected; genuine admitted initialization failures remain failures.
        errors.push(...drained.filter(row => row.status === 'rejected' && !['COLD_START_CANCELLED','COLD_START_CLOSED'].includes(row.reason?.code)).map(row => row.reason));
      }
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
    const open = async (settings, admitBackend) => {
      const connection = await connect({ connectionString: settings.connectionString, max: settings.maxConnections,
        connectionTimeoutMillis: 5000, statement_timeout: 5000, application_name: 'nightscout-evaluator-consumer-preview', operationWindow, admitBackend });
      owned.push(connection); return connection;
    };
    const outboxConnection = await open(selected.outbox, client =>
      require('../../tenant-notifications/readiness')(client, selected.outbox.namespace, {expectedCatalogue:selected.expectedCatalogue})), suppressionConnection = await open(selected.suppression, client =>
      readiness.suppression(client, selected.suppression.namespace, {operationWindow}));
    store = makeStore({ ...(config.pgstream && operationWindow?.trustedWorker === true && typeof assertOperational === 'function' ? {assertOperational} : {}),
      connection:outboxConnection,namespace:selected.outbox.namespace,maxRows:selected.outbox.maxRows,maxBytes:selected.outbox.maxBytes,partition });
    const tenants = [...config.tenants.keys()];
    const metadataTenant = '00000000-0000-0000-0000-000000000000';
    // Both physical-backend screens above run before any tenant admission,
    // including when the entire roster is suspended.
    await readiness.sameDatastore(clinicalConnection, [outboxConnection, suppressionConnection], metadataTenant);
    await store.own(() => {
      // Abort owned waits immediately. Lifecycle shutdown drains entered work.
      coordinator?.close().catch(()=>{});
      onUnavailable?.(Object.assign(new Error('NOTIFICATION_PARTITION_OWNER_LOST'),{code:'NOTIFICATION_PARTITION_OWNER_LOST'}));
    });
    const trustedAdmission = config.pgstream && operationWindow?.trustedWorker === true && typeof assertOperational === 'function';
    // Explicit startup, schema and transport recovery verify selected catalogues.
    // New physical backends are screened by their admission callbacks above.
    // This adapter cannot execute tenant work and never leaves this owner.
    const verifyOperational = () => readiness.operational(
      {connection:outboxConnection,namespace:selected.outbox.namespace,expectedCatalogue:store.expectedCatalogue},
      {connection:suppressionConnection,namespace:selected.suppression.namespace},operationWindow);
    // Every physical suppression backend is screened before its first transaction.
    // Reads retain actual suppression rows/RLS; trusted output also requires its
    // joined operational authority. No catalogue proof runs in alarm snapshots.
    const screened = trustedAdmission ? { ...suppressionConnection,
      snapshotTransaction: fn => suppressionConnection.snapshotTransaction(async () => {
        assertOperational(); return fn();
      }) } : suppressionConnection;
    const reader = makeReader({ connection: screened, namespace: selected.suppression.namespace,
      maxRows: selected.suppression.maxRows, maxBytes: selected.suppression.maxBytes });
    // Bounded, not one tenant after another (NS_TENANT_STARTUP_CONCURRENCY);
    // the first failure still refuses the boot, as before.
    const startup = require('./tenant-startup');
    const prepareTenant = async tenant => {
      // Keep the complete roster. A known foreign slice does no tenant SQL;
      // unknown or invalid assignment metadata refuses rather than being skipped.
      if (store.ownsTenant && !store.ownsTenant(tenant)) return false;
      const execute = () => startup.attempt(operationWindow, tenant, async () => {
        await scope.withTenant(tenant, () => store.ready(tenant));
        await reader.read({ tenant, at: Date.now() });
      });
      if (!coldAdmission) return execute();
      if (closing) return Promise.reject(Object.assign(new Error('COLD_START_CLOSED'), {code:'COLD_START_CLOSED'}));
      if (coldPending.has(tenant)) return coldPending.get(tenant).promise;
      const row = {key:{}};
      row.promise = coldAdmission.run(row.key, execute).finally(() => { if (coldPending.get(tenant) === row) coldPending.delete(tenant); });
      coldPending.set(tenant,row); return row.promise;
    };
    const prepared = await startup.settleLimited(tenants, require('./pool-config').startupConcurrency(), prepareTenant);
    const refused = prepared.find(result => result.status === 'rejected');
    if (refused) throw refused.reason;
    const {id: routeId, ...routeEndpoint} = selected.route;
    const realAdapter = selected.placement ? require('../realtime/alarm-transport').createPlacementAdapter({ placement: selected.placement }) : createAdapter(routeEndpoint);
    coordinator = coordinate({ tenants, dynamic: !!config.registry, maxTenants: config.maxTenants, operationWindow, jobContext, activity, pool, current, currentConfig:config.readCurrent, isCurrent, store, reader,
      adapter: Object.freeze({ id: routeId, send: realAdapter.send }), route: routeId,
      maxRows: selected.outbox.maxRows, maxBytes: selected.outbox.maxBytes, maxPayloadBytes: selected.maxPayloadBytes, maxInflight: selected.maxInflight,
      attemptTimeoutMs: selected.attemptTimeoutMs, retryDelayMs: selected.retryDelayMs,
      pollIntervalMs: selected.pollIntervalMs, retryIntervalMs: selected.retryIntervalMs,
      ...(selected.maxConcurrentTenants !== undefined ? { maxConcurrentTenants: selected.maxConcurrentTenants } : {}) });
    return Object.freeze({ ...coordinator,
      prepareTenant, ...(trustedAdmission ? {verifyOperational} : {}), close });
  } catch (error) { await close(); throw error; }
}
module.exports = { prepare, coordinate };
