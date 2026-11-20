'use strict';

// The evaluator's work source in writer-driven mode: the typed completed-work
// store with no stream receiver, slot or receipt. It returns the same surface
// as lib/pgstream/evaluator.js open() so the evaluator role keeps one runtime.
// Work arrives as pending marks written by the writers themselves; the role's
// scheduler sweeps them (lib/pgstream/activity-scheduler.js sweepMs) and a
// `changed` hint only shortens the wait.
const checkpoint = require('../pgstream/checkpoint');

async function open ({ config, connection, assignment, notificationRecovery, onCommit, onRecovered, onTerminal }) {
  if (!config?.writerDriven || typeof onRecovered !== 'function') throw new TypeError('Explicit writer-driven evaluator source required');
  const store = checkpoint.create({ connection, namespace: config.namespaces.checkpoint, consumer: config.consumer, maxBytes: config.maxBytes * 2,
    timeIntervalMs: config.timeIntervalMs, typed: true, onCommit, assignment, notificationRecovery });
  let closed = false, available = false;
  const healthy = () => !closed && available && store.available === true;
  try {
    await store.own(async () => { available = false; onTerminal?.('EVALUATOR_OWNER_UNAVAILABLE'); });
    await store.admit(config.tenants.keys());
    await onRecovered(store);
    available = true;
    return Object.freeze({ store, canResumeVerification: healthy,
      async ready () { if (!healthy()) throw new Error('EVALUATOR_SOURCE_NOT_READY'); },
      assertAvailable () { if (!healthy()) throw new Error('EVALUATOR_FEED_UNAVAILABLE'); },
      health: () => ({ transport: 'writer-driven', healthy: healthy(), closed, schemaBlocked: false, owner: store.available, receiver: { schemaInFlight: 0 } }),
      async close () { if (closed) return; closed = true; available = false; await store.close(); } });
  } catch (error) { closed = true; available = false; await store.close(); throw error; }
}

module.exports = { open };
