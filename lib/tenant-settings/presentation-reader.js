'use strict';

const open = require('./effective-postgres');
const unavailable = () => Object.assign(new Error('SETTINGS_POLICY_UNAVAILABLE'), { code: 'SETTINGS_POLICY_UNAVAILABLE' });

// Register this resource at DATA boot without connecting to display storage.
// Raw ingestion can start even while this independent capability is unavailable.
module.exports = function presentationReader (config) {
  let closed = false, current, opening, closing;
  const retired = new WeakMap(), retiring = new Set(), cleanupErrors = [];
  function closeOne (resource) {
    if (retired.has(resource)) return retired.get(resource);
    const pending = Promise.resolve().then(() => resource.close()).catch(error => { cleanupErrors.push(error); throw error; });
    retired.set(resource, pending); retiring.add(pending);
    pending.then(() => retiring.delete(pending), () => retiring.delete(pending));
    return pending;
  }
  async function ready () {
    if (closed) throw unavailable();
    if (current) return current;
    if (!opening) opening = Promise.resolve().then(() => open(config)).then(resource => {
      // close() drains this initialization before closing the late-created pool.
      current = resource;
      if (closed) throw unavailable();
      return resource;
    }).finally(() => { opening = undefined; });
    return opening;
  }
  return Object.freeze({
    async read (tenant) {
      if (closed) throw unavailable();
      let resource;
      try {
        resource = await ready();
        if (closed) throw unavailable();
        return await resource.read(tenant);
      } catch {
        // A failed/unsafe dependency never supplies stale values; the next
        // presentation operation initializes and validates a fresh capability.
        if (resource && current === resource) { current = undefined; await closeOne(resource).catch(() => {}); }
        throw unavailable();
      }
    },
    close () {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        if (opening) await opening.catch(() => {});
        if (current) { const resource = current; current = undefined; await closeOne(resource).catch(() => {}); }
        await Promise.allSettled([...retiring]);
        if (cleanupErrors.length) throw new globalThis.AggregateError(cleanupErrors, 'Presentation settings shutdown failed');
      })();
      return closing;
    }
  });
};
