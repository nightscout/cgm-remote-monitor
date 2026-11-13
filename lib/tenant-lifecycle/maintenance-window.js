'use strict';

const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const scope = require('../storage/tenant-scope');
const readiness = require('./operation-window-readiness');
const claims = new WeakMap();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX = 9223372036854775807n;
const fail = code => Object.assign(new Error(code), { code });
const qualified = (namespace, table) => '"' + namespace + '"."' + table + '"';

async function assertHeld (claim, { connection, tenant, artifactDigest } = {}) {
  const state = claims.get(claim);
  if (!state || !state.active || state.connection !== connection || state.tenant !== tenant ||
      state.digest !== artifactDigest || state.transportError || scope.currentTenant() !== tenant) {
    throw fail('LIFECYCLE_RESTORE_CLAIM_INVALID');
  }
  await state.verify();
}

function registerAfterCommit (claim, { connection, tenant, artifactDigest } = {}, fn) {
  const state = claims.get(claim);
  if (!state || !state.active || !state.transactionOpen || state.connection !== connection || state.tenant !== tenant ||
      state.digest !== artifactDigest || state.transportError || scope.currentTenant() !== tenant || typeof fn !== 'function') {
    throw fail('LIFECYCLE_RESTORE_EFFECT_INVALID');
  }
  state.effects.push(fn);
}

function create ({ namespace, locks, pool, cohort, drainTimeoutMs } = {}) {
  if (!NAME.test(namespace || '') || namespace === 'public' || namespace.startsWith('pg_') || namespace === 'information_schema' ||
      !Array.isArray(locks) || !locks.length || typeof pool?.connect !== 'function' ||
      !Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs < 1 || drainTimeoutMs > 2147483647) {
    throw new TypeError('Explicit restore namespace, tenant locks, pool, cohort and representable drain timeout required');
  }
  // Only the source-created cohort module may certify registered role contexts.
  const cohorts = require('../server/serve/operation-cohort');
  const keys = new Map(), used = new Set(), running = new Set();
  let closed = false;
  for (const row of locks) {
    if (!UUID.test(row?.tenant || '') || typeof row.key !== 'string' || !/^[1-9][0-9]*$/.test(row.key) ||
        BigInt(row.key) > MAX || keys.has(row.tenant) || used.has(row.key)) throw new TypeError('Unique provisioned restore tenant locks required');
    keys.set(row.tenant, row.key); used.add(row.key);
  }
  const windows = qualified(namespace, 'tenant_lifecycle_windows');
  const operations = qualified(namespace, 'tenant_lifecycle_operations');
  const authorityTable = qualified(namespace, 'tenant_lifecycle_restore_authority');
  const audit = qualified(namespace, 'tenant_lifecycle_restore_audit');
  const birth = qualified(namespace, 'tenant_lifecycle_backend_birth') + '()';

  async function execute (tenant, { artifactDigest } = {}, fn) {
    if (closed || !keys.has(tenant) || !DIGEST.test(artifactDigest || '') || typeof fn !== 'function') throw fail('LIFECYCLE_RESTORE_INPUT_INVALID');
    const client = await pool.connect();
    const state = { tenant, digest: artifactDigest, key: keys.get(tenant), claimId: randomUUID(), active: false,
      transactionOpen: false, locked: false, expectedAudit: 'suspended', effects: [] };
    const failed = error => { state.transportError = error; state.active = false; };
    client.on('error', failed);
    let outcome, primary, cleanupError, registration;
    async function query (text, values) {
      if (state.transportError) throw state.transportError;
      const result = await client.query({ text, values, queryMode: 'extended' });
      if (state.transportError) throw state.transportError;
      return result;
    }
    async function begin () {
      await query('BEGIN'); state.transactionOpen = true;
      await query("SELECT set_config('app.current_tenant_id',$1,true),set_config('statement_timeout',$2,true)", [tenant, String(drainTimeoutMs)]);
    }
    async function commit (stage) {
      state.commitStage = stage;
      const result = await query('COMMIT');
      if (result.command !== 'COMMIT') throw fail('LIFECYCLE_RESTORE_TRANSACTION_ABORTED');
      state.transactionOpen = false; state.commitStage = null;
    }
    async function authority () {
      const result = await query('SELECT /* restore-current-authority */ active FROM ' + authorityTable +
        ' WHERE tenant_id=$1 AND role_oid=CURRENT_USER::regrole::oid', [tenant]);
      if (result.rows.length !== 1 || result.rows[0].active !== true) throw fail('LIFECYCLE_RESTORE_AUTHORITY_REFUSED');
    }
    async function backend () {
      return (await query('SELECT /* restore-backend */ pg_backend_pid() AS pid,' + birth + '::text AS birth,CURRENT_USER::regrole::oid::text AS role_oid')).rows[0];
    }
    async function pending () {
      return (await query('SELECT /* restore-pending */ operation_id,owner_pid,owner_birth::text FROM ' + operations + ' WHERE tenant_id=$1 AND finished=false', [tenant])).rows;
    }
    async function verify () {
      if (!state.active || state.transportError || !state.transactionOpen || !state.locked) throw fail('LIFECYCLE_RESTORE_CLAIM_INVALID');
      await readiness.admit(client, namespace, { maintenance: true, identity: state.identity });
      await authority();
      const current = await backend();
      if (!current || current.pid !== state.backend.pid || current.birth !== state.backend.birth || current.role_oid !== state.backend.role_oid) throw fail('LIFECYCLE_RESTORE_BACKEND_CHANGED');
      const w = (await query('SELECT /* restore-window-current */ lock_key::text,phase,generation::text,claim_id,artifact_digest FROM ' + windows + ' WHERE tenant_id=$1', [tenant])).rows;
      if (w.length !== 1 || w[0].phase !== 'suspended' || w[0].lock_key !== state.key || w[0].generation !== state.generation ||
          w[0].claim_id !== state.claimId || w[0].artifact_digest !== state.digest) throw fail('LIFECYCLE_RESTORE_WINDOW_CHANGED');
      const a = (await query('SELECT /* restore-audit-current */ generation::text,artifact_digest,role_oid::text,owner_pid,owner_birth::text,state FROM ' + audit +
        ' WHERE tenant_id=$1 AND claim_id=$2', [tenant, state.claimId])).rows;
      if (a.length !== 1 || a[0].generation !== state.generation || a[0].artifact_digest !== state.digest || a[0].role_oid !== state.backend.role_oid ||
          a[0].owner_pid !== state.backend.pid || a[0].owner_birth !== state.backend.birth || a[0].state !== state.expectedAudit) throw fail('LIFECYCLE_RESTORE_AUDIT_CHANGED');
      const held = (await query(`SELECT /* restore-exclusive-held */ EXISTS (SELECT 1 FROM pg_locks
        WHERE locktype='advisory' AND pid=pg_backend_pid() AND mode='ExclusiveLock' AND granted
          AND classid=(($1::bigint>>32)&4294967295)::oid AND objid=($1::bigint&4294967295)::oid AND objsubid=1) AS held`, [state.key])).rows[0];
      if (held?.held !== true) throw fail('LIFECYCLE_RESTORE_LOCK_LOST');
      if ((await pending()).length) throw fail('LIFECYCLE_RESTORE_PENDING_OPERATIONS');
      await cohorts.assertComplete(cohort, tenant, { client });
    }
    state.verify = verify;
    function usable () {
      if (!state.active || !state.transactionOpen || state.transportError || scope.currentTenant() !== tenant) throw fail('LIFECYCLE_RESTORE_CONNECTION_CLOSED');
    }
    const connection = Object.freeze({
      async query (text, values) {
        usable();
        if (typeof text !== 'string') throw fail('LIFECYCLE_RESTORE_SQL_INVALID');
        let leading = text.trimStart();
        while (leading.startsWith('--') || leading.startsWith('/*')) {
          const end = leading.startsWith('--') ? leading.indexOf('\n') : leading.indexOf('*/');
          if (end < 0) throw fail('LIFECYCLE_RESTORE_SQL_INVALID');
          leading = leading.slice(end + (leading.startsWith('--') ? 1 : 2)).trimStart();
        }
        if (!/^(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(leading)) throw fail('LIFECYCLE_RESTORE_TRANSACTION_CONTROL_REFUSED');
        const result = await query(text, values); usable(); return result;
      },
      async transaction (body) { usable(); if (typeof body !== 'function') throw fail('LIFECYCLE_RESTORE_SQL_INVALID'); return body(); },
      afterCommit (fn) { usable(); registerAfterCommit(maintenanceClaim, { connection, tenant, artifactDigest }, fn); }
    });
    state.connection = connection;
    const maintenanceClaim = Object.freeze({});
    claims.set(maintenanceClaim, state);
    try {
      registration = await cohorts.pin(cohort, tenant, { client });
      await cohorts.assertComplete(cohort, tenant, { client });
      state.identity = await readiness.admit(client, namespace, { maintenance: true });
      await begin();
      await authority();
      state.backend = await backend();
      if (!state.backend || !Number.isSafeInteger(state.backend.pid) || typeof state.backend.birth !== 'string' || !state.backend.birth || !/^[1-9][0-9]*$/.test(state.backend.role_oid)) throw fail('LIFECYCLE_RESTORE_BACKEND_CHANGED');
      // Suspension changes no window key: allow registration FK references while retaining competing-writer exclusion.
      const w = (await query('SELECT /* restore-window-claim */ lock_key::text,phase,generation::text,claim_id,artifact_digest FROM ' + windows + ' WHERE tenant_id=$1 FOR NO KEY UPDATE NOWAIT', [tenant])).rows;
      if (w.length !== 1 || w[0].lock_key !== state.key || w[0].phase !== 'active' || w[0].claim_id !== null || w[0].artifact_digest !== null ||
          !/^[1-9][0-9]*$/.test(w[0].generation) || BigInt(w[0].generation) >= MAX) throw fail('LIFECYCLE_RESTORE_ALREADY_SUSPENDED');
      state.generation = (BigInt(w[0].generation) + 1n).toString();
      const changed = await query('UPDATE ' + windows + " SET phase='suspended',generation=$2,claim_id=$3,artifact_digest=$4 WHERE tenant_id=$1 AND phase='active' AND generation=$5",
        [tenant, state.generation, state.claimId, state.digest, w[0].generation]);
      if (changed.rowCount !== 1) throw fail('LIFECYCLE_RESTORE_WINDOW_CHANGED');
      const recorded = await query('INSERT INTO ' + audit + ' (tenant_id,claim_id,generation,artifact_digest) VALUES ($1,$2,$3,$4)', [tenant, state.claimId, state.generation, state.digest]);
      if (recorded.rowCount !== 1) throw fail('LIFECYCLE_RESTORE_AUDIT_CHANGED');
      await authority();
      await commit('SUSPENSION');
      const deadline = Date.now() + drainTimeoutMs;
      while (!state.locked) {
        await begin(); await authority();
        const waiting = await pending();
        await commit('DRAIN');
        if (!waiting.length) {
          const locked = (await query('SELECT /* restore-exclusive-acquire */ pg_try_advisory_lock($1::bigint) AS held', [state.key])).rows[0];
          if (locked?.held === true) { state.locked = true; break; }
        }
        if (Date.now() >= deadline) throw fail('LIFECYCLE_RESTORE_DRAIN_TIMEOUT');
        await delay(Math.min(25, Math.max(1, deadline - Date.now())));
      }
      await begin(); state.active = true;
      await scope.withTenant(tenant, async () => {
        await assertHeld(maintenanceClaim, { connection, tenant, artifactDigest });
        outcome = await fn({ connection, maintenanceClaim });
        await assertHeld(maintenanceClaim, { connection, tenant, artifactDigest });
        const updated = await query('UPDATE ' + audit + " SET state='restored',restored_at=clock_timestamp() WHERE tenant_id=$1 AND claim_id=$2 AND state='suspended'", [tenant, state.claimId]);
        if (updated.rowCount !== 1) throw fail('LIFECYCLE_RESTORE_AUDIT_CHANGED');
        state.expectedAudit = 'restored';
        await assertHeld(maintenanceClaim, { connection, tenant, artifactDigest });
        await commit('DATA'); state.active = false;
        for (const publish of state.effects) await publish();
        state.effects.length = 0;
      });
      await cohorts.invalidate(cohort, tenant);
      await cohorts.assertComplete(cohort, tenant, { client });
      await begin(); state.active = true;
      await scope.withTenant(tenant, async () => {
        await assertHeld(maintenanceClaim, { connection, tenant, artifactDigest });
        const activated = await query('UPDATE ' + windows + " SET phase='active',claim_id=NULL,artifact_digest=NULL WHERE tenant_id=$1 AND phase='suspended' AND generation=$2 AND claim_id=$3 AND artifact_digest=$4",
          [tenant, state.generation, state.claimId, state.digest]);
        if (activated.rowCount !== 1) throw fail('LIFECYCLE_RESTORE_WINDOW_CHANGED');
        const updated = await query('UPDATE ' + audit + " SET state='activated',activated_at=clock_timestamp() WHERE tenant_id=$1 AND claim_id=$2 AND state='restored'", [tenant, state.claimId]);
        if (updated.rowCount !== 1) throw fail('LIFECYCLE_RESTORE_AUDIT_CHANGED');
        await authority();
        await commit('ACTIVATION'); state.active = false;
      });
    } catch (error) {
      primary = error;
      if (state.commitStage) {
        primary = fail('LIFECYCLE_RESTORE_' + state.commitStage + '_OUTCOME_UNCERTAIN'); primary.cause = error;
      }
      if (state.transactionOpen) { try { await client.query('ROLLBACK'); } catch (error) { primary.rollbackError = error; } }
    } finally {
      state.active = false; state.effects.length = 0;
      if (state.locked) {
        try {
          const result = await client.query('SELECT pg_advisory_unlock($1::bigint) AS released', [state.key]);
          if (result.rows[0]?.released !== true) cleanupError = fail('LIFECYCLE_RESTORE_LOCK_LOST');
        } catch (error) { cleanupError = error; }
      }
      if (registration) {
        try { await cohorts.releasePin(registration); } catch (error) { cleanupError = cleanupError || error; }
      }
      try { client.release(primary || cleanupError || state.transportError || true); }
      catch (error) { cleanupError = cleanupError || error; }
      finally { client.removeListener('error', failed); }
    }
    if (cleanupError) {
      const error = fail('LIFECYCLE_RESTORE_RELEASE_FAILED'); error.cause = primary || cleanupError; error.cleanupError = cleanupError; throw error;
    }
    if (primary) throw primary;
    return { tenant, claimId: state.claimId, generation: state.generation, state: 'activated', result: outcome };
  }
  return Object.freeze({ withRestore (tenant, options, fn) {
    const work = execute(tenant, options, fn); running.add(work);
    work.then(() => running.delete(work), () => running.delete(work)); return work;
  }, async close () { closed = true; await Promise.allSettled([...running]); } });
}
function operatorGrants ({ namespace, role } = {}) {
  if (!NAME.test(namespace || '') || namespace === 'public' || namespace.startsWith('pg_') || namespace === 'information_schema' || !NAME.test(role || '')) {
    throw new TypeError('Explicit restore operator namespace and role required');
  }
  const who = '"' + role + '"';
  return Object.freeze([
    'GRANT USAGE ON SCHEMA "' + namespace + '" TO ' + who,
    ...['schema_migrations','tenant_lifecycle_windows','tenant_lifecycle_operations','tenant_lifecycle_restore_authority','tenant_lifecycle_restore_audit']
      .map(table => 'GRANT SELECT ON ' + qualified(namespace, table) + ' TO ' + who),
    'GRANT UPDATE (phase,generation,claim_id,artifact_digest) ON ' + qualified(namespace, 'tenant_lifecycle_windows') + ' TO ' + who,
    'GRANT INSERT (tenant_id,claim_id,generation,artifact_digest), UPDATE (state,restored_at,activated_at) ON ' + qualified(namespace, 'tenant_lifecycle_restore_audit') + ' TO ' + who,
    'GRANT EXECUTE ON FUNCTION ' + qualified(namespace, 'tenant_lifecycle_backend_birth') + '() TO ' + who
  ]);
}
module.exports = { create, assertHeld, registerAfterCommit, operatorGrants };
