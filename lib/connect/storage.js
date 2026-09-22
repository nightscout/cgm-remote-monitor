'use strict';

const crypto = require('node:crypto');
const ConnectError = require('./errors');

module.exports = function storage(collection, enclave) {
  let queue = Promise.resolve();
  const owner = crypto.randomUUID();
  async function load() {
    const record = await collection.findOne({ _id: 'carelink' });
    if (!record) return null;
    try { return enclave.openConnector(record.secret); } catch (_) {
      throw new ConnectError('encryption_key_changed', 409);
    }
  }
  async function save(value) {
    await collection.updateOne({ _id: 'carelink' }, { $set: { secret: enclave.sealConnector(value) } }, { upsert: true });
  }
  // Serialize refresh/install/disconnect locally and across app processes. The
  // latest token is always loaded inside the lease, never from a stale cache.
  function exclusive(fn) {
    const run = queue.then(async () => {
      try { await collection.updateOne({ _id: 'carelink-lock' }, { $setOnInsert: { until: new Date(0) } }, { upsert: true }); }
      catch (err) { if (err.code !== 11000) throw err; }
      const acquired = await collection.findOneAndUpdate({ _id: 'carelink-lock', until: { $lte: new Date() } },
        { $set: { owner, until: new Date(Date.now() + 120000) } }, { returnDocument: 'after' });
      if (!acquired.value) throw new ConnectError('connection_busy', 409);
      let lost = false;
      const renewal = setInterval(() => {
        collection.updateOne({ _id: 'carelink-lock', owner }, { $set: { until: new Date(Date.now() + 120000) } })
          .then(r => { if (!r.matchedCount) lost = true; }).catch(() => { lost = true; });
      }, 20000);
      renewal.unref();
      async function check() {
        if (lost || !await collection.findOne({ _id: 'carelink-lock', owner, until: { $gt: new Date() } })) {
          throw new ConnectError('connection_busy', 409);
        }
      }
      try { return await fn(check); } finally {
        clearInterval(renewal);
        await collection.updateOne({ _id: 'carelink-lock', owner }, { $set: { until: new Date(0) } });
      }
    });
    queue = run.catch(() => {});
    return run;
  }
  return { load, save, exclusive, remove: () => collection.deleteOne({ _id: 'carelink' }) };
};
