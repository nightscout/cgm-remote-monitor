'use strict';
const { randomUUID, createHash } = require('node:crypto');

// The output content consumers and the notification producer read from a
// cycle result. Per-cycle metadata (now, evaluationRevision, trigger) is not
// content. A time-driven change (stale data, minutes-ago states) changes
// emitted/requested/properties and therefore the digest.
const CONTENT = Object.freeze(['checkpoint', 'progress', 'emitted', 'requested', 'properties']);
function canonical (value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object' && typeof value.toJSON !== 'function') {
    return '{' + Object.keys(value).sort().filter(key => value[key] !== undefined && typeof value[key] !== 'function')
      .map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  const json = JSON.stringify(value);
  return json === undefined ? 'null' : json;
}
function contentDigest (result) {
  return createHash('sha256').update(canonical(Object.fromEntries(CONTENT.map(key => [key, result?.[key]])))).digest('hex');
}

// One explicit preview process owns its local jobs. No lease, provider, feed
// transport, notification handoff or durable evaluated-output revision is implied.
// With `activity` selected, timers and triggers build their work list from
// tenants eligible under the current durable pause/suspend state; a paused or
// suspended tenant gets no acquisition, component, cycle or published output.
// With `pool` (lib/server/serve/evaluator-pool.js) every scheduled pass first
// reads pool membership once; a tenant outside this member's current slice, or
// every tenant while membership is refused, is withdrawn exactly as a paused
// one is (in-flight cycle fenced, output and component retired), and a tenant
// that enters the slice starts with a full acquisition on a fresh component.
//
// Work on change (decision cost-proportional-to-activity, D6): there is no
// per-tenant poll. Three sources call one entry point per tenant:
//  - the backstop pass, every recoveryIntervalMs: one membership read, one
//    read of every tenant's write clock pair (last_stamp, last_delete_stamp)
//    through `readStamps` (the change-stamp function, lib/change-stamps: one
//    statement per member per pass), then per admitted tenant its activity,
//    its configuration identity and that pair. Decision write-clock-complete:
//    every write the evaluator reads, hard deletes and activity included,
//    advances the pair. Without `readStamps` the component reads its own
//    tenant's pair (lib/storage/postgres-durable-replay.js signature, one
//    primary-key row). A pair different from the one processed by the last
//    successful acquisition, a missing one, or a changed configuration
//    acquires; otherwise the pass does nothing;
//  - `wake(tenant, { stamp })`, the seam for a later wake source (a slot
//    reader's NOTIFY): a stamp at or below the processed floor is a duplicate
//    and does nothing, a higher one acquires, no stamp checks the signature;
//  - a per-tenant due-time timer for time-driven output: the earliest instant
//    the plugins' time comparisons can flip (lib/data/evaluator-due.js), or the
//    bounded slow timer (timeIntervalMs) while the output depends continuously
//    on time. A component without due-time support keeps the slow timer.
// An idle tenant may be evicted (evictAfterMs): its component releases the
// retained input; the published output, processed signature and due timer
// stay, and the next cycle of an evicted tenant is a full acquisition.
//
// Boot (decision readiness-serve-then-warm): 'all' acquires every tenant before
// the runtime is returned (readiness after the first full acquisition); 'serve'
// returns at once and acquires in the background, at most bootConcurrency at a
// time, warm tenants (isWarm) first; the backstop leaves a queued tenant to
// that queue. Either way a tenant whose evaluation has not been confirmed
// current (an acquisition, a time-only cycle, or a backstop check that found
// nothing changed) within evaluationAlertMs, since the runtime started or since
// its last confirmation, raises EVALUATOR_NOT_EVALUATED_WITHIN_BOUND once
// (health().alerts, a log line), cleared when it is confirmed. A paused,
// suspended or withdrawn tenant is not expected to be evaluated and does not alert.
// A change signature: the tenant write clock pair { stamp, deleted }
// (postgres-durable-replay signature; the change-stamp function's row).
function validSignature (value) {
  if (!value || typeof value !== 'object') return null;
  const stamp = Number(value.stamp), deleted = Number(value.deleted);
  if (!Number.isSafeInteger(stamp) || stamp < 0 || !Number.isSafeInteger(deleted) || deleted < 0 ||
      ![value.stamp, value.deleted].every(part => typeof part === 'number' || (typeof part === 'string' && /^(0|[1-9][0-9]*)$/.test(part)))) return null;
  return Object.freeze({ stamp, deleted });
}
const same = (a, b) => !!a && !!b && a.stamp === b.stamp && a.deleted === b.deleted;
module.exports = async function evaluatorRuntime ({ tenants, readCurrent, create,
  recoveryIntervalMs, timeIntervalMs, operationWindow, jobContext, activity, pool, schedule = setInterval, cancel = clearInterval,
  setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now, onRevision, evictAfterMs,
  boot = 'all', bootConcurrency, isWarm, evaluationAlertMs = 60000, checkConcurrency = 4, readStamps, externalRecovery = false, checkBatchSize = 64, dynamic = false, maxTenants = 10000,
  alert = (code, tenant, ageMs) => console.warn('Evaluator alert', code, tenant, ageMs + ' ms') }) {
  if (!Array.isArray(tenants) || (!dynamic && !tenants.length) || new Set(tenants).size !== tenants.length ||
      tenants.some(id => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) ||
      [readCurrent, create, schedule, cancel, now].some(fn => typeof fn !== 'function') ||
      [recoveryIntervalMs, timeIntervalMs].some(n => !Number.isSafeInteger(n) || n < 1 || n > 2147483647)) {
    throw new TypeError('Explicit evaluator tenants, current config, component and schedule required');
  }
  if (onRevision !== undefined && typeof onRevision !== 'function') throw new TypeError('Evaluator revision callback must be a function');
  if ([setTimer, clearTimer].some(fn => typeof fn !== 'function')) throw new TypeError('Evaluator due-time timer required');
  if (evictAfterMs !== undefined && (!Number.isSafeInteger(evictAfterMs) || evictAfterMs < 1)) throw new TypeError('Evaluator eviction interval must be a positive integer');
  if (!['all', 'serve'].includes(boot) || (boot === 'serve' && (!Number.isSafeInteger(bootConcurrency) || bootConcurrency < 1)) ||
      (isWarm !== undefined && typeof isWarm !== 'function') || !Number.isSafeInteger(evaluationAlertMs) || evaluationAlertMs < 1 ||
      typeof alert !== 'function' || !Number.isSafeInteger(checkConcurrency) || checkConcurrency < 1) throw new TypeError('Evaluator boot mode, concurrency, warm predicate and evaluation alert bound required');
  if (operationWindow !== undefined && [operationWindow.run, operationWindow.current].some(fn => typeof fn !== 'function')) throw new TypeError('Evaluator operation window required');
  if (!operationWindow && jobContext !== undefined) throw new TypeError('Evaluator jobs require their selected operation window');
  const jobs = operationWindow ? require('./evaluator-job-context').claim(jobContext, 'clinical') : null;
  if (jobs) {
    const timer = setTimer, interval = schedule;
    setTimer = (fn, ms) => timer(jobs.bind(fn), ms);
    schedule = (fn, ms) => interval(jobs.bind(fn), ms);
  }
  if (activity !== undefined && typeof activity?.check !== 'function') throw new TypeError('Evaluator activity eligibility required');
  if (pool !== undefined && [pool?.admits, pool?.refresh, pool?.reason].some(fn => typeof fn !== 'function')) throw new TypeError('Evaluator pool gate required');
  if (readStamps !== undefined && typeof readStamps !== 'function') throw new TypeError('Evaluator change-stamp reader must be a function');
  if(typeof dynamic!=='boolean' || !Number.isSafeInteger(maxTenants) || maxTenants<1)throw new TypeError('Explicit dynamic tenant bound required');
  if (typeof externalRecovery !== 'boolean' || !Number.isSafeInteger(checkBatchSize) || checkBatchSize < 1 || checkBatchSize > 1024) throw new TypeError('Bounded evaluator recovery required');
  tenants = [...tenants];
  let nextGeneration = 0;
  function generation () {
    if (nextGeneration === Number.MAX_SAFE_INTEGER) throw new Error('EVALUATOR_GENERATION_EXHAUSTED');
    return ++nextGeneration;
  }
  const makeState = tenant => ({ tenant, createdAt: now(), instance: null, identity: null, sourceIdentity: null,
    last: null, revision: 0, generation: generation(), completedAcquisitions: 0, completedTimeCycles: 0, lastCompletedAt: null, failedCompletions: 0, acquired: false, code: 'EVALUATOR_STARTING', pendingAcquire: false, pendingTime: false, acquireTicket: null, timeTicket: null, parentAcquireTicket: null, parentTimeTicket: null, lastKind: null, running: null, runningParent: null, cycles: 0,
    activity: null, inactive: false, reactivated: false, withdrawn: false,
    processed: null, dueTimer: null, dueAt: null, dueReason: null, evicted: false, changedAt: null, recheck: null, recheckParent: null,
    confirmedAt: null, booting: false, alerting: false, checking: false });
  const states = new Map(tenants.map(tenant => [tenant,makeState(tenant)]));
  const counters = { passes: 0, checks: 0, unchanged: 0, acquisitionsByCheck: 0, checksRefused: 0, stampReads: 0, stampReadsRefused: 0,
    wakes: 0, duplicateWakes: 0, dueFires: 0, evictions: 0 };
  // Backstop checks (and the acquisitions they start) hold one of
  // checkConcurrency slots: N tenants never queue N callers on a pool whose
  // connect timeout would refuse the excess (measured: 1,000 at once refused 817).
  let slots = checkConcurrency; const waiting = [];
  const take = () => (slots > 0 ? (slots--, Promise.resolve()) : new Promise(resolve => waiting.push(resolve)));
  const give = () => { const next = waiting.shift(); if (next) next(); else slots++; };
  let closed = false, closing;
  const runtimeId = randomUUID();
  const timers = [], cleanupErrors = [];
  function closeComponent (instance) { try { instance.close(); } catch (error) { cleanupErrors.push(error); } }
  function disarm (state) {
    if (state.dueTimer) clearTimer(state.dueTimer);
    state.dueTimer = null; state.dueAt = null; state.dueReason = null;
  }
  // The next time-only cycle: the component's due instant, the slow timer while
  // the output changes continuously with time, or the slow timer alone for a
  // component that does not compute one.
  function arm (state, at, result) {
    disarm(state);
    if (closed || state.inactive || state.withdrawn) return;
    const due = result?.due;
    let next = due ? (Number.isFinite(due.dueAt) ? due.dueAt : Infinity) : at + timeIntervalMs;
    let reason = due ? due.reason : 'slow';
    if (due && due.slow.length && at + timeIntervalMs < next) { next = at + timeIntervalMs; reason = 'slow:' + due.slow.join(','); }
    if (evictAfterMs !== undefined && !state.evicted && state.changedAt !== null && state.changedAt + evictAfterMs < next) {
      next = state.changedAt + evictAfterMs; reason = 'evict';
    }
    if (!Number.isFinite(next)) return;
    state.dueAt = next; state.dueReason = reason;
    const timer = setTimer(() => {
      if (state.dueTimer !== timer) return;
      state.dueTimer = null;
      if (reason === 'evict') { evict(state, at, result); return; }
      counters.dueFires++;
      trigger(state.tenant, false).catch(() => {});
    }, Math.min(2147483647, Math.max(0, next - now())));
    state.dueTimer = timer;
  }
  // Release an idle tenant's retained input; keep its output, signature and timer.
  function evict (state, at, result) {
    if (closed || state.running || !state.instance || typeof state.instance.evict !== 'function') { arm(state, at, result); return; }
    state.instance.evict(); state.evicted = true; counters.evictions++;
    arm(state, at, result);
  }
  function discard (state) {
    state.generation = generation(); state.processed = null; state.evicted = false; disarm(state);
    const previous = state.instance;
    state.instance = null; state.identity = null; state.sourceIdentity = null; state.last = null; state.acquired = false;
    if (previous) closeComponent(previous);
  }
  const parentOf = tenant => operationWindow ? require('../../tenant-lifecycle/operation-window').schedulingParent(operationWindow, tenant) : null;
  const parentBusy = () => Object.assign(new Error('EVALUATOR_JOB_PARENT_BUSY'), { code: 'EVALUATOR_JOB_PARENT_BUSY' });
  async function drain (state, parent) {
    while (!closed) {
      const acquireKey = parent ? 'parentAcquireTicket' : 'acquireTicket';
      const timeKey = parent ? 'parentTimeTicket' : 'timeTicket';
      const acquire = state[acquireKey]?.parent === parent;
      const time = state[timeKey]?.parent === parent;
      if (!acquire && !time) return;
      const acquisition = acquire && (!time || state.lastKind !== 'acquisition');
      state.lastKind = acquisition ? 'acquisition' : 'time-only';
      const ticketKey = acquisition ? acquireKey : timeKey;
      const ticket = state[ticketKey]; state[ticketKey] = null;
      state.pendingAcquire = !!(state.acquireTicket || state.parentAcquireTicket);
      state.pendingTime = !!(state.timeTicket || state.parentTimeTicket);
      try {
        // Only a successful, still-current cycle whose fresh window has fully
        // released earns completion credit. Legacy cycles counts entered work.
        const borrowed = !!parent;
        const completed = operationWindow
          ? await operationWindow.run(state.tenant, () => cycle(state, acquisition))
          : await cycle(state, acquisition);
        if (operationWindow && completed && !borrowed && !closed && states.get(state.tenant) === state &&
            completed.generation === state.generation && !state.inactive && !state.withdrawn && state.code === null) {
          state[acquisition ? 'completedAcquisitions' : 'completedTimeCycles']++;
          state.lastCompletedAt = now();
        } else if (operationWindow && !borrowed && !state.inactive && !state.withdrawn && state.code !== 'EVALUATOR_TENANT_DISABLED') state.failedCompletions++;
      } catch (error) {
        if (!operationWindow) throw error;
        state.failedCompletions++; discard(state); state.code = 'EVALUATOR_WINDOW_REFUSED';
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
        state.generation = generation(); state.last = null; state.acquired = false;
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
      const at = now();
      const result = await (acquisition ? state.instance.evaluate({ at }) : state.instance.evaluateTime({ at }));
      if (closed || cycleGeneration !== state.generation) return; // generation and shutdown fence late results
      // A pause committed while this cycle ran must not publish its output.
      if (activity && (!await eligible(state) || cycleGeneration !== state.generation)) return;
      // A membership change read while this cycle ran must not publish its output.
      if (pool && !pool.admits(state.tenant)) return;
      if (acquisition) {
        state.acquired = true; state.reactivated = false; state.evicted = false;
        const seen = validSignature(result?.signature);
        if (!same(state.processed, seen)) state.changedAt = at;
        state.processed = seen;
      }
      state.cycles++; confirm(state);
      arm(state, at, result);
      // Identical content keeps the revision and the same frozen output object.
      // A pause clears state.last, so the first output after unpause is a new revision.
      const content = contentDigest(result);
      const changed = !state.last || state.last.identity !== state.identity || state.content !== content;
      if (changed) {
        state.content = content;
        state.last = Object.freeze({ identity: state.identity, runtimeId, outputRevision: ++state.revision, contentDigest: content,
          inputCheckpoint: result.checkpoint, trigger: acquisition ? 'acquisition' : 'time-only', result });
      }
      state.code = state.acquired ? null : 'EVALUATOR_ACQUISITION_REQUIRED';
      if (changed && onRevision) { try { onRevision(state.tenant); } catch { /* a wake never fails a clinical cycle */ } }
      return { generation: cycleGeneration };
    } catch {
      if (closed || cycleGeneration !== undefined && cycleGeneration !== state.generation) return;
      if (acquisition) state.acquired = false;
      state.code = acquisition ? 'EVALUATOR_ACQUISITION_REFUSED' : 'EVALUATOR_TIME_REFUSED';
      // A refused time-only cycle retries on the slow timer; a refused
      // acquisition is retried by the next backstop pass (not acquired).
      if (!acquisition) arm(state, now(), null);
    }

  }
  // Ineligible: fence any in-flight cycle (generation), drop queued work and
  // retire the component and its output. Nothing is published while inactive.
  function deactivate (state, checked) {
    const code = 'EVALUATOR_' + checked.code;
    // An unreadable or missing row stops this tenant only; say so once per change.
    if (code !== state.code && ['ACTIVITY_UNAVAILABLE', 'ACTIVITY_NOT_PROVISIONED'].includes(checked.code)) {
      console.warn('Evaluator stopped for tenant ' + state.tenant + ': ' + code);
    }
    state.activity = checked.state; state.code = code;
    if (state.inactive) return;
    state.inactive = true; if (state.watchTimer) clearTimer(state.watchTimer); state.watchTimer = null; state.alerting = false; state.generation = generation(); state.last = null; state.acquired = false; state.processed = null; disarm(state);
    state.pendingAcquire = false; state.pendingTime = false;
    for (const key of ['acquireTicket', 'timeTicket', 'parentAcquireTicket', 'parentTimeTicket']) { if (state[key]) state[key].resolve(); state[key] = null; }
    Promise.resolve(state.running).then(() => { if (state.inactive) discard(state); });
  }
  // Pool membership: withdraw a tenant this member may not work now; the same
  // retirement as a pause, with its own code. Reinstatement is a fresh start.
  function withdraw (state) {
    const reason = pool.reason();
    state.code = reason ? 'EVALUATOR_' + reason : 'EVALUATOR_POOL_NOT_IN_SLICE';
    if (state.withdrawn) return;
    state.withdrawn = true; if (state.watchTimer) clearTimer(state.watchTimer); state.watchTimer = null; state.alerting = false; state.generation = generation(); state.last = null; state.acquired = false; state.processed = null; disarm(state);
    state.pendingAcquire = false; state.pendingTime = false;
    for (const key of ['acquireTicket', 'timeTicket', 'parentAcquireTicket', 'parentTimeTicket']) { if (state[key]) state[key].resolve(); state[key] = null; }
    Promise.resolve(state.running).then(() => { if (state.withdrawn) discard(state); });
  }
  function admitted (state) {
    if (!pool) return true;
    if (!pool.admits(state.tenant)) { withdraw(state); return false; }
    if (state.withdrawn) { state.withdrawn = false; state.reactivated = true; discard(state); if (!state.inactive) state.code = 'EVALUATOR_ACQUISITION_REQUIRED'; if (externalRecovery) armWatch(state); }
    return true;
  }
  async function eligible (state) {
    if (!activity) return true;
    const checked = await activity.check('evaluator', state.tenant);
    if (closed) return false;
    if (!checked.eligible) { deactivate(state, checked); return false; }
    state.activity = checked.state;
    // Reactivation recomputes from current data: the next cycle is a full
    // acquisition on a fresh component, whatever triggered it.
    if (state.inactive) { state.inactive = false; state.reactivated = true; discard(state); state.code = 'EVALUATOR_ACQUISITION_REQUIRED'; if (externalRecovery) armWatch(state); }
    return true;
  }
  function pump (state, parent = null) {
    if (state.running) return;
    state.runningParent = parent;
    const run = () => drain(state, parent);
    const finish = () => {
      state.running = null; state.runningParent = null;
      if (!closed && (state.pendingAcquire || state.pendingTime)) {
        // Borrowed tickets may only run in their original active parent, never
        // be laundered into a trusted continuation after that parent returned.
        for (const key of ['parentAcquireTicket','parentTimeTicket']) if (state[key]) {
          state[key].reject(parentBusy()); state[key] = null;
          state.pendingAcquire = !!state.acquireTicket; state.pendingTime = !!state.timeTicket;
        }
        if (state.pendingAcquire || state.pendingTime) pump(state);
      }
    };
    state.running = (jobs && !parent ? jobs.run(run) : run()).catch(() => { state.acquired = false; state.code = 'EVALUATOR_JOB_REFUSED'; })
      .then(jobs ? jobs.bind(finish) : finish);
  }
  function trigger (tenant, acquisition) {
    if (closed) return Promise.reject(new Error('Evaluator runtime is closed'));
    let parent; try { parent = parentOf(tenant); } catch (error) { return Promise.reject(error); }
    const state = states.get(tenant);
    if (!state) return Promise.reject(new Error('Evaluator tenant is not configured'));
    if (parent && state.running && state.runningParent !== parent) return Promise.reject(parentBusy());
    if (!admitted(state)) return Promise.resolve();
    if (activity) return eligible(state).then(admitted => admitted ? enqueue(state, acquisition, parent) : undefined);
    return enqueue(state, acquisition, parent);
  }
  // At most two owned and two borrowed pending tickets per tenant. A parent
  // can coalesce only with itself; it never waits on independent work that
  // may need the one physical client it is already holding.
  function enqueue (state, acquisition, parent = null) {
    if (closed) return Promise.resolve();
    if (state.reactivated || state.evicted) acquisition = true;
    const key = acquisition ? (parent ? 'parentAcquireTicket' : 'acquireTicket') : (parent ? 'parentTimeTicket' : 'timeTicket');
    if (parent && (state.running && state.runningParent !== parent || state[key] && state[key].parent !== parent)) return Promise.reject(parentBusy());
    if (!state[key]) {
      const ticket = { parent }; ticket.promise = new Promise((resolve,reject) => { ticket.resolve = resolve; ticket.reject = reject; }); state[key] = ticket;
    }
    const ticket = state[key];
    if (acquisition) state.pendingAcquire = true; else state.pendingTime = true;
    pump(state, parent);
    return ticket.promise;
  }
  // One membership read per scheduled pass, before any tenant is triggered.
  async function all (acquisition) {
    if (pool) await pool.refresh();
    return Promise.all([...states.keys()].map(tenant => trigger(tenant, acquisition)));
  }
  // The one entry point: has this tenant changed since its processed signature?
  // `stamps` (a backstop pass with readStamps): the pair read for every tenant
  // at the start of the pass; otherwise the component reads its own.
  async function check (state, stamps, parent = null) {
    if (closed) return;
    if (!admitted(state)) return;
    if (activity && !await eligible(state)) return;
    if (closed || state.inactive || state.withdrawn) return;
    if (state.pendingAcquire || state.booting) return;
    if (state.running) {
      if (parent && (state.runningParent !== parent || state.recheck && state.recheckParent !== parent)) throw parentBusy();
      // A cycle in flight must not hide a change: check once more when it
      // finishes (one shared re-check, never a blind extra acquisition).
      // The re-check reads the pair afresh: the one read for this pass may
      // predate the cycle's own acquisition.
      if (!state.recheck) {
        state.recheckParent = parent;
        const recheck = () => {
          state.recheck = null; state.recheckParent = null;
          if (parent && parentOf(state.tenant) !== parent) throw parentBusy();
          return check(state, undefined, parent);
        };
        state.recheck = Promise.resolve(state.running).then(jobs && !parent ? jobs.bind(recheck) : recheck).catch(() => {});
      }
      return state.recheck;
    }
    counters.checks++;
    if (!state.acquired || !state.instance || !state.processed || (!stamps && typeof state.instance.signature !== 'function')) {
      counters.acquisitionsByCheck++; return enqueue(state, true, parent);
    }
    const generation = state.generation;
    let current, seen;
    // A refused read is not a change: the next pass retries it, and a tenant
    // that stays unreadable is reported by the evaluation-gap alert.
    try { current = await readCurrent(state.tenant); } catch { counters.checksRefused++; return; }
    if (closed || generation !== state.generation) return;
    if (!current || current.identity !== state.identity) { counters.acquisitionsByCheck++; return enqueue(state, true, parent); }
    if (stamps) seen = stamps.get(state.tenant) ?? null;
    else { try { seen = await state.instance.signature(); } catch { counters.checksRefused++; return; } }
    if (closed || generation !== state.generation || !state.processed) return;
    if (same(state.processed, validSignature(seen))) { counters.unchanged++; confirm(state); return; }
    counters.acquisitionsByCheck++;
    return enqueue(state, true, parent);
  }
  // The D6 backstop: one membership read, then every configured tenant's check.
  // In flight per tenant, not per pass: a tenant whose check hangs holds only
  // itself (and is reported by the evaluation-gap alert), never the others.
  async function pass (selected = tenants, parents) {
    if (!Array.isArray(selected) || selected.some(t => !states.has(t))) throw new TypeError('Known evaluator tenants required');
    const selectedStates = selected.map(t => states.get(t));
    if (closed) return;
    counters.passes++;
    if (pool) await pool.refresh();
    // One statement for the whole member (decision change-stamp-definer-function).
    // A refused read is not a change: no tenant is checked this pass, the next
    // pass retries, and a tenant that stays unchecked is reported by the
    // evaluation-gap alert.
    let stamps;
    if (readStamps) {
      const wanted = selectedStates.filter(state => !state.withdrawn && !state.inactive && (!pool || pool.admits(state.tenant))).map(state => state.tenant);
      if (!wanted.length) stamps = new Map();
      else {
        counters.stampReads++;
        try {
          const read = await readStamps(wanted);
          stamps = new Map(wanted.map(tenant => [tenant, validSignature(read?.get(tenant))]));
        } catch { counters.stampReadsRefused++; return; }
      }
      if (closed) return;
    }
    await Promise.all(selectedStates.map(state => {
      if (state.checking) return null;
      state.checking = true;
      return take().then(() => check(state, stamps, parents?.get(state.tenant) || null).catch(() => {}).finally(give)).finally(() => { state.checking = false; });
    }));
  }
  const runtime = {
    addTenant (tenant) {
      if (!dynamic || closed || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tenant) || states.size >= maxTenants && !states.has(tenant)) throw new Error('Dynamic evaluator tenant refused');
      if (states.has(tenant)) return;const state=makeState(tenant);states.set(tenant,state);tenants.push(tenant);if(externalRecovery)armWatch(state);
    },
    async removeTenant (tenant) {
      if (!dynamic) throw new Error('Dynamic evaluator tenant refused');const state=states.get(tenant);if(!state)return;
      state.generation = generation();state.inactive=true;state.withdrawn=true;state.pendingAcquire=false;state.pendingTime=false;disarm(state);if(state.watchTimer)clearTimer(state.watchTimer);
      for(const key of ['acquireTicket','timeTicket','parentAcquireTicket','parentTimeTicket']){state[key]?.resolve();state[key]=null;}states.delete(tenant);const index=tenants.indexOf(tenant);if(index>=0)tenants.splice(index,1);
      await Promise.allSettled([state.running]);discard(state);
    },
    async invalidateTenant (tenant) {
      const state = states.get(tenant);
      if (!state || closed) throw new Error('Evaluator tenant is not configured');
      // Durable suspension excludes fresh work; drain any refused queued attempts.
      while (state.running) await state.running;
      // Invalidation (for example a restore's activation) never re-enables a
      // paused or suspended tenant; only the durable activity state does.
      discard(state); if (!state.inactive && !state.withdrawn) state.code = 'EVALUATOR_ACQUISITION_REQUIRED';
    },
    acquire: tenant => trigger(tenant, true),
    tick: tenant => trigger(tenant, false),
    // The wake seam (a later slot reader's NOTIFY calls this). A wake is a
    // hint: the signature against the processed checkpoint is the truth.
    wake (tenant, { stamp } = {}) {
      if (closed) return Promise.reject(new Error('Evaluator runtime is closed'));
      const state = states.get(tenant);
      if (!state) return Promise.reject(new Error('Evaluator tenant is not configured'));
      let parent; try { parent = parentOf(tenant); } catch (error) { return Promise.reject(error); }
      counters.wakes++;
      if (Number.isSafeInteger(stamp) && state.acquired && state.processed && !state.evicted && stamp <= state.processed.stamp) {
        counters.duplicateWakes++; return Promise.resolve();
      }
      if (Number.isSafeInteger(stamp)) return trigger(tenant, true);
      if (parent && state.running && state.runningParent !== parent) return Promise.reject(parentBusy());
      return check(state, undefined, parent);
    },
    backstop (selected = tenants) {
      try {
        const parents = new Map(selected.map(tenant => [tenant,parentOf(tenant)]));
        for (const [tenant,parent] of parents) if (parent && states.get(tenant)?.running && states.get(tenant).runningParent !== parent) throw parentBusy();
        return pass(selected, parents);
      } catch (error) { return Promise.reject(error); }
    },
    async isCurrent (tenant, identity) {
      if (closed || !states.has(tenant)) return false;
      const state = states.get(tenant);
      if (activity && !await eligible(state)) return false;
      try {
        const current = await readCurrent(tenant);
        if (closed) return false;
        if (!current || current.tenant !== tenant || current.identity !== identity) {
          // An old caller must not retire a newer, already-current context.
          if (!current || current.tenant !== tenant || state.identity !== current.identity) {
            const settingsOnly = current && current.tenant === tenant &&
              typeof current.sourceIdentity === 'string' && current.sourceIdentity === state.sourceIdentity &&
              typeof state.instance?.reconfigure === 'function';
            if (settingsOnly) { state.generation = generation(); state.last = null; }
            else discard(state);
            state.code = 'EVALUATOR_CONFIG_CHANGED';
          }
          return false;
        }
        return true;
      } catch { discard(state); state.code = 'EVALUATOR_CONFIG_REFUSED'; return false; }
    },
    health (selected) {
      const rows = selected === undefined ? [...states.values()] : selected.map(tenant => {
        const state = states.get(tenant); if (!state) throw new Error('Evaluator tenant is not configured'); return state;
      });
      return { runtimeId, closed, tenants: rows.map(s => ({ tenant: s.tenant,
      ready: !closed && s.acquired && s.code === null, code: s.code, identity: s.identity,
      ...(activity ? { activity: s.activity } : {}),
      ...(pool ? { pool: s.withdrawn ? 'withdrawn' : 'admitted' } : {}),
      progress: { generation: s.generation, completedAcquisitions: s.completedAcquisitions, completedTimeCycles: s.completedTimeCycles,
        lastCompletedAgeMs: s.lastCompletedAt === null ? null : Math.max(0, now() - s.lastCompletedAt), failedCompletions: s.failedCompletions },
      outputRevision: s.last?.outputRevision || null, inputCheckpoint: s.last?.inputCheckpoint ?? null, cycles: s.cycles,
      dueAt: s.dueAt, dueReason: s.dueReason, evicted: s.evicted, booting: s.booting,
      evaluatedAgeMs: closed ? null : now() - (s.confirmedAt ?? s.createdAt), alert: s.alerting ? 'EVALUATOR_NOT_EVALUATED_WITHIN_BOUND' : null })),
    alerts: rows.filter(s => s.alerting).map(s => ({ tenant: s.tenant, code: 'EVALUATOR_NOT_EVALUATED_WITHIN_BOUND' })),
    boot, wake: { ...counters } }; },
    last (tenant) {
      const state = states.get(tenant);
      if (!state || !state.last || state.inactive || state.withdrawn || operationWindow && !operationWindow.current(tenant)) return null;
      return Object.freeze({ ...state.last, eligible: !closed && state.acquired && state.code === null });
    },
    close () {
      if (closing) return closing;
      closed = true; timers.forEach(cancel);
      for (const state of states.values()) {
        disarm(state); if (state.watchTimer) clearTimer(state.watchTimer);
        state.pendingAcquire = false; state.pendingTime = false;
        for (const key of ['acquireTicket', 'timeTicket', 'parentAcquireTicket', 'parentTimeTicket']) {
          if (state[key]) state[key].resolve(); state[key] = null;
        }
        if (state.instance) closeComponent(state.instance);
      }
      closing = Promise.allSettled([...states.values()].map(state => state.running)).then(() => {
        if (cleanupErrors.length) throw new globalThis.AggregateError(cleanupErrors, 'Evaluator component shutdown failed');
      }).finally(() => jobs?.close());
      return closing;
    }
  };
  // The evaluation-gap watchdog runs on its own schedule, so a stuck backstop
  // or a starved boot queue still alerts.
  // Feed mode keeps the clinical watchdog's deadline independent of the
  // paged recovery cursor. Each tenant owns a due-time timer, not an all-roster
  // tick; successful checks/cycles re-arm it, inactive tenants cancel it.
  function armWatch (state) {
    clearTimer(state.watchTimer); state.watchTimer = null;
    if (closed || state.inactive || state.withdrawn) return;
    state.watchTimer = setTimer(() => { state.watchTimer = null; watchOne(state); },
      Math.max(1,evaluationAlertMs-(now()-(state.confirmedAt ?? state.createdAt))+1));
    state.watchTimer?.unref?.();
  }
  function confirm (state) {
    state.confirmedAt = now(); state.alerting = false;
    if (externalRecovery) armWatch(state);
  }
  function watchOne (state) {
    if (closed) return;
    const expected = !state.inactive && !state.withdrawn;
    const age = now()-(state.confirmedAt ?? state.createdAt);
    if (expected && age > evaluationAlertMs) {
      if (!state.alerting) { state.alerting = true; try { alert('EVALUATOR_NOT_EVALUATED_WITHIN_BOUND',state.tenant,age); } catch { /* an alert sink never fails scheduling */ } }
    } else { state.alerting = false; if (externalRecovery && expected) armWatch(state); }
  }
  function watch () { if (!closed) for (const state of states.values()) watchOne(state); }
  if (boot === 'all') await all(true); // first full acquisition before reporting preview readiness
  else {
    // Background boot: bounded, warm tenants first; the backstop leaves queued tenants alone.
    if (pool) await pool.refresh();
    const queue = [...states.values()];
    for (const state of queue) state.booting = true;
    const next = () => {
      if (!isWarm) return queue.shift();
      const index = queue.findIndex(state => { try { return isWarm(state.tenant); } catch { return false; } });
      return queue.splice(index < 0 ? 0 : index, 1)[0];
    };
    const worker = async () => {
      for (let state = next(); state && !closed; state = next()) {
        try { await trigger(state.tenant, true); } catch { /* a refused tenant is retried by the backstop */ }
        state.booting = false;
      }
    };
    Promise.all(Array.from({ length: Math.min(bootConcurrency, queue.length) }, worker))
      .finally(() => { for (const state of states.values()) state.booting = false; });
  }
  if (!externalRecovery) timers.push(schedule(() => { pass().catch(() => {}); }, recoveryIntervalMs));
  if (externalRecovery) for (const state of states.values()) armWatch(state);
  else timers.push(schedule(watch,Math.min(10000,Math.max(250,Math.floor(evaluationAlertMs/4)))));
  return Object.freeze(runtime);
};
module.exports.contentDigest = contentDigest;
module.exports.CONTENT = CONTENT;
