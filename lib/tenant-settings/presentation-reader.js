'use strict';

const { AsyncResource } = require('node:async_hooks');
const PostgresCleanupError = require('../storage/postgres-cleanup-error');
const open = require('./effective-postgres');
const unavailable = () => Object.assign(new Error('SETTINGS_POLICY_UNAVAILABLE'), { code: 'SETTINGS_POLICY_UNAVAILABLE' });

// Register this resource at DATA boot without connecting to display storage.
// Raw ingestion can start even while this independent capability is unavailable.
module.exports = function presentationReader (config, { revalidate = false, preserveErrors = false, concurrency, maxPending } = {}) {
  if (revalidate && (!Number.isSafeInteger(concurrency) || concurrency < 1 ||
      !Number.isSafeInteger(maxPending) || maxPending < 1)) throw new TypeError('Evaluator settings admission requires explicit finite bounds');
  const shutdown = new AbortController();
  let active = 0;
  const waiting = [];
  let closed = false, current, opening, closing;
  const retired = new WeakMap(), retiring = new Set(), cleanupErrors = [];
  const reads = new Set();
  function closeOne (resource) {
    if (retired.has(resource)) return retired.get(resource);
    const pending = Promise.resolve().then(() => resource.close()).catch(error => { cleanupErrors.push(error); throw error; });
    retired.set(resource, pending); retiring.add(pending);
    pending.then(() => retiring.delete(pending), () => retiring.delete(pending));
    return pending;
  }
  async function ready () {
    if (closed) throw unavailable();
    if (revalidate && cleanupErrors.length) throw unavailable();
    // A replacement must not overlap a retired evaluator pool that is still
    // draining other admitted readers. DATA retains its existing behavior.
    if (revalidate && retiring.size) {
      await Promise.allSettled([...retiring]);
      if (closed) throw unavailable();
    }
    if (revalidate && cleanupErrors.length) throw unavailable();
    if (current) return current;
    if (!opening) opening = Promise.resolve().then(() => open(config)).then(resource => {
      // close() drains this initialization before closing the late-created pool.
      current = resource;
      if (closed) throw unavailable();
      return resource;
    }).catch(error => {
      // Initialization may fail before returning its pool to this owner. An
      // unconfirmed cleanup must poison strict evaluator retries as well.
      if (revalidate && error instanceof PostgresCleanupError && !cleanupErrors.includes(error)) cleanupErrors.push(error);
      throw error;
    }).finally(() => { opening = undefined; });
    return opening;
  }
  async function read (tenant) {
    if (closed) throw unavailable();
    let resource;
    try {
      resource = await ready();
      if (closed) throw unavailable();
      // The resource owns the complete fresh screen + value transaction.
      if (closed) throw unavailable();
      const result = await resource.read(tenant, { signal: shutdown.signal });
      if (closed) throw unavailable();
      return result;
    } catch (error) {
      if (revalidate && error instanceof PostgresCleanupError && !cleanupErrors.includes(error)) cleanupErrors.push(error);
      // A failed/unsafe dependency never supplies stale values; the next
      // presentation operation initializes and validates a fresh capability.
      let outcome = error;
      if (resource && current === resource) {
        current = undefined;
        try { await closeOne(resource); }
        catch (cleanupError) {
          outcome = new PostgresCleanupError(error, cleanupError);
          cleanupErrors.push(outcome);
        }
      }
      throw preserveErrors ? outcome : unavailable();
    }
  }
  function admit () {
    if (closed) return Promise.reject(unavailable());
    if (active < concurrency && !waiting.length) { active++; return Promise.resolve(); }
    if (waiting.length >= maxPending) return Promise.reject(unavailable());
    return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
  }
  function release () {
    active--;
    if (!closed && waiting.length) { active++; waiting.shift().resolve(); }
  }
  async function admittedRead (tenant) {
    // Bind at enqueue, never inherit the tenant/job context of the preceding
    // reader that releases the FIFO ticket. The whole screen/read is admitted.
    const invoke = AsyncResource.bind(() => read(tenant));
    await admit();
    try { return await invoke(); } finally { release(); }
  }
  return Object.freeze({
    read (tenant) {
      const pending = revalidate ? admittedRead(tenant) : read(tenant); reads.add(pending);
      pending.then(() => reads.delete(pending), () => reads.delete(pending));
      return pending;
    },
    close () {
      if (closing) return closing;
      closed = true; shutdown.abort(unavailable());
      for (const ticket of waiting.splice(0)) ticket.reject(unavailable());
      closing = (async () => {
        if (opening) await opening.catch(() => {});
        await Promise.allSettled([...reads]);
        if (current) { const resource = current; current = undefined; await closeOne(resource).catch(() => {}); }
        await Promise.allSettled([...retiring]);
        if (cleanupErrors.length) throw new globalThis.AggregateError(cleanupErrors, 'Presentation settings shutdown failed');
      })();
      return closing;
    }
  });
};
