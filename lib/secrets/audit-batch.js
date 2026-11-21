'use strict';

// Coalesce concurrent receipts for one tenant, never across RLS bindings. Every
// attempt retains its own row and waits for the shared durable commit. No timer
// grace, sampling or background receipt: failures reject before crypto begins.
const MAX_BATCH = 64;
function create (write) {
  if (typeof write !== 'function') throw new TypeError('Durable audit batch writer required');
  const queued = new Map(), running = new Set();
  let closed = false;
  function flush (tenant, batch) {
    if (queued.get(tenant) !== batch) return;
    queued.delete(tenant); clearImmediate(batch.scheduled);
    const job = Promise.resolve().then(() => write(tenant, batch.items.map(item => item.event))).then(
      () => { for (const item of batch.items) item.resolve(); },
      error => { for (const item of batch.items) item.reject(error); });
    running.add(job);
    job.then(() => running.delete(job));
  }
  return Object.freeze({
    append (tenant, event) {
      if (closed) return Promise.reject(Object.assign(new Error('SECRETS_STORE_UNAVAILABLE'), { code: 'SECRETS_STORE_UNAVAILABLE' }));
      return new Promise((resolve, reject) => {
        let batch = queued.get(tenant);
        if (!batch) {
          batch = { items: [] };
          queued.set(tenant, batch);
          batch.scheduled = setImmediate(() => flush(tenant, batch));
        }
        batch.items.push({ event, resolve, reject });
        if (batch.items.length === MAX_BATCH) flush(tenant, batch);
      });
    },
    async close () {
      closed = true;
      for (const [tenant, batch] of queued) flush(tenant, batch);
      await Promise.all([...running]);
    }
  });
}
module.exports = { create, MAX_BATCH };
