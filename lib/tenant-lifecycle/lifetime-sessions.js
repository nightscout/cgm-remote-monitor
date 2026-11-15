'use strict';

// Bounded worker-owned lifetime session lanes. The existing operation-window
// protocol still owns all registration, admission, markers and tenant locks.
const { createHash } = require('node:crypto');
const diagnostics = require('../diagnostics/m7');
const fail = () => Object.assign(new Error('LIFECYCLE_WINDOW_SESSION_LOST'), { code: 'LIFECYCLE_WINDOW_SESSION_LOST' });
function create ({ pool, size }) {
  if (!Number.isSafeInteger(size) || size < 1 || !Number.isSafeInteger(pool?.options?.max) || size > pool.options.max) throw new TypeError('Explicit lifetime session bound within the existing pool required');
  const lanes = new Map(); let closed = false;
  const waitMs = pool.options.connectionTimeoutMillis || 0;
  function endWaiting (job) {
    if (job.waiting) { job.waiting = false; diagnostics.delta('lifetime.queue_pending', -1); job.endWait(); }
    clearTimeout(job.timer);
  }
  function refuseQueued (lane) {
    for (const job of [...lane.completions.splice(0), ...lane.admissions.splice(0)]) {
      endWaiting(job); job.reject(lane.failure || fail());
    }
  }
  function drain (lane) {
    if (lane.active) return;
    // A registered operation owns durable state and a session lock. Finish it
    // before admitting more work; a wait deadline may cancel only an admission
    // that has not touched the backend. Both queues retain FIFO order.
    const job = lane.completions.shift() || lane.admissions.shift();
    if (!job) return;
    lane.active = true; endWaiting(job);
    const run = () => {
      if (lane.failure || closed) throw lane.failure || fail();
      if (!diagnostics.enabled) return job.fn();
      diagnostics.delta('lifetime.critical_active', 1);
      return Promise.resolve().then(job.fn).finally(() => diagnostics.delta('lifetime.critical_active', -1));
    };
    Promise.resolve().then(run).then(job.resolve, job.reject).finally(() => { lane.active = false; drain(lane); });
  }
  function laneFor (tenant) {
    if (closed) throw fail();
    const index = createHash('sha256').update(tenant).digest().readUInt32BE(0) % size;
    if (!lanes.has(index)) {
      const lane = { index, admissions: [], completions: [], pending: new Set(), active: false, failure: null, client: null, opening: null, released: false, subscribers: new Set() };
      lane.opening = pool.connect().then(client => {
        lane.client = client; diagnostics.delta('lifetime.lease_holders', 1);
        lane.failed = error => {
          lane.failure = lane.failure || error; refuseQueued(lane);
          for (const subscriber of lane.subscribers) subscriber(lane.failure);
        };
        client.on('error', lane.failed);
        if (closed) throw fail();
        return client;
      }).catch(error => { lane.failure = error; throw error; });
      lanes.set(index, lane);
    }
    return lanes.get(index);
  }
  return {
    async acquire (tenant) {
      const lane = laneFor(tenant), client = await lane.opening;
      if (lane.failure || closed) throw lane.failure || fail();
      return { client,
        subscribe (fn) { lane.subscribers.add(fn); return () => lane.subscribers.delete(fn); },
        serial (fn, { completion = false } = {}) {
          if (lane.failure || closed) return Promise.reject(lane.failure || fail());
          let resolve, reject;
          const result = new Promise((yes, no) => { resolve = yes; reject = no; });
          const job = { fn, resolve, reject, waiting: true, endWait: diagnostics.time('lifetime.queue_wait') };
          diagnostics.delta('lifetime.queue_pending', 1); lane.pending.add(result);
          result.then(() => lane.pending.delete(result), () => lane.pending.delete(result));
          const queue = completion ? lane.completions : lane.admissions; queue.push(job);
          if (!completion && waitMs) job.timer = setTimeout(() => {
            const index = queue.indexOf(job);
            if (index === -1) return;
            queue.splice(index, 1); endWaiting(job);
            reject(Object.assign(new Error('LIFECYCLE_WINDOW_QUEUE_TIMEOUT'), { code: 'LIFECYCLE_WINDOW_QUEUE_TIMEOUT' }));
          }, waitMs);
          drain(lane);
          return result;
        },
        poison (error) {
          const notify = !lane.failure;
          lane.failure = lane.failure || error || fail();
          // A failed/ambiguous owner backend is never reused or replaced. Its
          // durable unfinished markers survive and keep restore fail-closed.
          if (notify) client.emit('error', lane.failure);
          else refuseQueued(lane);
          if (!lane.released) { lane.released = true; diagnostics.delta('lifetime.lease_holders', -1); client.release(lane.failure); }
        }
      };
    },
    // Decision datastore-loss-recover-in-place: how many lanes lost their backend
    // (or never opened one), and their replacement. `reset` is called by the
    // operation window only after it has re-admitted the datastore on a new
    // backend; the next acquire on a reset lane opens a new session, whose
    // every registration still passes the window's in-transaction admission.
    // The lost backend's unfinished operation markers stay as they are.
    failed () { let count = 0; for (const lane of lanes.values()) if (lane.failure) count++; return count; },
    reset () {
      let count = 0;
      for (const [index, lane] of lanes) {
        if (!lane.failure) continue;
        lanes.delete(index); count++;
        if (lane.client && !lane.released) {
          lane.released = true; diagnostics.delta('lifetime.lease_holders', -1);
          lane.client.removeListener('error', lane.failed); lane.client.release(lane.failure);
        }
      }
      return count;
    },
    async close () {
      closed = true;
      for (const lane of lanes.values()) {
        refuseQueued(lane);
        await Promise.allSettled([...lane.pending]);
        await lane.opening.catch(() => {});
        if (lane.client && !lane.released) { lane.released = true; diagnostics.delta('lifetime.lease_holders', -1); lane.client.removeListener('error', lane.failed); lane.client.release(lane.failure); }
      }
    }
  };
}
module.exports = { create };
