'use strict';

const { isDeepStrictEqual } = require('node:util');
const { AsyncResource } = require('node:async_hooks');
const PostgresCleanupError = require('../storage/postgres-cleanup-error');
const open = require('./effective-postgres');
const unavailable = () => Object.assign(new Error('SETTINGS_POLICY_UNAVAILABLE'), { code: 'SETTINGS_POLICY_UNAVAILABLE' });

// Register this resource at DATA boot without connecting to display storage.
// Raw ingestion can start even while this independent capability is unavailable.
module.exports = function presentationReader (config, { revalidate = false, preserveErrors = false, concurrency, maxPending, roleAdmitted = false, pool } = {}) {
  if (revalidate && (!Number.isSafeInteger(concurrency) || concurrency < 1 ||
      !Number.isSafeInteger(maxPending) || maxPending < 1)) throw new TypeError('Evaluator settings admission requires explicit finite bounds');
  const binding = { connectionString: config.connectionString, namespaces: { ...config.namespaces } };
  const shutdown = new AbortController();
  // Opening and checking run in this owner's construction context, never in the
  // async context (tenant scope, job) of the read that happened to need them.
  const owner = new AsyncResource('nightscout-display-settings');
  let active = 0;
  const waiting = [];
  let closed = false, current, opening, closing;
  const retired = new WeakMap(), retiring = new Set(), cleanupErrors = [];
  const reads = new Set();
  // Readiness of the display store as last established outside tenant reads:
  // 'pending' until the first open/check settles. Never green before that.
  let status = { state: 'pending' };
  const record = (state, error) => {
    status = state === 'ready' ? { state } : { state, code: typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'SETTINGS_SCREEN_REFUSED' };
  };
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
    // Strict owners screen at open/reopen. The API passes its completed
    // role admission separately from deployment configuration.
    if (!opening) opening = Promise.resolve().then(() => owner.runInAsyncScope(open, null, config, { roleAdmitted, ...(pool ? { pool } : {}) })).then(resource => {
      // close() drains this initialization before closing the late-created pool.
      current = resource; record('ready');
      if (closed) throw unavailable();
      return resource;
    }).catch(error => {
      record('unavailable', error);
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
      // The resource owns the value transaction; it screens nothing per read.
      const result = await resource.read(tenant, { signal: shutdown.signal });
      if (closed) throw unavailable();
      return result;
    } catch (error) {
      if (revalidate && error instanceof PostgresCleanupError && !cleanupErrors.includes(error)) cleanupErrors.push(error);
      // A failed read is that tenant's failure: it never supplies a value and
      // never closes the shared capability for other tenants (the pool
      // replaces a broken connection itself; the owner's check() screens after
      // a datastore recovery). Only an unconfirmed connection cleanup evicts.
      let outcome = error;
      if (resource && current === resource && error instanceof PostgresCleanupError) {
        current = undefined; record('unavailable', error);
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
  // The owner's readiness and recovery screen. It never runs inside a tenant
  // read: the role calls it after its listener opens and after a datastore
  // recovery. A refusal evicts the capability and reports not-ready.
  async function check () {
    if (closed) throw unavailable();
    const held = current;
    // Without a held capability, opening it is the screen.
    const resource = await ready();
    if (resource !== held) return status;
    try { await owner.runInAsyncScope(() => resource.check()); if (current === resource) record('ready'); }
    catch (error) {
      record('unavailable', error);
      if (revalidate && error instanceof PostgresCleanupError && !cleanupErrors.includes(error)) cleanupErrors.push(error);
      let outcome = error;
      if (current === resource) {
        current = undefined;
        try { await closeOne(resource); }
        catch (cleanupError) { outcome = new PostgresCleanupError(error, cleanupError); cleanupErrors.push(outcome); }
      }
      throw outcome;
    }
    return status;
  }
  return Object.freeze({
    check,
    matches: current => isDeepStrictEqual(binding, current),
    health () { return Object.freeze({ ready: !closed && status.state === 'ready', ...status }); },
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
