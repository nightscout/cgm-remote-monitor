'use strict';
const {createHash} = require('node:crypto');
const {parse} = require('./index');
const fail = () => { throw Object.assign(new Error('REALTIME_MIXED_LAYOUT_REFUSED'), {code: 'REALTIME_MIXED_LAYOUT_REFUSED'}); };
function keys(consumer, shape) {
  parse(shape);
  if (typeof consumer !== 'string' || !/^realtime-[A-Za-z0-9_-]{1,112}$/.test(consumer)) throw new TypeError('Stable realtime consumer required');
  const hash = text => createHash('sha256').update(text).digest();
  const prefix = hash('realtime-static-layout-v1\0' + consumer).readUInt32BE(0);
  const marker = BigInt.asIntN(64, (BigInt(prefix) << 32n) | BigInt(shape.count)).toString();
  // Ordinal key deliberately excludes K, so an overlapping ordinal refuses
  // even before the mixed-layout check, across coordinated resize attempts.
  const owner = hash('realtime-static-owner-v1\0' + consumer + '\0' + shape.ordinal).readBigInt64BE(0).toString();
  return {owner, marker, prefix};
}
async function acquire({connection, observer = connection, consumer, shape, onLoss}) {
  const {owner, marker, prefix} = keys(consumer, shape);
  const resource = await connection.holdAdvisoryLock(owner, onLoss, {sharedKey: marker});
  try {
    // The marker is held BEFORE observation. Concurrent differing layouts see
    // each other, or the later admission sees the already admitted layout.
    // Only refusal follows; this observation never authorizes a takeover.
    const rows = (await observer.readOnly("SELECT objid::text AS count FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND classid=$1::oid AND objsubid=1 AND granted", [String(prefix)])).rows;
    if (!rows.length || rows.some(row => row.count !== String(shape.count))) fail();
    await resource.check();
    return resource;
  } catch (error) { await resource.close(); throw error; }
}
// The slice's owner session for the life of the process. Loss of the session
// is not the end of the process: delivery quiesces (onLost), the lock is taken
// again on a new connection with backoff, and delivery resumes (onHeld). The
// process ends (onExhausted) only for a definitive layout conflict or when the
// lock cannot be held again within boundMs. An ownership check that times out
// is uncertainty: it becomes loss only after uncertainMs without an answer.
// Another session holding this ordinal's key is retried inside the bound: the
// holder may be this process's previous backend, not yet reaped by the server.
function hold({connect, observer, consumer, shape, onLost = () => {}, onHeld = () => {}, onExhausted,
  checkMs = 1000, uncertainMs = 30000, boundMs = 120000, retry = {minMs: 500, maxMs: 15000},
  now = Date.now, setTimer = setTimeout, random = Math.random}) {
  if ([connect, observer, onLost, onHeld, onExhausted, now, setTimer].some(fn => typeof fn !== 'function') ||
      ![checkMs, uncertainMs, boundMs, retry?.minMs, retry?.maxMs].every(value => Number.isSafeInteger(value) && value > 0)) throw new TypeError('Explicit bounded realtime owner session required');
  let connection = null, resource = null, closed = false, recovering = null, checking = null, timer = null, uncertainSince = null, exhausted = false;
  const counters = {losses: 0, uncertain: 0, reacquired: 0, attempts: 0};
  const safely = fn => { try { return Promise.resolve(fn()).catch(() => {}); } catch { return Promise.resolve(); } };
  async function open() {
    const next = await connect(), held = {connection: next, resource: undefined};
    try { held.resource = await acquire({connection: next, observer: observer(), consumer, shape, onLoss: () => lose(held.resource)}); return held; }
    catch (error) { await safely(() => next.end()); throw error; }
  }
  async function release(old) {
    await safely(() => old.resource?.close());
    await safely(() => old.connection?.end());
  }
  function lose(from) {
    if (closed || exhausted || recovering || from !== resource) return recovering;
    counters.losses++;
    const old = {connection, resource}, lostAt = now();
    connection = null; resource = null; uncertainSince = null;
    recovering = (async () => {
      await safely(onLost);
      release(old); // a dead session may never answer; never wait for it
      for (let attempt = 0; !closed; attempt++) {
        counters.attempts++;
        try {
          const held = await open();
          if (closed) { await release(held); return; }
          ({connection, resource} = held); counters.reacquired++;
          recovering = null; await safely(onHeld); return;
        } catch (error) {
          if (closed) return;
          if (error?.code === 'REALTIME_MIXED_LAYOUT_REFUSED' || now() - lostAt >= boundMs) { exhausted = true; recovering = null; onExhausted(error); return; }
        }
        const delay = Math.min(retry.maxMs, retry.minMs * 2 ** Math.min(attempt, 16));
        await new Promise(resolve => { const waiting = setTimer(resolve, Math.round(delay / 2 + random() * delay / 2)); waiting?.unref?.(); });
      }
    })();
    return recovering;
  }
  function check() {
    if (closed || exhausted || recovering || checking || !resource) return checking;
    const checked = resource;
    checking = checked.alive().then(() => { uncertainSince = null; }, error => {
      if (checked !== resource) return;
      if (error?.code !== 'POSTGRES_OPERATIONAL_OWNER_UNCERTAIN') return lose(checked);
      counters.uncertain++;
      if (uncertainSince === null) uncertainSince = now();
      if (now() - uncertainSince >= uncertainMs) return lose(checked);
    }).finally(() => { checking = null; });
    return checking;
  }
  return Object.freeze({
    async start() {
      ({connection, resource} = await open());
      timer = setInterval(check, checkMs); timer.unref?.();
    },
    check,
    get available() { return !closed && !exhausted && !recovering && !!resource?.available; },
    stats: () => Object.freeze({...counters, recovering: !!recovering}),
    async close() {
      closed = true; if (timer) clearInterval(timer); timer = null;
      await Promise.allSettled([checking]);
      const old = {connection, resource}; connection = null; resource = null;
      await release(old);
    }
  });
}
module.exports = {keys, acquire, hold};
