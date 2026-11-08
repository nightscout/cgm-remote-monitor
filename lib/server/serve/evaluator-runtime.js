'use strict';
const { randomUUID } = require('node:crypto');

// One explicit preview process owns its local jobs. No lease, provider, feed
// transport, notification handoff or durable evaluated-output revision is implied.
module.exports = async function evaluatorRuntime ({ tenants, readCurrent, create,
  recoveryIntervalMs, timeIntervalMs, operationWindow, schedule = setInterval, cancel = clearInterval, now = Date.now }) {
  if (!Array.isArray(tenants) || !tenants.length || new Set(tenants).size !== tenants.length ||
      tenants.some(id => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) ||
      [readCurrent, create, schedule, cancel, now].some(fn => typeof fn !== 'function') ||
      [recoveryIntervalMs, timeIntervalMs].some(n => !Number.isSafeInteger(n) || n < 1 || n > 2147483647)) {
    throw new TypeError('Explicit evaluator tenants, current config, component and schedule required');
  }
  if (operationWindow !== undefined && [operationWindow.run, operationWindow.current].some(fn => typeof fn !== 'function')) throw new TypeError('Evaluator operation window required');
  const states = new Map(tenants.map(tenant => [tenant, { tenant, instance: null, identity: null, sourceIdentity: null,
    last: null, revision: 0, generation: 0, acquired: false, code: 'EVALUATOR_STARTING', pendingAcquire: false, pendingTime: false, acquireTicket: null, timeTicket: null, lastKind: null, running: null }]));
  let closed = false, closing;
  const runtimeId = randomUUID();
  const timers = [], cleanupErrors = [];
  function closeComponent (instance) { try { instance.close(); } catch (error) { cleanupErrors.push(error); } }
  function discard (state) {
    state.generation++;
    const previous = state.instance;
    state.instance = null; state.identity = null; state.sourceIdentity = null; state.last = null; state.acquired = false;
    if (previous) closeComponent(previous);
  }
  async function drain (state) {
    while (!closed && (state.pendingAcquire || state.pendingTime)) {
      const acquisition = state.pendingAcquire && (!state.pendingTime || state.lastKind !== 'acquisition');
      state.lastKind = acquisition ? 'acquisition' : 'time-only';
      const ticketKey = acquisition ? 'acquireTicket' : 'timeTicket';
      const ticket = state[ticketKey]; state[ticketKey] = null;
      if (acquisition) state.pendingAcquire = false; else state.pendingTime = false;
      try {
        if (operationWindow) await operationWindow.run(state.tenant, () => cycle(state, acquisition));
        else await cycle(state, acquisition);
      } catch (error) {
        if (!operationWindow) throw error;
        discard(state); state.code = 'EVALUATOR_WINDOW_REFUSED';
      } finally { ticket.resolve(); }
    }
  }
  async function cycle (state, acquisition) {
    let current;
    const readingGeneration = state.generation;
    try { current = await readCurrent(state.tenant); }
    catch {
      if (!closed && readingGeneration === state.generation) { discard(state); state.code = 'EVALUATOR_CONFIG_REFUSED'; }
      return;
    }
    if (closed) return;
    if (readingGeneration !== state.generation) return;
    if (!current) { discard(state); state.code = 'EVALUATOR_TENANT_DISABLED'; return; }
    if (current.tenant !== state.tenant || !/^[0-9a-f]{64}$/.test(current.identity || '')) {
      discard(state); state.code = 'EVALUATOR_CONFIG_REFUSED'; return;
    }
    let cycleGeneration;
    try {
      if (state.instance && current.identity !== state.identity &&
          typeof current.sourceIdentity === 'string' && current.sourceIdentity === state.sourceIdentity &&
          typeof state.instance.reconfigure === 'function') {
        // Settings-only reconfiguration retains committed clinical input. A
        // source revision/tenant contract change still takes the discard path.
        const wasAcquired = state.acquired;
        state.generation++; state.last = null; state.acquired = false;
        state.instance.reconfigure({ env: current.env });
        state.identity = current.identity;
        state.acquired = wasAcquired;
      }
      if (!state.instance || current.identity !== state.identity) {
        discard(state);
        const creatingGeneration = state.generation;
        state.identity = current.identity; state.sourceIdentity = current.sourceIdentity || null; // current target, including async creation
        const instance = await create(current);
        if (closed || creatingGeneration !== state.generation) { closeComponent(instance); return; }
        state.instance = instance;
      }
      cycleGeneration = state.generation;
      const result = await (acquisition ? state.instance.evaluate({ at: now() }) : state.instance.evaluateTime({ at: now() }));
      if (closed || cycleGeneration !== state.generation) return; // generation and shutdown fence late results
      if (acquisition) state.acquired = true;
      state.last = Object.freeze({ identity: state.identity, runtimeId, outputRevision: ++state.revision,
        inputCheckpoint: result.checkpoint, trigger: acquisition ? 'acquisition' : 'time-only', result });
      state.code = state.acquired ? null : 'EVALUATOR_ACQUISITION_REQUIRED';
    } catch {
      if (closed || cycleGeneration !== undefined && cycleGeneration !== state.generation) return;
      if (acquisition) state.acquired = false;
      state.code = acquisition ? 'EVALUATOR_ACQUISITION_REFUSED' : 'EVALUATOR_TIME_REFUSED';
    }

  }
  function pump (state) {
    if (state.running) return;
    state.running = drain(state).catch(() => { state.acquired = false; state.code = 'EVALUATOR_JOB_REFUSED'; }).then(() => {
      state.running = null;
      if (!closed && (state.pendingAcquire || state.pendingTime)) pump(state);
    });
  }
  function trigger (tenant, acquisition) {
    if (closed) return Promise.reject(new Error('Evaluator runtime is closed'));
    const state = states.get(tenant);
    if (!state) return Promise.reject(new Error('Evaluator tenant is not configured'));
    const key = acquisition ? 'acquireTicket' : 'timeTicket';
    if (!state[key]) {
      const ticket = {}; ticket.promise = new Promise(resolve => { ticket.resolve = resolve; }); state[key] = ticket;
    }
    const ticket = state[key];
    if (acquisition) state.pendingAcquire = true; else state.pendingTime = true;
    pump(state);
    return ticket.promise;
  }
  function all (acquisition) { return Promise.all([...states.keys()].map(tenant => trigger(tenant, acquisition))); }
  const runtime = {
    async invalidateTenant (tenant) {
      const state = states.get(tenant);
      if (!state || closed) throw new Error('Evaluator tenant is not configured');
      // Durable suspension excludes fresh work; drain any refused queued attempts.
      while (state.running) await state.running;
      discard(state); state.code = 'EVALUATOR_ACQUISITION_REQUIRED';
    },
    acquire: tenant => trigger(tenant, true),
    tick: tenant => trigger(tenant, false),
    async isCurrent (tenant, identity) {
      if (closed || !states.has(tenant)) return false;
      const state = states.get(tenant);
      try {
        const current = await readCurrent(tenant);
        if (closed) return false;
        if (!current || current.tenant !== tenant || current.identity !== identity) {
          // An old caller must not retire a newer, already-current context.
          if (!current || current.tenant !== tenant || state.identity !== current.identity) {
            const settingsOnly = current && current.tenant === tenant &&
              typeof current.sourceIdentity === 'string' && current.sourceIdentity === state.sourceIdentity &&
              typeof state.instance?.reconfigure === 'function';
            if (settingsOnly) { state.generation++; state.last = null; }
            else discard(state);
            state.code = 'EVALUATOR_CONFIG_CHANGED';
          }
          return false;
        }
        return true;
      } catch { discard(state); state.code = 'EVALUATOR_CONFIG_REFUSED'; return false; }
    },
    health () { return { closed, tenants: [...states.values()].map(s => ({ tenant: s.tenant,
      ready: !closed && s.acquired && s.code === null, code: s.code, identity: s.identity,
      outputRevision: s.last?.outputRevision || null, inputCheckpoint: s.last?.inputCheckpoint ?? null })) }; },
    last (tenant) {
      const state = states.get(tenant);
      if (!state || !state.last || operationWindow && !operationWindow.current(tenant)) return null;
      return Object.freeze({ ...state.last, eligible: !closed && state.acquired && state.code === null });
    },
    close () {
      if (closing) return closing;
      closed = true; timers.forEach(cancel);
      for (const state of states.values()) {
        state.pendingAcquire = false; state.pendingTime = false;
        for (const key of ['acquireTicket', 'timeTicket']) {
          if (state[key]) state[key].resolve(); state[key] = null;
        }
        if (state.instance) closeComponent(state.instance);
      }
      closing = Promise.allSettled([...states.values()].map(state => state.running)).then(() => {
        if (cleanupErrors.length) throw new globalThis.AggregateError(cleanupErrors, 'Evaluator component shutdown failed');
      });
      return closing;
    }
  };
  await all(true); // first full acquisition before reporting preview readiness
  timers.push(schedule(() => { all(true).catch(() => {}); }, recoveryIntervalMs));
  timers.push(schedule(() => { all(false).catch(() => {}); }, timeIntervalMs));
  return Object.freeze(runtime);
};
