'use strict';

const c = require('./contract');
// Level-triggered delivery (decision D23: realtime is a reader).
//
// Per tenant this process holds one cell: the output revision it last read
// (its frame's checkpoint), the settings identity it was read under, the
// frame, and the one read in flight. Nothing is owed, marked or acknowledged:
// a watched tenant whose durable output revision is above its cell's is read
// again, and the protocol sends each socket whatever frame it is behind
// (lib/server/realtime/protocol.js).
//
// Two triggers reach the same check: the evaluator's wake hint (immediacy) and
// a level pass every levelMs over the watched tenants (convergence after a
// lost hint, a failed read or a restart). A check is one batched revision
// read; a read of one tenant's output is single-flight with a deadline, at
// most `concurrency` at a time. No step of the process waits on a tenant: a
// slow or hung tenant delays only itself.
//
// An error changes no state except that the cell stays behind: its frame is
// withheld and a later pass tries again. Only a completed read that says the
// tenant is not eligible drops the cell (onIneligible).
const LEVEL_MS = 5000, FETCH_DEADLINE_MS = 30000, FLUSH_MS = 100, RESEND_MS = 250, BATCH = 1000, PRUNE_PASSES = 12;
const STAGES = Object.freeze(['fetch', 'prepare', 'send']);
const deadlineError = () => Object.assign(new Error('REALTIME_REFRESH_DEADLINE'), { code: 'REALTIME_REFRESH_DEADLINE' });
function bounded (work, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(deadlineError()), ms); timer.unref?.();
    Promise.resolve(work).then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
// Whether the durable revision is above the cell's. A cell without a frame is
// behind any completed revision; revision 0 is no completed output.
function behind (cell, revision) {
  if (revision === undefined) return true; // no revision reader: every check reads the output
  if (String(revision) === '0') return false;
  if (!cell.last) return true;
  try { return BigInt(String(revision)) > BigInt(String(cell.last.checkpoint)); } catch { return String(revision) !== String(cell.last.checkpoint); }
}
module.exports = async function start ({ tenants = [], readCurrent, readRevisions, create, fanout, watched = () => [], isWatched = () => true,
  lagging = () => [], onIneligible = () => {}, operationWindow, prepareTenant, concurrency = Infinity, levelMs = LEVEL_MS,
  fetchDeadlineMs = FETCH_DEADLINE_MS, flushMs = FLUSH_MS, maxTenants = 10000, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  if (!Array.isArray(tenants) || new Set(tenants).size !== tenants.length || tenants.some(id => !c.uuid(id)) ||
      [readCurrent, create, fanout, watched, isWatched, lagging, onIneligible, now, setTimer, clearTimer].some(fn => typeof fn !== 'function') ||
      readRevisions !== undefined && typeof readRevisions !== 'function' || prepareTenant !== undefined && typeof prepareTenant !== 'function') throw new TypeError('Realtime requires explicit bounded runtime dependencies');
  if (operationWindow !== undefined && [operationWindow.run, operationWindow.current].some(fn => typeof fn !== 'function')) throw new TypeError('Realtime operation window required');
  if (concurrency !== Infinity && !c.integer(concurrency)) throw new TypeError('Realtime refresh concurrency must be a positive integer');
  if (![levelMs, fetchDeadlineMs, flushMs].every(value => c.integer(value, 2147483647)) || !Number.isSafeInteger(maxTenants) || maxTenants < 1) throw new TypeError('Bounded realtime level pass required');
  const cells = new Map(), demand = new Set(), redeliver = new Set(), flights = new Set(), slots = [];
  let closed = false, passing = null, passes = 0, levelTimer = null, flushTimer = null, resendTimer = null, resendDelay = RESEND_MS, active = 0;
  // The inspection contract's keys: ticks are level passes, refreshes are
  // output reads, detected are batched revision reads.
  const counters = { ticks: 0, refreshes: 0, detected: 0, detectFailures: 0 };
  // Progress, O(1) to read: how many tenants have entered each stage, how
  // many are in it now, and the read deadlines met. A stall shows as a stage
  // whose `inflight` stays up; stageOf(tenant) names one tenant's last stage.
  const entered = { fetch: 0, prepare: 0, send: 0 }, inflight = { fetch: 0, prepare: 0, send: 0 };
  let deadlines = 0, skippedPasses = 0, backlog = { pending: 0, oldestAt: null };
  const makeCell = () => ({ epoch: 0, identity: null, last: null, checkedAt: null, component: null, inflight: null, again: false, stage: null, stageAt: null, active: false, behindSince: null, idle: false });
  // A cell is current while it is being kept level: read, or found not
  // behind, within two level intervals. A cell nobody watched since (or one
  // whose level reads keep failing) is not offered to a socket until the
  // next check has confirmed or replaced its frame.
  const kept = cell => cell.checkedAt !== null && now() - cell.checkedAt <= levelMs * 2;
  function cellOf (tenant) {
    let cell = cells.get(tenant);
    if (!cell) {
      if (closed || !c.uuid(tenant) || cells.size >= maxTenants) c.fail('REALTIME_DYNAMIC_TENANT_REFUSED');
      cell = makeCell(); cells.set(tenant, cell);
    }
    return cell;
  }
  function enter (cell, stage) {
    if (cell.active) inflight[cell.stage]--;
    cell.stage = stage; cell.stageAt = now(); cell.active = true; inflight[stage]++; entered[stage]++;
  }
  function leave (cell) { if (cell.active) { inflight[cell.stage]--; cell.active = false; } }
  function empty (cell) { cell.epoch++; cell.last = null; cell.checkedAt = null; cell.component = null; cell.identity = null; cell.behindSince = null; }
  function slot (fn) {
    return new Promise((resolve, reject) => {
      const run = () => { active++; let result; try { result = fn(); } catch (error) { result = Promise.reject(error); }
        Promise.resolve(result).then(resolve, reject).finally(() => { active--; slots.shift()?.(); }); };
      if (active < concurrency) run(); else slots.push(run);
    });
  }
  // One read of one tenant's settings and completed output, then the send.
  function refresh (tenant) {
    let cell;
    try { if (closed) c.fail('REALTIME_CLOSED_OR_UNKNOWN'); cell = cellOf(tenant); } catch (error) { return Promise.reject(error); }
    if (cell.inflight) return cell.inflight;
    const epoch = cell.epoch;
    const assertCurrent = () => { if (closed || cells.get(tenant) !== cell || cell.epoch !== epoch) c.fail('REALTIME_CYCLE_CHANGED'); };
    const cycle = async () => {
      enter(cell, 'fetch');
      const current = await readCurrent(tenant);
      assertCurrent();
      if (!current) { empty(cell); c.fail('REALTIME_TENANT_DISABLED'); }
      if (prepareTenant) { enter(cell, 'prepare'); await prepareTenant(tenant); assertCurrent(); enter(cell, 'fetch'); }
      if (!cell.component || cell.identity !== current.identity) { cell.last = null; cell.component = create(current); cell.identity = current.identity; }
      counters.refreshes++;
      const result = await cell.component.acquire({ at: now() });
      assertCurrent();
      const previous = cell.last, next = Object.freeze({ ...result, identity: current.identity }), availableAt = cell.behindSince;
      // The cell holds the frame from here. A send that fails leaves sockets
      // behind the cell, and they are sent it again (resend).
      cell.last = next; cell.checkedAt = now(); cell.behindSince = null;
      enter(cell, 'send');
      try { await fanout({ tenant, previous, next, assertCurrent, availableAt }); }
      catch (error) { if (cells.get(tenant) === cell && cell.last === next) { redeliver.add(tenant); armResend(); } throw error; }
      return next;
    };
    const flight = slot(() => {
      let work;
      try { work = Promise.resolve(operationWindow ? operationWindow.run(tenant, cycle) : cycle()); } catch (error) { work = Promise.reject(error); }
      return bounded(work, fetchDeadlineMs).catch(error => {
        // A read past its deadline gives up its cell: its late answer meets a
        // changed epoch and sends nothing.
        if (error?.code === 'REALTIME_REFRESH_DEADLINE') { deadlines++; if (cell.epoch === epoch) cell.epoch++; work.catch(() => {}); }
        if (require('../../tenant-lifecycle/generation-scope').isSuspension(error) && cell.epoch === epoch) empty(cell);
        throw error;
      });
    }).finally(() => {
      leave(cell); flights.delete(flight);
      if (cell.inflight === flight) cell.inflight = null;
      // Demand that arrived during this read is checked against what it read.
      if (cell.again) { cell.again = false; if (!closed && cells.get(tenant) === cell) request([tenant]); }
    });
    flight.catch(() => {});
    cell.inflight = flight; flights.add(flight);
    return flight;
  }
  // One batched revision read; each tenant behind it starts its own read.
  async function check (list) {
    if (closed || !list.length) return;
    let seen = null;
    // An answer read for a cell that was removed or replaced meanwhile says
    // nothing about its successor; the next check reads that one.
    const observed = new Map(list.map(tenant => [tenant, cells.get(tenant)]));
    if (readRevisions) {
      try { seen = await bounded(readRevisions(list), fetchDeadlineMs); counters.detected++; }
      catch (error) { counters.detectFailures++; throw error; }
      if (closed) return;
    }
    for (const tenant of list) {
      if (cells.get(tenant) !== observed.get(tenant)) continue;
      const row = seen?.get(tenant);
      if (seen && (!row || row.eligible === false)) {
        // A completed read that refuses the tenant: the only negative that drops a frame.
        const cell = cells.get(tenant); if (cell) empty(cell);
        try { onIneligible(tenant); } catch { /* an observer never fails a check */ }
        continue;
      }
      let cell;
      try { cell = cellOf(tenant); } catch { continue; }
      if (!behind(cell, row?.revision)) {
        // Confirmed current. Sockets that arrived while it was not offered are sent it now.
        if (cell.last && !kept(cell)) redeliver.add(tenant);
        cell.checkedAt = now(); cell.behindSince = null; continue;
      }
      if (cell.behindSince === null) cell.behindSince = now();
      if (cell.inflight) cell.again = true; else refresh(tenant).catch(() => {});
    }
  }
  function track (work) { const tracked = Promise.resolve(work).catch(() => {}).finally(() => flights.delete(tracked)); flights.add(tracked); return tracked; }
  // Sockets left behind a frame the cell already holds (a failed send, a slow
  // client, pool pressure while priming) are sent it again, with backoff up
  // to the level interval while the send keeps failing.
  function resend () {
    if (closed) return;
    const again = new Set([...redeliver, ...lagging()]); redeliver.clear();
    if (!again.size) { resendDelay = RESEND_MS; return; }
    for (const tenant of again) {
      const cell = cells.get(tenant);
      if (!cell?.last || cell.inflight) continue;
      const next = cell.last, epoch = cell.epoch;
      const send = async () => fanout({ tenant, previous: next, next, availableAt: null,
        assertCurrent: () => { if (closed || cells.get(tenant) !== cell || cell.epoch !== epoch || cell.last !== next) c.fail('REALTIME_CYCLE_CHANGED'); } });
      track(send().catch(() => { if (cells.get(tenant) === cell && cell.last === next) { redeliver.add(tenant); armResend(); } }));
    }
  }
  function armResend () {
    if (closed || resendTimer) return;
    resendTimer = setTimer(() => { resendTimer = null; resend(); }, resendDelay); resendTimer?.unref?.();
    resendDelay = Math.min(levelMs, resendDelay * 2);
  }
  function flush () {
    flushTimer = null;
    const list = [...demand]; demand.clear();
    const work = [];
    for (let i = 0; i < list.length; i += BATCH) work.push(check(list.slice(i, i + BATCH)).catch(() => {}));
    track(Promise.all(work).then(resend));
  }
  // Addressed demand: wake hints and newly authorized sockets. Coalesced for
  // flushMs so the tenants of one evaluator cycle share one revision read.
  function request (list) {
    if (closed) return;
    for (const tenant of list) if (isWatched(tenant)) demand.add(tenant);
    if (demand.size && !flushTimer) { flushTimer = setTimer(flush, flushMs); flushTimer?.unref?.(); }
  }
  // The level pass: every watched tenant, in bounded batches. A pass still
  // running when the next is due is not doubled.
  function pass () {
    if (closed) return Promise.resolve();
    if (passing) { skippedPasses++; return passing; }
    passing = (async () => {
      counters.ticks++; passes++;
      const list = [...new Set(watched())];
      for (let i = 0; i < list.length && !closed; i += BATCH) await check(list.slice(i, i + BATCH)).catch(() => {});
      if (closed) return;
      resend();
      let pending = 0, oldestAt = null;
      for (const tenant of list) {
        const since = cells.get(tenant)?.behindSince;
        if (since !== null && since !== undefined) { pending++; if (oldestAt === null || since < oldestAt) oldestAt = since; }
      }
      backlog = { pending, oldestAt };
      // Cells of tenants nobody has watched for two prune rounds are released.
      if (passes % PRUNE_PASSES === 0) for (const [tenant, cell] of cells) {
        if (cell.inflight || isWatched(tenant)) cell.idle = false;
        else if (cell.idle) cells.delete(tenant); else cell.idle = true;
      }
    })().finally(() => { passing = null; });
    return passing;
  }
  function arm () {
    if (closed) return;
    levelTimer = setTimer(() => { arm(); pass().catch(() => {}); }, levelMs); levelTimer?.unref?.();
  }
  // An optional prefetch (the role passes none): these tenants are read once
  // before start resolves. A failure is left to the level pass.
  await Promise.allSettled(tenants.map(tenant => refresh(tenant)));
  arm();
  return Object.freeze({ refresh,
    // Tests and shutdown: one level pass, pending demand, and every read and send they started.
    async tick () {
      await pass();
      do {
        if (flushTimer) { clearTimer(flushTimer); flush(); }
        await Promise.allSettled([passing, ...flights]);
      } while (!closed && (flights.size || passing || flushTimer));
    },
    wake (list) { request(Array.isArray(list) ? list : [list]); },
    addTenant (tenant) { cellOf(tenant); },
    async removeTenant (tenant) {
      const cell = cells.get(tenant); if (!cell) return;
      empty(cell); cells.delete(tenant); demand.delete(tenant); redeliver.delete(tenant);
    },
    // A restore or lifecycle change: the cell's frame and any read in flight
    // are abandoned, and the next check reads the tenant again.
    async invalidateTenant (tenant) {
      const cell = cells.get(tenant); if (!cell) return;
      empty(cell); cells.set(tenant, makeCell()); redeliver.delete(tenant);
    },
    has (tenant) { return !closed && cells.has(tenant); },
    last (tenant) { const cell = cells.get(tenant); return !closed && cell?.last && kept(cell) && (!operationWindow || operationWindow.current(tenant)) ? cell.last : null; },
    warm (tenant) { const cell = cells.get(tenant); return !closed && !!cell?.last && kept(cell); },
    stageOf (tenant) { const cell = cells.get(tenant); return cell ? { stage: cell.stage, at: cell.stageAt, active: cell.active } : null; },
    progress: () => Object.freeze({ entered: Object.freeze({ ...entered }), inflight: Object.freeze({ ...inflight }), deadlines, skippedPasses, queued: slots.length }),
    // Aggregate backlog as of the last level pass: no SQL, no walk, no tenant id.
    pendingSummary () { return { tenants: cells.size, pending: backlog.pending, oldestAgeMs: backlog.oldestAt === null ? 0 : Math.max(0, now() - backlog.oldestAt) }; },
    stats: () => Object.freeze({ ...counters }),
    probe () { return { live: !closed, readiness: 'serve', ready: !closed, configured: cells.size }; },
    async close () {
      if (closed) return; closed = true;
      for (const timer of [levelTimer, flushTimer, resendTimer]) if (timer) clearTimer(timer);
      levelTimer = null; flushTimer = null; resendTimer = null;
      for (const cell of cells.values()) cell.epoch++;
      // Bounded: each read in flight ends at its own deadline at the latest.
      await Promise.allSettled([passing, ...flights]);
    }
  });
};
module.exports.STAGES = STAGES;
module.exports.LEVEL_MS = LEVEL_MS;
