'use strict';

// One short-lived deployment recovery slot supplies an exact snapshot prefix.
// The ordinary maintained stream retains its slot and continues afterwards.
// This component owns neither warm input nor a second change log.
const { createHash, randomBytes } = require('node:crypto');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const error = code => Object.assign(new Error(code), { code });
function lockKey (namespace, consumer) {
  if (!NAME.test(namespace) || !/^evaluator-[A-Za-z0-9_-]{1,100}$/.test(consumer)) throw new TypeError('Explicit clinical recovery binding required');
  return createHash('sha256').update(JSON.stringify(['nightscout-clinical-recovery-v1', namespace, consumer])).digest().readBigInt64BE().toString();
}
function source (value) {
  if (!value || typeof value.system_id !== 'string' || !/^[0-9]+$/.test(value.system_id) ||
      !Number.isSafeInteger(value.timeline) || value.timeline < 1 || typeof value.database !== 'string' || !value.database || !NAME.test(value.slot)) {
    throw error('CLINICAL_RECOVERY_SOURCE');
  }
  return { system_id: value.system_id, timeline: value.timeline, database: value.database, slot: value.slot };
}
function create ({ connection, createReplicationClient, createLockClient, namespace, consumer, mainSource, generation, timeoutMs, maxQueued = 32 }) {
  if (typeof connection?.importedSnapshotTransaction !== 'function' ||
      [createReplicationClient, createLockClient, generation].some(fn => typeof fn !== 'function') ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647 ||
      !Number.isSafeInteger(maxQueued) || maxQueued < 1 || maxQueued > 1024) throw new TypeError('Explicit bounded clinical recovery ports required');
  const expected = Object.freeze(source(mainSource)), key = lockKey(namespace, consumer);
  let queue = Promise.resolve(), queued = 0, closed = false, active;
  async function recover (tenant, fn) {
    if (closed) throw error('CLINICAL_RECOVERY_CLOSED');
    const controller = new AbortController(), deadlineAt = Date.now() + timeoutMs; active = controller;
    const ended = new Map(); let timer, lock, exporter, slot, stopping;
    const end = client => {
      if (!client) return Promise.resolve();
      if (!ended.has(client)) ended.set(client, Promise.resolve().then(() => client.end()));
      return ended.get(client);
    };
    const stop = () => {
      if (stopping) return stopping;
      stopping = (async () => {
        let cleanupTimer, cancel, cleanupExpired = false;
        const cleanup = (async () => {
          if (controller.signal.aborted && lock && Number.isSafeInteger(lock.processID) && lock.processID > 0) {
            // A queued advisory-lock query also needs server-side cancellation.
            cancel = createLockClient(); cancel.on?.('error', () => {});
            try {
              await cancel.connect();
              await cancel.query('SELECT pg_cancel_backend(pid) AS cancelled FROM pg_stat_activity WHERE pid=' + lock.processID + ' AND usename=current_user');
            } finally { await end(cancel); }
          }
          if (controller.signal.aborted && exporter && Number.isSafeInteger(exporter.processID) && exporter.processID > 0) {
            // PostgreSQL can keep CREATE_REPLICATION_SLOT waiting after socket
            // close. Cancel the still-connected exporter through its own role;
            // the ordinary evaluator never receives signal-backend privilege.
            cancel = createReplicationClient(); cancel.on?.('error', () => {});
            try {
              await cancel.connect();
              await cancel.query('SELECT pg_cancel_backend(pid) AS cancelled FROM pg_stat_activity WHERE pid=' + exporter.processID + ' AND usename=current_user');
            } finally { await end(cancel); }
          }
          await end(exporter);
          if (slot && lock) {
            // Socket closure is not server-side slot absence. Keep exclusive
            // recovery ownership until the exact in-progress slot is gone.
            for (;;) {
              if (cleanupExpired) throw error('CLINICAL_RECOVERY_CLEANUP_UNCONFIRMED');
              const row = (await lock.query('SELECT NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name=$1) AS absent', [slot])).rows[0];
              if (row?.absent === true) break;
              await new Promise(resolve => setTimeout(resolve, 10));
            }
          }
        })();
        try {
          await Promise.race([cleanup, new Promise((resolve, reject) => {
            cleanupTimer = setTimeout(() => {
              cleanupExpired = true;
              end(cancel).catch(() => {}); end(exporter).catch(() => {}); end(lock).catch(() => {});
              reject(error('CLINICAL_RECOVERY_CLEANUP_UNCONFIRMED'));
            }, 1000);
          })]);
        } catch (failure) { closed = true; throw failure; }
        finally { clearTimeout(cleanupTimer); await end(lock); }
      })();
      return stopping;
    };
    const abort = () => controller.abort(error('CLINICAL_RECOVERY_DEADLINE'));
    controller.signal.addEventListener('abort', () => { stop().catch(() => {}); }, { once: true });
    const check = () => { if (controller.signal.aborted) throw controller.signal.reason; };
    const deadline = new Promise((resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      timer = setTimeout(abort, timeoutMs);
    });
    const work = (async () => {
      lock = createLockClient(); lock.on?.('error', () => {});
      await lock.connect(); check();
      await lock.query('SELECT pg_advisory_lock($1::bigint)', [key]); check();
      const restoreGeneration = String(await generation(tenant));
      if (!/^[A-Za-z0-9_-]{1,64}:(0|[1-9][0-9]{0,18})$/.test(restoreGeneration)) throw error('CLINICAL_RECOVERY_GENERATION');
      check();
      exporter = createReplicationClient(); exporter.on?.('error', () => {});
      await exporter.connect(); check();
      const identity = (await exporter.query('IDENTIFY_SYSTEM')).rows[0]; check();
      if (String(identity?.systemid) !== expected.system_id || Number(identity?.timeline) !== expected.timeline || identity?.dbname !== expected.database) throw error('CLINICAL_RECOVERY_SOURCE_CHANGED');
      // Bound PostgreSQL itself as well as the client deadline while an older
      // writing transaction delays slot consistency. This command precedes
      // export; no command may run on exporter after it returns a snapshot.
      await exporter.query('SET statement_timeout TO ' + Math.max(1, deadlineAt - Date.now())); check();
      slot = 'ns_recovery_' + randomBytes(12).toString('hex');
      const exported = (await exporter.query('CREATE_REPLICATION_SLOT ' + slot + ' TEMPORARY LOGICAL wal2json EXPORT_SNAPSHOT')).rows[0]; check();
      if (exported?.slot_name !== slot || exported.output_plugin !== 'wal2json' ||
          typeof exported.snapshot_name !== 'string' || !/^[0-9A-Fa-f]+-[0-9A-Fa-f]+-[0-9]+$/.test(exported.snapshot_name) ||
          typeof exported.consistent_point !== 'string' || !/^[0-9A-Fa-f]{1,8}\/[0-9A-Fa-f]{1,8}$/.test(exported.consistent_point)) throw error('CLINICAL_RECOVERY_EXPORT');
      const descriptor = Object.freeze({ source_identity: expected, generation: restoreGeneration, snapshot_position: exported.consistent_point });
      // Do not issue another command on exporter before import: PostgreSQL
      // invalidates its exported name on the next command or connection loss.
      return connection.importedSnapshotTransaction(exported.snapshot_name, async () => {
        check();
        if (String(await generation(tenant)) !== restoreGeneration) throw error('CLINICAL_RECOVERY_GENERATION_CHANGED');
        const result = await fn(descriptor, controller.signal); check();
        return result;
      }, { signal: controller.signal, timeoutMs: Math.max(1, deadlineAt - Date.now()) });
    })();
    let primary, result;
    try { result = await Promise.race([work, deadline]); }
    catch (failure) { primary = failure; }
    clearTimeout(timer); if (active === controller) active = undefined;
    try { await stop(); }
    catch (cleanupFailure) { if (primary) cleanupFailure.cause = primary; throw cleanupFailure; }
    if (primary) throw primary;
    return result;
  }
  return Object.freeze({
    lockKey: key,
    withSnapshot ({ tenant, fn }) {
      if (!UUID.test(tenant) || typeof fn !== 'function') throw new TypeError('Explicit tenant recovery callback required');
      if (closed) return Promise.reject(error('CLINICAL_RECOVERY_CLOSED'));
      if (queued >= maxQueued) return Promise.reject(error('CLINICAL_RECOVERY_QUEUE_BOUND'));
      queued++;
      const result = queue.then(() => recover(tenant, fn));
      queue = result.catch(() => {}).finally(() => { queued--; });
      return result;
    },
    async close () {
      closed = true;
      if (active) active.abort(error('CLINICAL_RECOVERY_CLOSED'));
      await queue;
    }
  });
}
module.exports = { create, lockKey };
