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
  function laneFor (tenant) {
    if (closed) throw fail();
    const index = createHash('sha256').update(tenant).digest().readUInt32BE(0) % size;
    if (!lanes.has(index)) {
      const lane = { index, tail: Promise.resolve(), failure: null, client: null, opening: null, released: false, subscribers: new Set() };
      lane.opening = pool.connect().then(client => {
        lane.client = client; diagnostics.delta('lifetime.lease_holders', 1);
        lane.failed = error => {
          lane.failure = lane.failure || error;
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
        serial (fn) {
          let started = false, cancelled = false, timer;
          const endWait = diagnostics.time('lifetime.queue_wait'); diagnostics.delta('lifetime.queue_pending', 1);
          const timeout = () => Object.assign(new Error('LIFECYCLE_WINDOW_QUEUE_TIMEOUT'), { code: 'LIFECYCLE_WINDOW_QUEUE_TIMEOUT' });
          const result = lane.tail.then(() => {
            diagnostics.delta('lifetime.queue_pending', -1); endWait();
            if (cancelled) throw timeout();
            if (lane.failure || closed) throw lane.failure || fail();
            started = true; clearTimeout(timer);
            if (!diagnostics.enabled) return fn();
            diagnostics.delta('lifetime.critical_active', 1);
            const done = () => diagnostics.delta('lifetime.critical_active', -1);
            try { return Promise.resolve(fn()).finally(done); } catch (error) { done(); throw error; }
          });
          lane.tail = result.catch(() => {});
          if (!waitMs) return result;
          const deadline = new Promise((resolve, reject) => { timer = setTimeout(() => { if (!started) { cancelled = true; endWait(); reject(timeout()); } }, waitMs); });
          return Promise.race([result, deadline]).finally(() => clearTimeout(timer));
        },
        poison (error) {
          const notify = !lane.failure;
          lane.failure = lane.failure || error || fail();
          // A failed/ambiguous owner backend is never reused or replaced. Its
          // durable unfinished markers survive and keep restore fail-closed.
          if (notify) client.emit('error', lane.failure);
          if (!lane.released) { lane.released = true; diagnostics.delta('lifetime.lease_holders', -1); client.release(lane.failure); }
        }
      };
    },
    async close () {
      closed = true;
      for (const lane of lanes.values()) {
        await lane.tail;
        await lane.opening.catch(() => {});
        if (lane.client && !lane.released) { lane.released = true; diagnostics.delta('lifetime.lease_holders', -1); lane.client.removeListener('error', lane.failed); lane.client.release(lane.failure); }
      }
    }
  };
}
module.exports = { create };
