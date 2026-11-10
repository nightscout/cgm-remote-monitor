'use strict';

const scope = require('../../storage/tenant-scope');
const connect = require('../../storage/postgres-connection');
const makeStore = require('../../tenant-notifications/postgres');
const makeNotifier = require('../../tenant-notifications/component');
const makeReader = require('../../tenant-alarms/postgres').createReader;
const makeProducer = require('../../tenant-notifications/producer');
const { createAdapter } = require('../realtime/alarm-transport');
const readiness = require('./evaluator-consumer-readiness');

// The same coordinator is used by the selected role and source-protocol tests.
// Jobs are independent from clinical scheduling and serialized only per tenant.
function coordinate ({ tenants, route, current, currentConfig, isCurrent, store, reader, adapter, operationWindow, schedule = setInterval,
  cancel = clearInterval, now = Date.now, ...limits }) {
  if (!Array.isArray(tenants) || !tenants.length || new Set(tenants).size !== tenants.length ||
      [current, currentConfig, isCurrent, schedule, cancel, now].some(fn => typeof fn !== 'function') ||
      [limits.pollIntervalMs, limits.retryIntervalMs].some(n => !Number.isSafeInteger(n) || n < 1 || n > 2147483647)) {
    throw new TypeError('Explicit evaluator consumer tenants/current output/schedules required');
  }
  if (operationWindow !== undefined && typeof operationWindow.run !== 'function') throw new TypeError('Consumer operation window required');
  const producer = makeProducer({store, reader, current, currentConfig, isCurrent, consumer: adapter.id, now,
    maxRows: limits.maxRows, maxBytes: limits.maxBytes, maxPayloadBytes: limits.maxPayloadBytes});
  const notifier = makeNotifier({ store, adapter, selectCycle: tenant => producer.select(tenant), isCurrent, requireIntentOrigin: true,
    mayAttempt: async ({tenant, notification}) => notification.clear === true || current(tenant)?.eligible === true,
    allows: request => reader.allows(request), now, normalPolicy: 'realtime-cycle',
    maxRows: limits.maxRows, maxPayloadBytes: limits.maxPayloadBytes, maxInflight: limits.maxInflight,
    attemptTimeoutMs: limits.attemptTimeoutMs, retryDelayMs: limits.retryDelayMs });
  const states = new Map(tenants.map(tenant => [tenant, { tenant, run: false, retry: false, running: null,
    state: 'starting', code: null, intents: [], observedAt: null, lastHandoffAcceptedAt: null }]));
  const timers = []; let started = false, closed = false, closing;
  async function drain (state) {
    while (!closed && (state.run || state.retry)) {
      const admission = state.run; if (admission) state.run = false; else state.retry = false;
      try {
        const observe = async () => {
        await producer.select(state.tenant);
        const observed = await notifier.retry(state.tenant);
        if (closed) return;
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
        if (closed) return;
        state.state = 'refused'; state.code = 'EVALUATOR_CONSUMER_REFUSED'; state.intents = [];
        state.observedAt = now();
      }
    }
  }
  function enqueue (tenant, kind) {
    const state = states.get(tenant);
    if (!state) return Promise.reject(new Error('Evaluator consumer tenant is not configured'));
    if (closed || !started) return Promise.resolve();
    state[kind] = true;
    if (!state.running) {
      state.running = drain(state).finally(() => {
        state.running = null;
        if (!closed && (state.run || state.retry)) enqueue(tenant, state.run ? 'run' : 'retry').catch(() => {});
      });
    }
    return state.running;
  }
  const value = {
    start () {
      if (closed) throw new Error('Evaluator consumers are closed');
      if (started) return;
      started = true;
      timers.push(schedule(() => { for (const tenant of tenants) enqueue(tenant, 'run').catch(() => {}); }, limits.pollIntervalMs));
      timers.push(schedule(() => { for (const tenant of tenants) enqueue(tenant, 'retry').catch(() => {}); }, limits.retryIntervalMs));
      for (const tenant of tenants) enqueue(tenant, 'run').catch(() => {});
    },
    async invalidateTenant (tenant) {
      const state = states.get(tenant);
      if (!state || closed) throw new Error('Evaluator consumer tenant is not configured');
      while (state.running) await state.running;
      state.run = false; state.retry = false; state.intents = [];
      state.state = 'starting'; state.code = null; state.observedAt = null; state.lastHandoffAcceptedAt = null;
    },
    wake: tenant => enqueue(tenant, 'run'),
    retry: tenant => enqueue(tenant, 'retry'),
    async flush (tenant) {
      const state = states.get(tenant); if (!state) throw new Error('Evaluator consumer tenant is not configured');
      while (state.running) await state.running;
    },
    health () {
      return { enabled: true, closed, normalPolicy: 'realtime-cycle', route,
        tenants: [...states.values()].map(state => ({ tenant: state.tenant, clinicalEligible: !!current(state.tenant)?.eligible,
          state: state.state, code: state.code, observedIntents: state.intents, observedAt: state.observedAt,
          lastHandoffAcceptedAt: state.lastHandoffAcceptedAt })) };
    },
    close () {
      if (closing) return closing;
      closed = true; timers.forEach(cancel); producer.close();
      const stopped = notifier.close(); // abort owned adapter waits before draining jobs
      for (const state of states.values()) { state.run = false; state.retry = false; }
      closing = (async () => { await stopped; await Promise.allSettled([...states.values()].map(state => state.running)); })();
      return closing;
    }
  };
  return Object.freeze(value);
}

async function prepare ({ config, clinicalConnection, current, isCurrent, operationWindow }) {
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
    const screened = { ...suppressionConnection,
      snapshotTransaction: fn => suppressionConnection.snapshotTransaction(async () => {
        await readiness.suppression(suppressionConnection, selected.suppression.namespace, {operationWindow}); return fn();
      }) };
    const reader = makeReader({ connection: screened, namespace: selected.suppression.namespace,
      maxRows: selected.suppression.maxRows, maxBytes: selected.suppression.maxBytes });
    for (const tenant of tenants) {
      await require('./tenant-startup').attempt(operationWindow, tenant, async () => {
        await scope.withTenant(tenant, () => store.ready(tenant));
        await reader.read({ tenant, at: Date.now() });
      });
    }
    const {id: routeId, ...routeEndpoint} = selected.route;
    const realAdapter = createAdapter(routeEndpoint);
    coordinator = coordinate({ tenants, operationWindow, current, currentConfig:config.readCurrent, isCurrent, store, reader,
      adapter: Object.freeze({ id: routeId, send: realAdapter.send }), route: routeId,
      maxRows: selected.outbox.maxRows, maxBytes: selected.outbox.maxBytes, maxPayloadBytes: selected.maxPayloadBytes, maxInflight: selected.maxInflight,
      attemptTimeoutMs: selected.attemptTimeoutMs, retryDelayMs: selected.retryDelayMs,
      pollIntervalMs: selected.pollIntervalMs, retryIntervalMs: selected.retryIntervalMs });
    return Object.freeze({ ...coordinator, close });
  } catch (error) { await close(); throw error; }
}
module.exports = { prepare, coordinate };
