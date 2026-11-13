'use strict';

// Owns exactly one maintained pgstream child. Receiver ACKs call receipt only
// AFTER their durable work. Source /health never grants feed health here.
const { spawn } = require('node:child_process');
const path = require('node:path');
const fail = code => Object.assign(new Error(code), { code });
const BOUNDS = ['heartbeatMs', 'stallMs', 'stepMs', 'stopMs', 'recoveryMs', 'pendingMs'];
function validate (config) {
  if (!config || !BOUNDS.every(key => Number.isSafeInteger(config[key]) && config[key] > 0 && config[key] <= 2147483647) ||
      config.stallMs < config.heartbeatMs * 2 || config.recoveryMs <= config.stallMs + config.stopMs ||
      !Number.isSafeInteger(config.maxRestarts) || config.maxRestarts < 1 || config.maxRestarts > 100) throw new TypeError('Explicit pgstream heartbeat, stall, step, stop, pending and recovery bounds required');
  return Object.freeze({ ...config });
}
async function start ({ binary, configFile, bounds, pulse, inspect, pending, onUnavailable, onRecovered = async () => {}, onTerminal = () => {}, output = 'ignore', initialSequence = 0, now = Date.now }) {
  bounds = validate(bounds);
  if (![binary, configFile].every(value => typeof value === 'string' && path.isAbsolute(value)) ||
      [pulse, inspect, pending, onUnavailable, now].some(value => typeof value !== 'function')) throw new TypeError('Pinned pgstream and explicit health ports required');
  let child, terminalReported=false, closed = false, terminal = null, healthy = false, running, closing, timer;
  if(!Number.isSafeInteger(initialSequence)||initialSequence<0)throw new TypeError('Initial committed heartbeat revision required');
  let bornAt, lastReceipt = null, sequence = initialSequence, received = initialSequence, failedAt = null, restarts = 0, reason = 'PGSTREAM_STARTING';
  let pendingSince = null;
  const stats = { starts: 0, receipts: 0, pulses: 0, probes: 0 };
  function receipt (value) {
    if (!Number.isSafeInteger(value) || value < 1 || value > sequence) throw fail('PGSTREAM_HEARTBEAT_INVALID');
    if (closed || terminal || value <= received) return;
    received = value; lastReceipt = now(); stats.receipts++;
  }
  function launch () {
    if (closed || terminal) return;
    bornAt = now(); lastReceipt = null;
    child = spawn(binary, ['run', '-c', configFile, '--log-level', 'info'], { stdio: ['ignore', output, output] });
    child.on('error', () => { reason = 'PGSTREAM_CHILD_FAILED'; });
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
  async function step (fn) {
    const abort = new AbortController(); let timeout;
    const work = Promise.resolve().then(() => fn(abort.signal));
    try { return await Promise.race([work, new Promise((resolve, reject) => { timeout = setTimeout(() => { abort.abort(); reject(fail('PGSTREAM_STEP_TIMEOUT')); }, bounds.stepMs); })]); }
    catch (error) { if (abort.signal.aborted) terminal = 'PGSTREAM_STEP_TIMEOUT'; throw error; }
    finally { clearTimeout(timeout); }
  }
  async function unavailable (code) {
    healthy = false; reason = code;
    if (failedAt === null) failedAt = now();
    try { await step(signal => onUnavailable(code, signal)); }
    catch { terminal = terminal || 'PGSTREAM_WITHDRAWAL_FAILED'; }
  }
  async function check () {
    if (closed || terminal) return;
    try {
      stats.probes++;
      const source = await step(inspect);
      // Identity/grants/slot loss must be explicit. A supervisor never silently
      // recreates a slot and skips the bootstrap reconciliation boundary.
      if (!source || source.identity !== true || source.grants !== true || source.slot !== 'valid') {
        terminal = source?.slot === 'lost' ? 'PGSTREAM_REBOOTSTRAP_REQUIRED' : 'PGSTREAM_SOURCE_REFUSED';
        throw fail(terminal);
      }
      const work = await step(pending);
      if (!work || typeof work.pending !== 'boolean' || (work.pending && (!Number.isSafeInteger(work.oldestPendingAt) || work.oldestPendingAt < 0 || work.oldestPendingAt > now()))) throw fail('PGSTREAM_PENDING_HEALTH_INVALID');
      pendingSince = work.pending ? work.oldestPendingAt : null;
      if (pendingSince !== null && now() - pendingSince >= bounds.pendingMs) {
        terminal = 'PGSTREAM_CLINICAL_PROGRESS_STALLED'; throw fail(terminal);
      }
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
      const next = ++sequence;
      await step(signal => pulse(next, signal)); stats.pulses++;
      if (!healthy && lastReceipt !== null && now() - lastReceipt < bounds.stallMs) await step(onRecovered);
      if (lastReceipt !== null && now() - lastReceipt < bounds.stallMs && pendingSince === null) {
        healthy = true; reason = null; failedAt = null; restarts = 0;
      } else if (lastReceipt !== null && now() - lastReceipt < bounds.stallMs && now() - pendingSince < bounds.pendingMs) {
        healthy = true; reason = null; // fresh heartbeat cannot hide expired pending work
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
    running = check().finally(() => { running = null;if(terminal&&!terminalReported){terminalReported=true;onTerminal(terminal);} }); return running;
  }
  launch(); await tick();
  timer = setInterval(() => { tick().catch(() => {}); }, bounds.heartbeatMs); timer.unref?.();
  return Object.freeze({ receipt, check: tick,
    health: () => ({ healthy: healthy && !closed && !terminal, code: terminal || reason, terminal: !!terminal, closed,
      heartbeatAgeMs: lastReceipt === null ? null : now() - lastReceipt, sequence, received, restarts, ...stats }),
    close () { if (!closing) { closed = true; healthy = false; clearInterval(timer); closing = Promise.resolve(running).then(stop); } return closing; }
  });
}
module.exports = { start, validate };
