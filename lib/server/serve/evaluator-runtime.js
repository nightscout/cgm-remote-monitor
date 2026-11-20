'use strict';
const { randomUUID, createHash } = require('node:crypto');
const diagnostics = require('../../diagnostics/m7');
const metrics = require('../../metrics');
const stages = require('../../diagnostics/clinical-stages');

// The output content consumers and the notification producer read from a
// cycle result. Per-cycle metadata (now, evaluationRevision, trigger) is not
// content. A time-driven change (stale data, minutes-ago states) changes
// emitted/requested/properties and therefore the digest.
const CONTENT = Object.freeze(['checkpoint', 'progress', 'emitted', 'requested', 'properties']);
// Key-sorted JSON text. The definition is the recursive form; canonical()
// gives byte-identical text through one JSON.stringify pass that sorts each
// object's keys (several times faster on a full browser frame). JSON.stringify
// differs from the recursive form only for integer-like keys (an object always
// holds those in numeric order), symbol values, and a toJSON that returns an
// object (sorted there, kept as returned here); those shapes take the
// recursive form.
function recursiveCanonical (value) {
  if (Array.isArray(value)) return '[' + value.map(recursiveCanonical).join(',') + ']';
  if (value && typeof value === 'object' && typeof value.toJSON !== 'function') {
    return '{' + Object.keys(value).sort().filter(key => value[key] !== undefined && typeof value[key] !== 'function')
      .map(key => JSON.stringify(key) + ':' + recursiveCanonical(value[key])).join(',') + '}';
  }
  const json = JSON.stringify(value);
  return json === undefined ? 'null' : json;
}
const INTEGER_KEY = /^(?:0|[1-9][0-9]*)$/;
const UNSORTABLE = Symbol('canonical-unsortable');
const special = item => typeof item === 'symbol' || !!item && typeof item === 'object' && typeof item.toJSON === 'function' && !(item instanceof Date);
function sortKeys (key, value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) { for (const item of value) if (special(item)) throw UNSORTABLE; return value; }
  const keys = Object.keys(value);
  let ordered = true;
  for (let i = 0; i < keys.length; i++) {
    if (INTEGER_KEY.test(keys[i]) || special(value[keys[i]])) throw UNSORTABLE;
    if (i && keys[i - 1] > keys[i]) ordered = false;
  }
  if (ordered) return value;
  const sorted = Object.create(null); // keeps an own "__proto__" key a plain key
  for (const name of keys.sort()) sorted[name] = value[name];
  return sorted;
}
function canonical (value) {
  if (special(value)) return recursiveCanonical(value);
  let json;
  try { json = JSON.stringify(value, sortKeys); } catch (error) { if (error !== UNSORTABLE) throw error; return recursiveCanonical(value); }
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
//
// Work on change (decision cost-proportional-to-activity, D6): there is no
// per-tenant poll. Three sources call one entry point per tenant:
//  - the backstop pass, every recoveryIntervalMs: one
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
  recoveryIntervalMs, timeIntervalMs, operationWindow, jobContext, activity, schedule = setInterval, cancel = clearInterval,
  setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now, onRevision, evictAfterMs, residentLimit, loadOutput,
  boot = 'all', bootConcurrency, isWarm, evaluationAlertMs = 60000, checkConcurrency = 4, readStamps, readMetadata, metadataCurrent, readSource, workerState = readMetadata?.state, externalRecovery = false, durable, checkBatchSize = 64, dynamic = false, maxTenants = 10000, readinessObservation = false,
  alert = (code, tenant, ageMs) => console.warn('Evaluator alert', code, tenant, ageMs + ' ms') }) {
  if (!Array.isArray(tenants) || (!dynamic && !tenants.length) || new Set(tenants).size !== tenants.length ||
      tenants.some(id => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) ||
      [readCurrent, create, schedule, cancel, now].some(fn => typeof fn !== 'function') ||
      [recoveryIntervalMs, timeIntervalMs].some(n => !Number.isSafeInteger(n) || n < 1 || n > 2147483647)) {
    throw new TypeError('Explicit evaluator tenants, current config, component and schedule required');
  }
  if (durable && [durable.begin,durable.complete].some(fn => typeof fn !== 'function')) throw new TypeError('Durable evaluator receipt/completion required');
  if (residentLimit !== undefined && (!Number.isSafeInteger(residentLimit) || residentLimit < 1 || !durable || typeof loadOutput !== 'function')) throw new TypeError('Resident evaluator cache requires a positive bound and durable output reader');
  if (onRevision !== undefined && typeof onRevision !== 'function') throw new TypeError('Evaluator revision callback must be a function');
  if ([setTimer, clearTimer].some(fn => typeof fn !== 'function')) throw new TypeError('Evaluator due-time timer required');
  if (evictAfterMs !== undefined && (!Number.isSafeInteger(evictAfterMs) || evictAfterMs < 1)) throw new TypeError('Evaluator eviction interval must be a positive integer');
  if (!['all', 'serve'].includes(boot) || (boot === 'serve' && (!Number.isSafeInteger(bootConcurrency) || bootConcurrency < 1)) ||
      (isWarm !== undefined && typeof isWarm !== 'function') || !Number.isSafeInteger(evaluationAlertMs) || evaluationAlertMs < 1 ||
      typeof alert !== 'function' || !Number.isSafeInteger(checkConcurrency) || checkConcurrency < 1) throw new TypeError('Evaluator boot mode, concurrency, warm predicate and evaluation alert bound required');
  if (operationWindow !== undefined && [operationWindow.run, operationWindow.current].some(fn => typeof fn !== 'function')) throw new TypeError('Evaluator operation window required');
  if (!operationWindow && jobContext !== undefined) throw new TypeError('Evaluator jobs require their selected operation window');
  const runtimeId = randomUUID();
  const failureTrace = require('../../diagnostics/evaluator-failure').create(runtimeId);
  const failureReasons = require('./evaluator-failure-reasons');
  // Every failed-completion increment carries exactly one closed reason.
  // The oldest failure not yet followed by a credited completion stays open;
  // the next credit closes it and records the failure-to-success interval.
  function countFailure (state, reason) {
    state.failedCompletions++; state.failureReasons[reason]++; state.lastFailureReason = reason;
    if (state.unresolvedFailure === null) state.unresolvedFailure = { reason, at: now() };
  }
  function creditCompletion (state, acquisition) {
    state[acquisition ? 'completedAcquisitions' : 'completedTimeCycles']++;
    state.lastCompletedAt = now();
    if (state.unresolvedFailure !== null) {
      const interval = Math.max(0, state.lastCompletedAt - state.unresolvedFailure.at);
      state.maxFailureResolutionMs = state.maxFailureResolutionMs === null ? interval : Math.max(state.maxFailureResolutionMs, interval);
      state.unresolvedFailure = null;
    }
  }
  const reasonOf = (state, error) => failureReasons.classify(error, { window: operationWindow, tenant: state.tenant });
  const jobs = operationWindow ? require('./evaluator-job-context').claim(jobContext, 'clinical') : null;
  if (jobs) {
    const timer = setTimer, interval = schedule;
    setTimer = (fn, ms) => timer(jobs.bind(fn), ms);
    schedule = (fn, ms) => interval(jobs.bind(fn), ms);
  }
  if (activity !== undefined && typeof activity?.check !== 'function') throw new TypeError('Evaluator activity eligibility required');
  if (readMetadata !== undefined && (typeof readMetadata !== 'function' || typeof metadataCurrent !== 'function' || typeof readSource !== 'function')) throw new TypeError('Trusted evaluator metadata readers required');
  if (workerState !== undefined && typeof workerState !== 'function') throw new TypeError('Trusted evaluator worker state required');
  if (typeof readinessObservation !== 'boolean') throw new TypeError('Explicit readiness observation selection required');
  if (readStamps !== undefined && typeof readStamps !== 'function') throw new TypeError('Evaluator change-stamp reader must be a function');
  if(typeof dynamic!=='boolean' || !Number.isSafeInteger(maxTenants) || maxTenants<1)throw new TypeError('Explicit dynamic tenant bound required');
  if (typeof externalRecovery !== 'boolean' || !Number.isSafeInteger(checkBatchSize) || checkBatchSize < 1 || checkBatchSize > 1024) throw new TypeError('Bounded evaluator recovery required');
  tenants = [...tenants];
  let nextGeneration = 0;
  function generation () {
    if (nextGeneration === Number.MAX_SAFE_INTEGER) throw new Error('EVALUATOR_GENERATION_EXHAUSTED');
    return ++nextGeneration;
  }
  const makeState = tenant => ({ metadataPauses: 0, metadataEpoch: {}, decisions: new Set(), tenant, createdAt: now(), instance: null, identity: null, sourceIdentity: null,
    last: null, observation: null, covered: null, revision: 0, generation: generation(), completedAcquisitions: 0, completedTimeCycles: 0, lastCompletedAt: null, failedCompletions: 0, acquired: false, code: 'EVALUATOR_STARTING', pendingAcquire: false, pendingTime: false, acquireTicket: null, timeTicket: null, parentAcquireTicket: null, parentTimeTicket: null, lastKind: null, running: null, runningParent: null, cycles: 0,
    evaluating: false, activity: null, inactive: false, reactivated: false, withdrawn: false,
    processed: null, dueTimer: null, dueAt: null, dueReason: null, evicted: false, changedAt: null, recheck: null, recheckParent: null,
    pendingSince: null, pendingEpoch: 0, pendingMarks: [], current: null, confirmedAt: null, booting: false, alerting: false, checking: false,
    releasedAcquisition:null, releasedScopeReceipt:null, failureReasons: failureReasons.empty(), lastFailureReason: null, unresolvedFailure: null, maxFailureResolutionMs: null });
  const states = new Map(tenants.map(tenant => [tenant,makeState(tenant)]));
  const residents = new Map();
  let memorySlots = residentLimit; const memoryWaiting = [];
  const takeMemory = () => memorySlots > 0 ? (memorySlots--, Promise.resolve()) : new Promise(resolve => memoryWaiting.push(resolve));
  const giveMemory = () => { const next = memoryWaiting.shift(); if (next) next(); else memorySlots++; };
  const pendingExpired = state => !!durable && state.pendingSince !== null && now()-state.pendingSince >= (durable.pendingMs ?? evaluationAlertMs) && !state.inactive && !state.withdrawn;
  const workerEpoch = () => workerState ? workerState() : { available: true, generation: 0 };
  const workerReady = state => { const epoch = workerEpoch(); return epoch.available && !state?.metadataPauses && (state?.workerGeneration === undefined || state.workerGeneration === epoch.generation); };
  function assertWorker (epoch) { const current = workerEpoch(); if (!current.available || current.generation !== epoch.generation) throw failureReasons.workerRefusal(epoch, current); }
  const counters = { passes: 0, checks: 0, unchanged: 0, acquisitionsByCheck: 0, checksRefused: 0, stampReads: 0, stampReadsRefused: 0,
    wakes: 0, duplicateWakes: 0, dueFires: 0, evictions: 0 };
  // Backstop checks (and the acquisitions they start) hold one of
  // checkConcurrency slots: N tenants never queue N callers on a pool whose
  // connect timeout would refuse the excess (measured: 1,000 at once refused 817).
  let slots = checkConcurrency; const waiting = [];
  const take = () => (slots > 0 ? (slots--, Promise.resolve()) : new Promise(resolve => waiting.push(resolve)));
  const give = () => { const next = waiting.shift(); if (next) next(); else slots++; };
  let closed = false, closing;
  const timers = [], cleanupErrors = [];
  function closeComponent (instance) { try { instance.close(); } catch (error) { cleanupErrors.push(error); } }
  // The resident cache is independent of the roster. Only running evaluations
  // may exceed this idle bound, while a memory slot is held; residentLimit also bounds these cycles.
  function trimResidents (target = residentLimit) {
    if (residentLimit === undefined) return;
    for (const [tenant, state] of residents) {
      if (residents.size <= target) break;
      if (state.evaluating) continue;
      residents.delete(tenant);
      if (state.instance) closeComponent(state.instance);
      state.instance = null; state.last = null; state.evicted = true;
      counters.evictions++;
    }
  }
  function rememberResident (state) {
    if (residentLimit === undefined) return;
    residents.delete(state.tenant); residents.set(state.tenant, state); trimResidents();
  }
  function observation (last) {
    const bg = last.result?.properties?.bgnow;
    const instant = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    return Object.freeze({ identity:last.identity, runtimeId:last.runtimeId, contentDigest:last.contentDigest,
      outputRevision:last.outputRevision, inputCheckpoint:last.inputCheckpoint,
      hasNotifications:Array.isArray(last.result?.requested) && last.result.requested.some(row => row?.kind === 'notify'),
      retainedModelAt:instant(last.result?.now), bgNow:Object.freeze({ meanPresent:!!bg && Object.hasOwn(bg,'mean'),
        meanFinite:typeof bg?.mean === 'number' && Number.isFinite(bg.mean), mills:instant(bg?.mills) }) });
  }
  function cachedEligible (state) {
    return !!state && !pendingExpired(state) && workerReady(state) && !state.inactive && !state.withdrawn &&
      (!operationWindow || operationWindow.current(state.tenant)) && !closed && state.acquired && state.code === null;
  }
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
    if(durable)return; // one durable earliest-due scheduler owns physical timers
    const timer = setTimer(() => {
      if (state.dueTimer !== timer) return;
      state.dueTimer = null;
      if (reason === 'evict') { evict(state, at, result); return; }
      counters.dueFires++;
      trigger(state.tenant, false).catch(() => {});
    }, Math.min(2147483647, Math.max(0, Math.ceil(next - now()))));
    state.dueTimer = timer;
  }
  // Release an idle tenant's retained input; keep its output, signature and timer.
  function evict (state, at, result) {
    if (closed || state.running || !state.instance || typeof state.instance.evict !== 'function') { arm(state, at, result); return; }
    state.instance.evict(); state.evicted = true; counters.evictions++;
    arm(state, at, result);
  }
  function discard (state) {
    state.releasedAcquisition = null;
    state.releasedScopeReceipt = null;
    state.generation = generation(); state.processed = null; state.evicted = false; disarm(state);
    const previous = state.instance;
    state.instance = null; state.covered = null; state.current = null; state.identity = null; state.sourceIdentity = null; state.last = null; state.observation = null; state.acquired = false;
    residents.delete(state.tenant);
    if (previous) closeComponent(previous);
  }
  const parentOf = tenant => operationWindow ? require('../../tenant-lifecycle/operation-window').schedulingParent(operationWindow, tenant) : null;
  const parentBusy = () => Object.assign(new Error('EVALUATOR_JOB_PARENT_BUSY'), { code: 'EVALUATOR_JOB_PARENT_BUSY' });
  async function drain (state, parent) {
    while (!closed && !state.metadataPauses) {
      if (!parent) await take();
      if (closed || state.metadataPauses) { if (!parent) give(); return; }
      const acquireKey = parent ? 'parentAcquireTicket' : 'acquireTicket';
      const timeKey = parent ? 'parentTimeTicket' : 'timeTicket';
      const acquire = state[acquireKey]?.parent === parent;
      const time = state[timeKey]?.parent === parent;
      if (!acquire && !time) { if (!parent) give(); return; }
      const acquireSelected = acquire && (!time || state.lastKind !== 'acquisition');
      state.lastKind = acquireSelected ? 'acquisition' : 'time-only';
      const ticketKey = acquireSelected ? acquireKey : timeKey;
      // TIME is meaningful only after a successful input acquisition, even if
      // this ticket was queued before a restore/config/epoch transition.
      const acquisition = acquireSelected || !state.acquired || !state.instance || state.evicted || !workerReady(state);
      const ticket = state[ticketKey]; state[ticketKey] = null;
      state.pendingAcquire = !!(state.acquireTicket || state.parentAcquireTicket);
      state.pendingTime = !!(state.timeTicket || state.parentTimeTicket);
      const attempt = failureTrace?.start(state.generation, acquisition, operationWindow);
      const dispatch = { receipt:null, refusal:null };
      let memory = false;
      try {
        if (activity && !await eligible(state)) continue;
        if (residentLimit !== undefined) { await takeMemory(); memory = true; if (closed) continue; }
        state.evaluating = true;
        // Only a successful, still-current cycle whose fresh window has fully
        // released earns completion credit. Legacy cycles counts entered work.
        const borrowed = !!parent;
        const runCycle = () => cycle(state, acquisition, borrowed, attempt, dispatch);
        if (attempt) attempt.phase = 'window-entry';
        const completed = operationWindow
          ? await operationWindow.run(state.tenant, attempt ? () => attempt.run(runCycle) : runCycle,
            !borrowed ? { onScope:receipt => { dispatch.receipt = receipt; } } : undefined)
          : await runCycle();
        if (attempt) attempt.phase = 'credit';
        if (operationWindow && completed && !borrowed && operationWindow.readinessReceiptCurrent(dispatch.receipt) && !closed && states.get(state.tenant) === state &&
            completed.generation === state.generation && !state.inactive && !state.withdrawn && state.code === null) {
          creditCompletion(state, completed.acquisition);
          // Observation only, after the successful owned outer release. A
          // legacy default worker or a time-only completion cannot mint proof.
          if (completed.acquisition && dispatch.receipt && workerState && require('../../tenant-lifecycle/operation-window').isWindow(operationWindow) && Number.isSafeInteger(state.workerGeneration) && state.workerGeneration >= 0) {
            state.releasedAcquisition = Object.freeze({ tenant:state.tenant, runtimeId, generation:state.generation,
              workerGeneration:state.workerGeneration, identity:state.identity, sourceIdentity:state.sourceIdentity,
              settingsVersion:state.current?.settingsVersion ?? null, policyGeneration:state.current?.policyGeneration ?? null });
            state.releasedScopeReceipt = dispatch.receipt;
          }
        } else if (operationWindow && !borrowed && !state.inactive && !state.withdrawn && state.code !== 'EVALUATOR_TENANT_DISABLED') {
          countFailure(state, dispatch.refusal ? reasonOf(state, dispatch.refusal) : 'unknown');
          failureTrace?.failure('no-credit', attempt, state, { selected:state.lastKind, borrowed, closed,
            current:states.get(state.tenant) === state, completed, reason:state.lastFailureReason, refusal:dispatch.refusal });
        }
      } catch (error) {
        if (!operationWindow) throw error;
        countFailure(state, reasonOf(state, error));
        failureTrace?.failure('dispatch-exception', attempt, state, { selected:state.lastKind, borrowed:!!parent, closed,
          current:states.get(state.tenant) === state, error, operationWindow, reason:state.lastFailureReason });
        discard(state); state.code = 'EVALUATOR_WINDOW_REFUSED';
      } finally { state.evaluating = false; trimResidents(); if (memory) giveMemory(); if (!parent) give(); ticket.resolve(); }
    }
  }
  async function cycle (state, acquisition, borrowed, attempt, dispatch) {
    attempt?.at('worker-admission');
    let current, observed;
    const worker = workerEpoch();
    const readingGeneration = state.generation, pendingEpoch = state.pendingEpoch;
    try {
      assertWorker(worker);
      if (acquisition && readMetadata && !borrowed && !durable) {
        attempt?.at('metadata-read');
        const endSettings = metrics.phase('settings');
        try { await readMetadata([state.tenant]); } finally { endSettings(); }
      }
      if (durable) {
        attempt?.at('durable-begin');
        const endBegin = metrics.phase('begin');
        try { observed = await durable.begin(state.tenant); } finally { endBegin(); }
        // A timer selected before new input arrived cannot certify that new
        // version using retained older rows. Join it as an acquisition instead.
        if (!acquisition && canonical(observed) !== canonical(state.covered)) {
          acquisition = true;
          if (attempt) attempt.effectiveKind = 'acquisition';
        }
      }
      attempt?.at('current-config');
      const row = metadataCurrent?.(state.tenant);
      const reuse = readMetadata && !acquisition && state.current && row &&
        state.current.settingsVersion === row.settings && state.current.policyGeneration === row.policy &&
        readSource(state.tenant) === state.current.sourceIdentity;
      if (reuse) current = state.current;
      else { const endSettings = metrics.phase('settings'); try { current = await readCurrent(state.tenant); } finally { endSettings(); } }
    }
    catch (error) {
      attempt?.refused(error); dispatch.refusal = error;
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
        state.generation = generation(); state.last = null; state.observation = null; state.acquired = false;
        attempt?.at('component-reconfigure');
        state.instance.reconfigure({ env: current.env });
        state.identity = current.identity;
        state.acquired = wasAcquired;
      }
      if (!state.instance || current.identity !== state.identity) {
        acquisition = true;
        if (attempt) attempt.effectiveKind = 'acquisition';
        discard(state);
        const creatingGeneration = state.generation;
        state.identity = current.identity; state.sourceIdentity = current.sourceIdentity || null; // current target, including async creation
        if (residentLimit !== undefined) trimResidents(residentLimit - 1);
        attempt?.at('component-create');
        if (attempt) attempt.cycleGeneration = creatingGeneration;
        const instance = await create(current);
        if (closed || creatingGeneration !== state.generation) { closeComponent(instance); return; }
        state.instance = instance;
      }
      rememberResident(state);
      state.current = current;
      cycleGeneration = state.generation;
      if (attempt) attempt.cycleGeneration = cycleGeneration;
      attempt?.at('evaluate');
      const at = now();
      // Executor-call spans include its own reads and computation, but exclude
      // queue/admission/config waits and the separate durable completion call.
      // Histograms count attempted calls, including calls that reject.
      const endExecute = diagnostics.time(acquisition ? 'evaluator.execute_acquisition' : 'evaluator.execute_time');
      const endPhase = metrics.phase(acquisition ? 'acquisition' : 'time');
      let result;
      try {
      try { result = await (acquisition ? state.instance.evaluate({ at }) : state.instance.evaluateTime({ at })); }
      finally { endExecute(); }
      } finally { endPhase(); }
      if (closed || cycleGeneration !== state.generation) return; // generation and shutdown fence late results
      attempt?.at('worker-recheck');
      assertWorker(worker);
      // A pause committed while this cycle ran must not publish its output.
      if (activity) {
        attempt?.at('activity-recheck');
        if (!await eligible(state) || cycleGeneration !== state.generation) return;
      }
      // No acquired or completed RAM floor moves before durable clinical
      // completion. The hook commits observed versions, output and due together.
      let committed = null;
      if (durable) {
        attempt?.at('durable-complete');
        const endDurable = diagnostics.time('evaluator.durable_complete'), endCompletion = metrics.phase('completion');
        try {
        try { committed = await durable.complete(state.tenant, { observed, identity:state.identity, result, retainedOutput:state.last }); }
        finally { endDurable(); }
        } finally { endCompletion(); }
      }
      if (closed || cycleGeneration !== state.generation) return;
      attempt?.at('publish');
      assertWorker(worker); state.workerGeneration = worker.generation;
      if(durable)state.covered=Object.freeze({...observed});
      if (acquisition) {
        state.acquired = true; state.reactivated = false; state.evicted = false;
        const seen = validSignature(result?.signature);
        if (!same(state.processed, seen)) state.changedAt = at;
        state.processed = seen;
      }
      if(committed){
        // Input marked during this cycle stays pending unless a later
        // completion covers it; the durable read reports the rest. The
        // earlier of the two is the oldest input this tenant still owes.
        state.pendingMarks=state.pendingMarks.filter(mark=>mark.epoch>pendingEpoch);
        const marked=state.pendingMarks.length?Math.min(...state.pendingMarks.map(mark=>mark.at)):null, durableAt=committed.pendingAt ?? null;
        state.pendingSince=marked===null?durableAt:durableAt===null?marked:Math.min(marked,durableAt);
        stages.fromEnvironment().record('evaluator.complete',{tenant:state.tenant,covered:observed?.clock??null,outputRevision:committed.output?.outputRevision??null,changed:!!committed.changed});
      }
      state.cycles++; confirm(state);
      arm(state, at, result);
      // Identical content keeps the revision and the same frozen output object.
      // A pause clears state.last, so the first output after unpause is a new revision.
      const content = committed ? committed.output.contentDigest : contentDigest(result);
      const changed = committed ? committed.changed || !(state.last || state.observation) : !state.last || state.last.identity !== state.identity || state.content !== content;
      if (committed) {
        state.content=content;state.revision=committed.output.outputRevision;
        state.last=Object.freeze({...committed.output,runtimeId});
      } else if (changed) {
        state.content = content;
        state.last = Object.freeze({ identity: state.identity, runtimeId, outputRevision: ++state.revision, contentDigest: content,
          inputCheckpoint: result.checkpoint, trigger: acquisition ? 'acquisition' : 'time-only', result });
      }
      if (residentLimit !== undefined && state.last) state.observation = observation(state.last);
      rememberResident(state);
      state.code = state.acquired ? null : 'EVALUATOR_ACQUISITION_REQUIRED';
      if (changed && onRevision) { try { onRevision(state.tenant); } catch { /* a wake never fails a clinical cycle */ } }
      return { generation: cycleGeneration, acquisition };
    } catch (error) {
      attempt?.refused(error); dispatch.refusal = error;
      if (error.message === 'TRUSTED_WORKER_UNAVAILABLE') { discard(state); state.code = 'EVALUATOR_WORKER_UNAVAILABLE'; return; }
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
    state.inactive = true; if (state.watchTimer) clearTimer(state.watchTimer); state.watchTimer = null; state.alerting = false; state.generation = generation(); state.last = null; state.observation = null; state.acquired = false; state.processed = null; disarm(state);
    state.pendingAcquire = false; state.pendingTime = false;
    for (const key of ['acquireTicket', 'timeTicket', 'parentAcquireTicket', 'parentTimeTicket']) { if (state[key]) state[key].resolve(); state[key] = null; }
    Promise.resolve(state.running).then(() => { if (state.inactive) discard(state); });
  }
  async function eligible (state, cached, current = () => true) {
    if (!activity) return true;
    const checked = cached === undefined ? await activity.check('evaluator', state.tenant) :
      { state: cached?.state || null, eligible: !!cached && require('../../tenant-activity/policy').eligible('evaluator', cached.state), code: cached ? 'TENANT_' + cached.state.toUpperCase() : 'ACTIVITY_NOT_PROVISIONED' };
    if (closed || !current()) return false;
    if (!checked.eligible) { deactivate(state, checked); return false; }
    state.activity = checked.state;
    // Reactivation recomputes from current data: the next cycle is a full
    // acquisition on a fresh component, whatever triggered it.
    if (state.inactive) { state.inactive = false; state.reactivated = true; discard(state); state.code = 'EVALUATOR_ACQUISITION_REQUIRED'; if (externalRecovery && !durable) armWatch(state); }
    return true;
  }
  function pump (state, parent = null) {
    if (state.running || state.metadataPauses) return;
    state.runningParent = parent;
    const run = () => drain(state, parent);
    const finish = () => {
      state.running = null; state.runningParent = null; trimResidents();
      if (!closed && (state.pendingAcquire || state.pendingTime)) {
        // Borrowed tickets may only run in their original active parent, never
        // be laundered into a trusted continuation after that parent returned.
        if (parent && (state.parentAcquireTicket?.parent === parent || state.parentTimeTicket?.parent === parent)) {
          let active = false; try { active = parentOf(state.tenant) === parent; } catch { /* expired parent remains refused */ }
          if (active) { pump(state, parent); return; }
        }
        for (const key of ['parentAcquireTicket','parentTimeTicket']) if (state[key]) {
          state[key].reject(parentBusy()); state[key] = null;
          state.pendingAcquire = !!state.acquireTicket; state.pendingTime = !!state.timeTicket;
        }
        if (state.pendingAcquire || state.pendingTime) pump(state);
      }
    };
    state.running = (jobs && !parent ? jobs.run(run) : run()).catch(() => { state.acquired = false; state.code = 'EVALUATOR_JOB_REFUSED'; })
      .then(jobs && !parent ? jobs.bind(finish) : finish);
  }
  function trigger (tenant, acquisition) {
    if (closed) return Promise.reject(new Error('Evaluator runtime is closed'));
    let parent; try { parent = parentOf(tenant); } catch (error) { return Promise.reject(error); }
    const state = states.get(tenant);
    if (!state) return Promise.reject(new Error('Evaluator tenant is not configured'));
    if (parent && state.running && state.runningParent !== parent) return Promise.reject(parentBusy());
    if (workerState && !workerReady(state)) acquisition = true;
    return enqueue(state, acquisition, parent);
  }
  // At most two owned and two borrowed pending tickets per tenant. A parent
  // can coalesce only with itself; it never waits on independent work that
  // may need the one physical client it is already holding.
  function enqueue (state, acquisition, parent = null) {
    if (closed) return Promise.resolve();
    if (state.reactivated || state.evicted || !state.acquired || !state.instance || !workerReady(state)) acquisition = true;
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
  async function all (acquisition) {
    return Promise.all([...states.keys()].map(tenant => trigger(tenant, acquisition)));
  }
  // The one entry point: has this tenant changed since its processed signature?
  // `stamps` (a backstop pass with readStamps): the pair read for every tenant
  // at the start of the pass; otherwise the component reads its own.
  function check (state, stamps, parent = null, row, forceSettings = false) {
    if (closed || state.metadataPauses) return Promise.resolve();
    const decision = decide(state, stamps, parent, row, forceSettings);
    state.decisions.add(decision);
    return decision.finally(() => { state.decisions.delete(decision); }).then(value => value?.deferred || (value === true ? enqueue(state, true, parent) : undefined));
  }
  async function decide (state, stamps, parent, row, forceSettings) {
    if (closed || state.metadataPauses) return;
    if (activity && !await eligible(state, row === undefined ? undefined : row?.activity || null)) return;
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
      return {deferred:state.recheck};
    }
    counters.checks++;
    if (!workerReady(state) || !state.acquired || !state.instance || !state.processed || (!stamps && !row && typeof state.instance.signature !== 'function')) {
      counters.acquisitionsByCheck++; return true;
    }
    const generation = state.generation;
    let current, seen;
    // A refused read is not a change: the next pass retries it, and a tenant
    // that stays unreadable is reported by the evaluation-gap alert.
    const unchangedSettings = readMetadata && row && !forceSettings && state.current &&
      state.current.settingsVersion === row.settings && state.current.policyGeneration === row.policy &&
      readSource(state.tenant) === state.current.sourceIdentity;
    try { current = unchangedSettings ? state.current : await readCurrent(state.tenant); } catch { counters.checksRefused++; return; }
    if (closed || generation !== state.generation) return;
    if (!current || current.identity !== state.identity) { counters.acquisitionsByCheck++; return true; }
    if (!unchangedSettings) state.current = current;
    if (row) seen = row.signature;
    else if (stamps) seen = stamps.get(state.tenant) ?? null;
    else { try { seen = await state.instance.signature(); } catch { counters.checksRefused++; return; } }
    if (closed || generation !== state.generation || !state.processed) return;
    if (same(state.processed, validSignature(seen))) { counters.unchanged++; confirm(state); return; }
    counters.acquisitionsByCheck++;
    return true;
  }
  // The D6 backstop: one membership read, then every configured tenant's check.
  // In flight per tenant, not per pass: a tenant whose check hangs holds only
  // itself (and is reported by the evaluation-gap alert), never the others.
  async function pass (selected = tenants, parents, { recovery = false } = {}) {
    if (!Array.isArray(selected) || selected.some(t => !states.has(t))) throw new TypeError('Known evaluator tenants required');
    const selectedStates = selected.map(t => states.get(t));
    if (closed) return;
    counters.passes++;
    if (closed) return;
    // One statement for the whole member (decision change-stamp-definer-function).
    // A refused read is not a change: no tenant is checked this pass, the next
    // pass retries, and a tenant that stays unchecked is reported by the
    // evaluation-gap alert.
    const passEpoch = workerEpoch();
    let stamps, metadata;
    if (readMetadata) {
      const wanted = selectedStates.map(state => state.tenant);
      // Recovery invalidates settings revisions. Drain only this selected
      // page before that invalidation, so it cannot obsolete an entered cycle's
      // settings read. Other tenants keep their dispatch and clinical progress.
      if (recovery) for (const state of selectedStates) { state.metadataPauses++; state.metadataEpoch = {}; }
      try {
        if (recovery) await Promise.allSettled(selectedStates.flatMap(state => [...state.decisions, state.running]));
        if (closed) return;
        try { metadata = await readMetadata(wanted, { recovery }); } catch (error) { counters.stampReadsRefused++; throw error; }
        counters.stampReads++;
      } finally {
        if (recovery) for (const state of selectedStates) {
          state.metadataPauses--;
          if (!closed && (state.pendingAcquire || state.pendingTime)) pump(state);
        }
      }
    }
    if (readStamps && !readMetadata) {
      const wanted = selectedStates.filter(state => !state.withdrawn && !state.inactive).map(state => state.tenant);
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
    await require('./tenant-startup').limited(selectedStates, checkConcurrency, state => {
      if (state.checking) return null;
      state.checking = true;
      return check(state, stamps, parents?.get(state.tenant) || null, metadata?.get(state.tenant), recovery).catch(() => {}).finally(() => { state.checking = false; });
    });
    if (readMetadata) assertWorker(passEpoch);
  }
  const runtime = {
    get runtimeId () { return runtimeId; },
    // Private selected cached facts only. No eligibility/output/metadata read,
    // admission, repair or work is performed here. The separate witness owns
    // three-state interpretation; stock health keeps its expiry precedence.
    readinessFacts (selected) {
      if (!Array.isArray(selected) || !selected.length || selected.length > 128 || new Set(selected).size !== selected.length || selected.some(tenant => !states.has(tenant))) {
        throw new Error('EVALUATOR_READINESS_SELECTION_REFUSED');
      }
      return { runtimeId, observedAt:now(), closed, tenants:selected.map(tenant => {
        const state = states.get(tenant);
        return { tenant, generation:state.generation, acquired:state.acquired, code:state.code,
          inactive:state.inactive, withdrawn:state.withdrawn, booting:state.booting, running:!!state.running,
          metadataPaused:!!state.metadataPauses, verificationPending:false,
          identity:state.identity, sourceIdentity:state.sourceIdentity,
          settingsVersion:state.current?.settingsVersion ?? null, policyGeneration:state.current?.policyGeneration ?? null,
          pendingSince:state.pendingSince, pendingBoundMs:durable?.pendingMs ?? evaluationAlertMs,
          proof:state.releasedAcquisition ? { ...state.releasedAcquisition,
            windowCurrent:operationWindow?.readinessReceiptCurrent?.(state.releasedScopeReceipt) ?? null } : null };
      }) };
    },
    markPending(tenant,at=now()){const state=states.get(tenant);if(!state||closed)return;if(!Number.isSafeInteger(at)||at<0)at=now();state.pendingEpoch++;state.pendingSince=state.pendingSince===null?at:Math.min(state.pendingSince,at);
      // Bounded: merging keeps the later epoch and the older instant, so a
      // merged mark can only make the pending age older, never hide input.
      state.pendingMarks.push({epoch:state.pendingEpoch,at});if(state.pendingMarks.length>64){const [a,b]=state.pendingMarks.splice(0,2);state.pendingMarks.unshift({epoch:b.epoch,at:Math.min(a.at,b.at)});}},
    // Aggregate pending work for the metrics scrape: in memory, no SQL, no
    // tenant id leaves this function.
    pendingSummary(){let pending=0,queued=0,oldest=null;const at=now();
      for(const s of states.values()){if(s.inactive||s.withdrawn)continue;
        if(s.pendingSince!==null){pending++;if(oldest===null||s.pendingSince<oldest)oldest=s.pendingSince;}
        if(s.pendingAcquire||s.pendingTime||s.running)queued++;}
      return {tenants:states.size,pending,queued,oldestAgeMs:oldest===null?0:Math.max(0,at-oldest)};},
    // In-memory pending witness for selected tenants: no SQL, no scheduling.
    pendingWitness(selected){if(!Array.isArray(selected)||!selected.length||selected.length>128||new Set(selected).size!==selected.length||selected.some(tenant=>!states.has(tenant)))throw new Error('Evaluator pending witness selector refused');
      return selected.map(tenant=>{const s=states.get(tenant);return {tenant,memory:{pendingSince:s.pendingSince,pendingEpoch:s.pendingEpoch,marksDuringCycle:s.pendingMarks.length,pendingAgeMs:s.pendingSince===null?null:Math.max(0,now()-s.pendingSince),expired:pendingExpired(s)}};});},
    addTenant (tenant) {
      if (!dynamic || closed || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tenant) || states.size >= maxTenants && !states.has(tenant)) throw new Error('Dynamic evaluator tenant refused');
      if (states.has(tenant)) return;const state=makeState(tenant);states.set(tenant,state);tenants.push(tenant);if(externalRecovery&&!durable)armWatch(state);
    },
    async removeTenant (tenant) {
      if (!dynamic) throw new Error('Dynamic evaluator tenant refused');const state=states.get(tenant);if(!state)return;
      state.generation = generation();state.inactive=true;state.withdrawn=true;state.pendingAcquire=false;state.pendingTime=false;disarm(state);if(state.watchTimer)clearTimer(state.watchTimer);
      for(const key of ['acquireTicket','timeTicket','parentAcquireTicket','parentTimeTicket']){state[key]?.resolve();state[key]=null;}states.delete(tenant);const index=tenants.indexOf(tenant);if(index>=0)tenants.splice(index,1);
      await Promise.allSettled([state.running]);discard(state);
    },
    async invalidateTenant (tenant, { restoring = false } = {}) {
      const state = states.get(tenant);
      if (!state || closed) throw new Error('Evaluator tenant is not configured');
      // An entered cycle compares its generation after compute and after
      // durable completion. Restore retires its output while it still owns
      // its scheduler slot. Recovery keeps its existing physical drain.
      if (restoring) {
        state.metadataEpoch = {};
      } else {
        while (state.running) await state.running;
      }
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
    backstop (selected = tenants, options) {
      try {
        const parents = new Map(selected.map(tenant => [tenant,parentOf(tenant)]));
        for (const [tenant,parent] of parents) if (parent && states.get(tenant)?.running && states.get(tenant).runningParent !== parent) throw parentBusy();
        return pass(selected, parents, options);
      } catch (error) { return Promise.reject(error); }
    },
    async isCurrent (tenant, identity) {
      if (closed || !states.has(tenant) || !workerReady(states.get(tenant)) || pendingExpired(states.get(tenant))) return false;
      const state = states.get(tenant), checkingEpoch = workerEpoch(), metadataEpoch = state.metadataEpoch;
      const sameEpoch = () => { const current=workerEpoch(); return current.available && current.generation===checkingEpoch.generation && !state.metadataPauses && state.metadataEpoch===metadataEpoch; };
      try {
        if (readMetadata) await readMetadata([tenant]);
        if (closed || !sameEpoch()) return false;
        if (activity && !await eligible(state, undefined, () => sameEpoch())) return false;
        const row = metadataCurrent?.(tenant);
        // The fresh metadata read above owns currentness. Reuse only this
        // runtime's configuration at the exact persisted and registry versions.
        const unchanged = readMetadata && row && state.current &&
          state.current.settingsVersion === row.settings && state.current.policyGeneration === row.policy &&
          readSource(tenant) === state.current.sourceIdentity;
        const current = unchanged ? state.current : await readCurrent(tenant);
        if (closed || !sameEpoch()) return false;
        if (!current || current.tenant !== tenant || current.identity !== identity) {
          // An old caller must not retire a newer, already-current context.
          if (!current || current.tenant !== tenant || state.identity !== current.identity) {
            const settingsOnly = current && current.tenant === tenant &&
              typeof current.sourceIdentity === 'string' && current.sourceIdentity === state.sourceIdentity &&
              typeof state.instance?.reconfigure === 'function';
            if (settingsOnly) { state.generation = generation(); state.last = null; state.observation = null; }
            else discard(state);
            state.code = 'EVALUATOR_CONFIG_CHANGED';
          }
          return false;
        }
        return workerReady(state);
      } catch { if (sameEpoch()) { discard(state); state.code = 'EVALUATOR_CONFIG_REFUSED'; } return false; }
    },
    health (selected) {
      const rows = selected === undefined ? [...states.values()] : selected.map(tenant => {
        const state = states.get(tenant); if (!state) throw new Error('Evaluator tenant is not configured'); return state;
      });
      return { runtimeId, closed, tenants: rows.map(s => ({ tenant: s.tenant,
      ready: !closed && workerReady(s) && s.acquired && s.code === null && !pendingExpired(s), code: pendingExpired(s) ? 'EVALUATOR_CLINICAL_PROGRESS_STALLED' : s.code, identity: s.identity,
      ...(activity ? { activity: s.activity } : {}),
      progress: { generation: s.generation, completedAcquisitions: s.completedAcquisitions, completedTimeCycles: s.completedTimeCycles,
        lastCompletedAgeMs: s.lastCompletedAt === null ? null : Math.max(0, now() - s.lastCompletedAt), failedCompletions: s.failedCompletions,
        // Contract evaluator-failure-reasons-v1: counts by closed reason sum to
        // failedCompletions; the oldest unresolved failure and the longest
        // failure-to-credited-completion interval in this process.
        failureReasons: { ...s.failureReasons },
        unresolvedFailure: s.unresolvedFailure === null ? null : { reason: s.unresolvedFailure.reason, ageMs: Math.max(0, now() - s.unresolvedFailure.at) },
        maxFailureResolutionMs: s.maxFailureResolutionMs },
      outputRevision: (s.last || s.observation)?.outputRevision || null, inputCheckpoint: (s.last || s.observation)?.inputCheckpoint ?? null, cycles: s.cycles,
      // Clinical work only: a read-only signature/backstop check is not a
      // queued evaluation. running spans the complete selected operation window.
      jobs: { running: !!s.running, booting: s.booting, acquire: !!s.acquireTicket, time: !!s.timeTicket, parentAcquire: !!s.parentAcquireTicket, parentTime: !!s.parentTimeTicket },
      dueAt: s.dueAt, dueReason: s.dueReason, evicted: s.evicted, booting: s.booting,
      evaluatedAgeMs: closed ? null : now() - (s.confirmedAt ?? s.createdAt), alert: s.alerting ? 'EVALUATOR_NOT_EVALUATED_WITHIN_BOUND' : null })),
    alerts: rows.filter(s => s.alerting || pendingExpired(s)).map(s => ({ tenant: s.tenant, code: pendingExpired(s) ? 'EVALUATOR_CLINICAL_PROGRESS_STALLED' : 'EVALUATOR_NOT_EVALUATED_WITHIN_BOUND' })),
    boot, wake: { ...counters } }; },
    // Cached observation only: this does not read current authority or call
    // last(), whose operation-window guard remains mandatory for consumers.
    // No clinical work, scheduling, or source reads occur on this path.
    clinicalResults (selected) {
      if (!Array.isArray(selected) || !selected.length || selected.length > 128 ||
          new Set(selected).size !== selected.length || selected.some(tenant => !states.has(tenant))) {
        throw new Error('Evaluator clinical result selector refused');
      }
      return selected.map(tenant => {
        const s = states.get(tenant), last = s.last || s.observation, bg = s.last?.result?.properties?.bgnow;
        const instant = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
        return { tenant, status: !last ? 'no-model' :
          !closed && workerReady(s) && s.acquired && s.code === null && !s.inactive && !s.withdrawn && !pendingExpired(s) ? 'eligible-model' : 'retained-ineligible',
          generation: s.generation, outputRevision: last?.outputRevision ?? null, inputCheckpoint: last?.inputCheckpoint ?? null,
          lastCompletedAgeMs: s.lastCompletedAt === null ? null : Math.max(0, now() - s.lastCompletedAt),
          // Identical-content cycles retain the original result, including now.
          retainedModelAt: s.last ? instant(last.result?.now) : s.observation?.retainedModelAt ?? null,
          bgNow: !last ? null : !s.last ? s.observation.bgNow : { meanPresent: !!bg && Object.hasOwn(bg, 'mean'),
            meanFinite: typeof bg?.mean === 'number' && Number.isFinite(bg.mean), mills: instant(bg?.mills) } };
      });
    },
    // Scheduling/health needs only bounded primitive metadata. Alarm selection
    // loads a cold completed result through output(), never through raw history.
    peek (tenant) {
      const state = states.get(tenant), value = state?.observation || (state?.last && observation(state.last));
      return value ? Object.freeze({ ...value, eligible:cachedEligible(state) }) : null;
    },
    canReadColdOutput: tenant => !closed && states.get(tenant)?.code === 'EVALUATOR_STARTING',
    async output (tenant) {
      const state = states.get(tenant);
      if (!cachedEligible(state)) return null;
      if (state.last) { rememberResident(state); return Object.freeze({ ...state.last, eligible:true }); }
      if (!state.observation || typeof loadOutput !== 'function') return null;
      const generation = state.generation, expected = state.observation;
      const value = await loadOutput(tenant, state.identity);
      if (!cachedEligible(state) || state.generation !== generation || state.observation !== expected ||
          value?.identity !== expected.identity || value?.outputRevision !== expected.outputRevision ||
          value?.contentDigest !== expected.contentDigest || value?.inputCheckpoint !== expected.inputCheckpoint) return null;
      // A caller owns this transient output. Reading it does not admit a cold
      // clinical component or retain another fleet-sized full-output cache.
      return Object.freeze({ ...value, runtimeId, eligible:true });
    },
    cacheStats () { return { residentLimit:residentLimit ?? null, residents:residents.size,
      active:[...states.values()].filter(state => state.evaluating).length }; },
    last (tenant) {
      const state = states.get(tenant);
      if (!state || pendingExpired(state) || !workerReady(state) || !state.last || state.inactive || state.withdrawn || operationWindow && !operationWindow.current(tenant)) return null;
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
      }).finally(() => { jobs?.close(); failureTrace?.close(); });
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
    if (externalRecovery && !durable) armWatch(state);
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
  if (!durable && boot === 'all') await all(true); // first full acquisition before reporting preview readiness
  else if (!durable) {
    // Background boot: bounded, warm tenants first; the backstop leaves queued tenants alone.
    const queue = [...states.values()];
    for (const state of queue) state.booting = true;
    const next = () => {
      if (!isWarm) return queue.shift();
      const index = queue.findIndex(state => { try { return isWarm(state.tenant); } catch { return false; } });
      return queue.splice(index < 0 ? 0 : index, 1)[0];
    };
    const worker = async () => {
      for (let state = next(); state && !closed; state = next()) {
        try { if (!state.acquired || !state.instance || !workerReady(state) || state.code !== null) await trigger(state.tenant, true); } catch { /* a refused tenant is retried by the backstop */ }
        state.booting = false;
      }
    };
    Promise.all(Array.from({ length: Math.min(bootConcurrency, queue.length) }, worker))
      .finally(() => { for (const state of states.values()) state.booting = false; });
  }
  if (!externalRecovery) timers.push(schedule(() => { pass().catch(() => {}); }, recoveryIntervalMs));
  if(!durable){
    if (externalRecovery) for (const state of states.values()) armWatch(state);
    else timers.push(schedule(watch,Math.min(10000,Math.max(250,Math.floor(evaluationAlertMs/4)))));
  }
  return Object.freeze(runtime);
};
module.exports.contentDigest = contentDigest;
module.exports.CONTENT = CONTENT;

module.exports.canonical = canonical;
module.exports.recursiveCanonical = recursiveCanonical;
