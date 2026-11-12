'use strict';

// Actual runtime/alarm/outbox components with SQL protocol doubles and a fake
// adapter. This is not PostgreSQL, Socket.IO or native role acceptance.
const createRuntime = require('../../lib/server/serve/evaluator-runtime');
const coordinate = require('../../lib/server/serve/evaluator-consumers').coordinate;
const notifications = require('./tenant-notifications');
const alarms = require('./tenant-alarm-protocol');
const A = alarms.A, B = alarms.B;
module.exports = async function protocol (send, {operationWindow, pool} = {}) {
  const alarm = alarms(), files = new Map([[A, notifications()], [B, notifications()]]);
  const clinicalTimers = [], consumerTimers = [], cancelled = [], effects = [], refusal = new Set();
  const configs = new Map([A, B].map(tenant => [tenant, { tenant, identity: '1'.repeat(64) }]));
  const notice = tenant => notifications.notification({ message: 'Synthetic ' + tenant.slice(0, 1) });
  const evaluated = [];
  const jobs = require('../../lib/server/serve/evaluator-job-context');
  const runtime = await createRuntime({ jobContext: operationWindow ? jobs.create('clinical') : undefined, operationWindow, pool, tenants: [A, B], readCurrent: async tenant => configs.get(tenant),
    create: async current => ({ async evaluate ({ at }) {
      evaluated.push(current.tenant);
      if (refusal.has(current.tenant)) throw new Error('Synthetic clinical acquisition refused');
      return { tenant: current.tenant, checkpoint: 0, now: at, emitted: [notice(current.tenant)], requested: [{...notice(current.tenant), kind:'notify'}], properties: { synthetic: true } };
    }, async evaluateTime ({ at }) { return { tenant: current.tenant, checkpoint: 0, now: at,
      emitted: [notice(current.tenant)], requested: [{...notice(current.tenant), kind:'notify'}], properties: { synthetic: true } }; }, close () {} }),
    recoveryIntervalMs: 100, timeIntervalMs: 200, now: () => files.get(A).now(),
    schedule (fn, interval) { const timer = { fn, interval }; clinicalTimers.push(timer); return timer; }, cancel: timer => cancelled.push(timer) });
  const store = Object.fromEntries(['ready', 'consume', 'enqueue', 'due', 'begin', 'dispatch', 'finish', 'receipts'].map(method => [method,
    input => files.get(typeof input === 'string' ? input : input.tenant).store[method](input)]));
  const adapter = { id: 'realtime-test', send (request, callback) {
    effects.push(request);
    if (send) send(request, callback);
    else callback(null, { accepted: true, receipt: null, clearedRequestIds: [] });
  } };
  const consumers = coordinate({ jobContext: operationWindow ? jobs.create('delivery') : undefined, operationWindow, pool, tenants: [A, B], route: adapter.id, current: runtime.last, currentConfig:async tenant=>configs.get(tenant), isCurrent: runtime.isCurrent,
    store, reader: alarm.reader, adapter, now: () => files.get(A).now(), maxRows: 10, maxBytes: 100000, maxPayloadBytes: 10000,
    maxInflight: 2, attemptTimeoutMs: 60000, retryDelayMs: 1, pollIntervalMs: 100, retryIntervalMs: 200,
    schedule (fn, interval) { const timer = { fn, interval }; consumerTimers.push(timer); return timer; }, cancel: timer => cancelled.push(timer) });
  return { A, B, alarm, runtime, consumers, files, effects, evaluated, configs, refusal, consumerTimers, clinicalTimers, cancelled,
    advance (ms) { for (const f of files.values()) f.advance(ms); alarm.now = files.get(A).now(); },
    async start () { consumers.start(); await Promise.all([consumers.flush(A), consumers.flush(B)]); },
    async close () { await Promise.all([consumers.close(), runtime.close()]); }
  };
};
