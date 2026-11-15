'use strict';

// Owns exactly one maintained pgstream child. Receiver ACKs call receipt only
// AFTER their durable work. Source /health never grants feed health here.
const { spawn } = require('node:child_process');
const path = require('node:path');
const fail = code => Object.assign(new Error(code), { code });
const BOUNDS = ['heartbeatMs', 'stallMs', 'stepMs', 'stopMs', 'recoveryMs', 'pendingMs'];
function validate (config) {
  if (!config || Object.keys(config).sort().join(',') !== [...BOUNDS,'maxRestarts'].sort().join(',') || !BOUNDS.every(key => Number.isSafeInteger(config[key]) && config[key] > 0 && config[key] <= 2147483647) ||
      config.stallMs < config.heartbeatMs * 2 || config.recoveryMs <= config.stallMs + config.stopMs ||
      !Number.isSafeInteger(config.maxRestarts) || config.maxRestarts < 1 || config.maxRestarts > 100) throw new TypeError('Explicit pgstream heartbeat, stall, step, stop, pending and recovery bounds required');
  return Object.freeze({ ...config });
}
async function start ({ binary, configFile, bounds, pulse, inspect, pending, onUnavailable, onRecovered = async () => {}, onTerminal = () => {}, output = 'ignore', initialSequence = 0, now = Date.now, monotonicNow, onHealthy }) {
  bounds = validate(bounds);
  if (onHealthy !== undefined && typeof onHealthy !== 'function') throw new TypeError('Explicit recovered publisher required');
  if (monotonicNow !== undefined && typeof monotonicNow !== 'function') throw new TypeError('Explicit monotonic receipt clock required');
  let lastMonotonicReceipt = null, lastMonotonicReading = null;
  function monotonic() {
    const value = monotonicNow();
    if (!Number.isFinite(value) || value < 0 || lastMonotonicReading !== null && value < lastMonotonicReading) throw fail('PGSTREAM_MONOTONIC_CLOCK_REFUSED');
    lastMonotonicReading = value; return value;
  }
  if (![binary, configFile].every(value => typeof value === 'string' && path.isAbsolute(value)) ||
      [pulse, inspect, pending, onUnavailable, now].some(value => typeof value !== 'function')) throw new TypeError('Pinned pgstream and explicit health ports required');
  let child, terminalReported=false, closed = false, terminal = null, healthy = false, running, closing, timer;
  if(!Number.isSafeInteger(initialSequence)||initialSequence<0)throw new TypeError('Initial committed heartbeat revision required');
  let bornAt, lastReceipt = null, sequence = initialSequence, received = initialSequence, failedAt = null, restarts = 0, reason = 'PGSTREAM_STARTING';
  // A new owner gets one bounded chance to drain recovered durable work.
  // Child restarts never reset this deadline or the stored pending timestamp.
  const recoveryStartedAt = now();
  let pendingSince = null, clinicalStalled = false;
  const stats = { starts: 0, receipts: 0, pulses: 0, probes: 0 };
  let lastFailure = null, lastStepFailure = null, lastChildExit = null;
  const childLogs = [];
  // Upstream error records can include a complete webhook payload and URLs.
  // Retain bounded classifications, never arbitrary fields or raw child text.
  function retainLog (stream, row) {
    if (!row || !['warn','error','fatal','panic'].includes(row.level)) return;
    const messages = ['sending webhook event','stop processing, notify has stopped','stop processing, notify is shutting down',
      'webhook delivery permanently failed, dropping','refreshing store cache'];
    const error = typeof row.error === 'string' ? row.error : '';
    const record = { stream, level: row.level, message: messages.includes(row.message) ? row.message : 'pgstream child error',
      sqlState: error.match(/SQLSTATE[ :()]*([0-9A-Z]{5})/)?.[1] || null,
      httpStatus: error.match(/(?:status(?: code)?|HTTP)[^0-9]{0,20}([1-5][0-9]{2})/i)?.[1] || null,
      errors: [...new Set((error.match(/timeout|deadline exceeded|connection refused|connection reset|broken pipe|unexpected EOF|context canceled|authentication failed|too many clients/gi) || []).map(value => value.toLowerCase()))].slice(0,4) };
    childLogs.push(record); if (childLogs.length > 8) childLogs.shift();
  }
  function readLogs (stream, name) {
    let partial = '';
    stream?.on('data', chunk => {
      const lines = (partial + chunk.toString('utf8')).split('\n'); partial = lines.pop();
      if (partial.length > 16384) partial = '';
      for (const line of lines) if (line.length <= 16384) { try { retainLog(name, JSON.parse(line)); } catch { /* Unstructured text is not safe diagnostic data. */ } }
    });
  }
  function diagnostics () {
    return { code: terminal || reason, lastFailure, lastStepFailure, lastChildExit,
      heartbeatAgeMs: lastReceipt === null ? null : now() - lastReceipt, sequence, received, failedAt, restarts,
      pendingSince, clinicalStalled, recoveryStartedAt, ...stats, childLogs: childLogs.map(row => ({...row,errors:[...row.errors]})) };
  }
  function receipt (value) {
    if (!Number.isSafeInteger(value) || value < 1 || value > sequence) throw fail('PGSTREAM_HEARTBEAT_INVALID');
    if (closed || terminal || value <= received) return;
    if (monotonicNow) lastMonotonicReceipt = monotonic();
    received = value; lastReceipt = now(); stats.receipts++;
  }
  function launch () {
    if (closed || terminal) return;
    bornAt = now(); lastReceipt = null; lastMonotonicReceipt = null;
    child = spawn(binary, ['run', '-c', configFile, '--log-level', 'info'], { stdio: ['ignore', output === 'ignore' ? 'pipe' : output, 'pipe'] });
    child.on('error', () => { reason = 'PGSTREAM_CHILD_FAILED'; });
    const owned = child;
    readLogs(owned.stdout, 'stdout'); readLogs(owned.stderr, 'stderr');
    owned.once('exit', (code, signal) => { lastChildExit = { pid: owned.pid, code, signal, at: now() }; });
    stats.starts++;
  }
  async function stop () {
    const owned = child;
    if (!owned || owned.exitCode !== null || owned.signalCode !== null || !owned.pid) return;
    const exited = new Promise(resolve => owned.once('exit', resolve));
    owned.kill('SIGTERM');
    let timeout;
    await Promise.race([exited, new Promise(resolve => { timeout = setTimeout(resolve, bounds.stopMs); })]);
    clearTimeout(timeout);
    if (owned.exitCode === null && owned.signalCode === null) {
      owned.kill('SIGKILL');
      await Promise.race([exited, new Promise((resolve, reject) => { timeout = setTimeout(() => reject(fail('PGSTREAM_CHILD_STOP_UNCONFIRMED')), bounds.stopMs); })]);
      clearTimeout(timeout);
    }
    if (owned.exitCode === null && owned.signalCode === null) throw fail('PGSTREAM_CHILD_STOP_UNCONFIRMED');
  }
  // A timed-out physical step is never overlapped with another attempt.
  // Terminal refusal stops the owned child; the caller stops its role if a
  // cancelled database/receiver operation cannot be proved finished.
  async function step (fn, phase) {
    const abort = new AbortController(); let timeout;
    const work = Promise.resolve().then(() => fn(abort.signal));
    try { return await Promise.race([work, new Promise((resolve, reject) => { timeout = setTimeout(() => { abort.abort(); reject(fail('PGSTREAM_STEP_TIMEOUT')); }, bounds.stepMs); })]); }
    catch (error) { lastStepFailure = { phase, code: abort.signal.aborted ? 'PGSTREAM_STEP_TIMEOUT' : /^[A-Z0-9_]{1,100}$/.test(error?.code || '') ? error.code : null, at: now() }; if (abort.signal.aborted) terminal = 'PGSTREAM_STEP_TIMEOUT'; throw error; }
    finally { clearTimeout(timeout); }
  }
  async function unavailable (code) {
    healthy = false; reason = code;
    if (code !== 'PGSTREAM_RECOVERY_EXHAUSTED') lastFailure = { code, at: now() };
    if (failedAt === null) failedAt = now();
    try { await step(signal => onUnavailable(code, signal, diagnostics()), 'withdrawal'); }
    catch { terminal = terminal || 'PGSTREAM_WITHDRAWAL_FAILED'; }
  }
  async function check () {
    if (closed || terminal) return;
    try {
      stats.probes++;
      const source = await step(inspect, 'inspect');
      // Identity/grants/slot loss must be explicit. A supervisor never silently
      // recreates a slot and skips the bootstrap reconciliation boundary.
      if (!source || source.identity !== true || source.grants !== true || source.slot !== 'valid') {
        terminal = source?.slot === 'lost' ? 'PGSTREAM_REBOOTSTRAP_REQUIRED' : 'PGSTREAM_SOURCE_REFUSED';
        throw fail(terminal);
      }
      const work = await step(pending, 'pending');
      if (!work || typeof work.pending !== 'boolean' || (work.pending && (!Number.isSafeInteger(work.oldestPendingAt) || work.oldestPendingAt < 0 || work.oldestPendingAt > now()))) throw fail('PGSTREAM_PENDING_HEALTH_INVALID');
      pendingSince = work.pending ? work.oldestPendingAt : null;
      // Backlog health belongs to clinical completion. One poisoned tenant
      // cannot stop the only input/heartbeat stream for every other tenant.
      clinicalStalled = pendingSince !== null && now() - Math.max(pendingSince, recoveryStartedAt) >= bounds.pendingMs;
      const age = now() - (lastReceipt ?? bornAt);
      if (child.exitCode !== null || child.signalCode !== null || !child.pid || age >= bounds.stallMs) {
        await unavailable('PGSTREAM_HEARTBEAT_STALLED');
        if (terminal || now() - failedAt >= bounds.recoveryMs || restarts >= bounds.maxRestarts) {
          terminal = terminal || 'PGSTREAM_RECOVERY_EXHAUSTED'; await stop(); return;
        }
        await stop(); restarts++; launch();
      }
      // Commit a monotone heartbeat through the WAL source; local pulse success
      // is not delivery. The receiver must durably ACK its revision separately.
      if (sequence === Number.MAX_SAFE_INTEGER) throw fail('PGSTREAM_HEARTBEAT_EXHAUSTED');
      const next = ++sequence;
      await step(signal => pulse(next, signal), 'pulse'); stats.pulses++;
      const recovering = !healthy && lastReceipt !== null && now() - lastReceipt < bounds.stallMs;
      if (recovering) await step(onRecovered, 'recovery');
      if (lastReceipt !== null && now() - lastReceipt < bounds.stallMs) {
        // Transport has recovered. Durable work keeps its independent stored
        // age and owner recovery deadline; a fresh heartbeat cannot reset it.
        healthy = true; reason = null; failedAt = null; restarts = 0;
        if (recovering && onHealthy) await step(onHealthy, 'healthy-publication');
      }
      if (failedAt !== null && now() - failedAt >= bounds.recoveryMs) {
        terminal = 'PGSTREAM_RECOVERY_EXHAUSTED'; await unavailable(terminal); await stop();
      }
    } catch (error) {
      await unavailable(terminal || error.code || 'PGSTREAM_HEALTH_FAILED');
      if (terminal || now() - failedAt >= bounds.recoveryMs) { terminal = terminal || 'PGSTREAM_RECOVERY_EXHAUSTED'; await stop(); }
    }
  }
  function tick () {
    if (running || closed || terminal) return running || Promise.resolve();
    running = check().finally(() => { running = null;if(terminal&&!terminalReported){terminalReported=true;onTerminal(terminal, diagnostics());} }); return running;
  }
  launch(); await tick();
  timer = setInterval(() => { tick().catch(() => {}); }, bounds.heartbeatMs); timer.unref?.();
  return Object.freeze({ receipt, check: tick, diagnostics,
    health: () => ({ healthy: healthy && !closed && !terminal, code: terminal || reason, terminal: !!terminal, closed,
      heartbeatAgeMs: lastReceipt === null ? null : now() - lastReceipt, ...(monotonicNow ? {monotonicHeartbeatAgeMs:lastMonotonicReceipt === null ? null : monotonic()-lastMonotonicReceipt} : {}), sequence, received, restarts, clinicalStalled, clinicalCode: clinicalStalled ? 'PGSTREAM_CLINICAL_PROGRESS_STALLED' : null, ...stats }),
    close () { if (!closing) { closed = true; healthy = false; clearInterval(timer); closing = Promise.resolve(running).then(stop); } return closing; }
  });
}
module.exports = { start, validate };
