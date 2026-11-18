'use strict';

// Operator recovery for a tenant-local restore that did not finish (decision
// restore-resume-and-precheck). Three operations on one private operator
// backend, each bound to the same current authority, schema admission and
// source-created cohort as the restore controller (maintenance-window.js):
//
//   inspect          read-only: what holds the tenant closed, and what an
//                    operator may do about it.
//   resume           reopen a tenant whose restore owner is provably gone.
//   clearOperations  record that an unfinished operation has no owner left.
//
// Neither writing operation changes or deletes an existing record. A resume
// is one row in tenant_lifecycle_restore_resume beside the unchanged restore
// audit row; a clearance is one row in tenant_lifecycle_operation_clearance
// beside the unchanged operation record (migration 0009).
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const readiness = require('./operation-window-readiness');
const { pendingSQL } = require('./maintenance-window');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const MAX = 9223372036854775807n;
const fail = (code, detail) => Object.assign(new Error(code), { code }, detail);
const qualified = (namespace, table) => '"' + namespace + '"."' + table + '"';
// The restore audit state names the two cases. The data transaction sets
// `restored` in the same commit as the replaced rows, so `suspended` means no
// replaced row is durable.
const INTERRUPTED = Object.freeze({ suspended: 'before-data', restored: 'data-replaced' });

function create ({ namespace, locks, pool, cohort, statementTimeoutMs = 10000, lockWaitMs = 2000, intakeProfile, nativeSelection } = {}) {
  if(nativeSelection!==undefined){nativeSelection=require('./native-selection').bind(nativeSelection,namespace);if(intakeProfile!==undefined)throw new TypeError('LIFECYCLE_NATIVE_SELECTION_INVALID');}
  if(intakeProfile!==undefined)intakeProfile = require('./generation-domain').bind(intakeProfile,namespace,Array.isArray(locks)?locks.map(row=>row.tenant):undefined);
  if (!NAME.test(namespace || '') || namespace === 'public' || namespace.startsWith('pg_') || namespace === 'information_schema' ||
      !Array.isArray(locks) || !locks.length || typeof pool?.connect !== 'function' ||
      !Number.isSafeInteger(statementTimeoutMs) || statementTimeoutMs < 1 || statementTimeoutMs > 2147483647 ||
      !Number.isSafeInteger(lockWaitMs) || lockWaitMs < 0 || lockWaitMs > 2147483647) {
    throw new TypeError('Explicit resume namespace, tenant locks, pool, cohort and representable timeouts required');
  }
  const cohorts = require('../server/serve/operation-cohort');
  const keys = new Map(), used = new Set(), running = new Set();
  let closed = false;
  for (const row of locks) {
    if (!UUID.test(row?.tenant || '') || typeof row.key !== 'string' || !/^[1-9][0-9]*$/.test(row.key) ||
        BigInt(row.key) > MAX || keys.has(row.tenant) || used.has(row.key)) throw new TypeError('Unique provisioned resume tenant locks required');
    keys.set(row.tenant, row.key); used.add(row.key);
  }
  const windows = qualified(namespace, 'tenant_lifecycle_windows');
  const authorityTable = qualified(namespace, 'tenant_lifecycle_restore_authority');
  const audit = qualified(namespace, 'tenant_lifecycle_restore_audit');
  const resumes = qualified(namespace, 'tenant_lifecycle_restore_resume');
  const clearance = qualified(namespace, 'tenant_lifecycle_operation_clearance');

  // One operator backend per operation, destroyed afterwards like the restore
  // controller's. `write` names the commit whose lost reply is uncertain.
  async function session (tenant, { pinned }, body) {
    if (closed || !keys.has(tenant)) throw fail('LIFECYCLE_RESUME_INPUT_INVALID');
    const client = await pool.connect();
    const state = { open: false, commit: null };
    const failed = error => { state.transportError = error; };
    client.on('error', failed);
    let outcome, primary, cleanupError, registration;
    async function query (text, values) {
      if (state.transportError) throw state.transportError;
      const result = await client.query({ text, values, queryMode: 'extended' });
      if (state.transportError) throw state.transportError;
      return result;
    }
    const api = {
      client, query,
      async begin () {
        await query('BEGIN'); state.open = true;
        await query("SELECT set_config('app.current_tenant_id',$1,true),set_config('statement_timeout',$2,true)", [tenant, String(statementTimeoutMs)]);
        // Backend liveness is read from statistics, which a transaction caches.
        await query('SELECT /* resume-refresh */ pg_catalog.pg_stat_clear_snapshot()');
      },
      async commit (stage) {
        state.commit = stage;
        const result = await query('COMMIT');
        if (result.command !== 'COMMIT') throw fail('LIFECYCLE_RESUME_TRANSACTION_ABORTED');
        state.open = false; state.commit = null;
      },
      async authority () {
        const result = await query('SELECT /* resume-current-authority */ active FROM ' + authorityTable +
          ' WHERE tenant_id=$1 AND role_oid=CURRENT_USER::regrole::oid', [tenant]);
        if (result.rows.length !== 1 || result.rows[0].active !== true) throw fail('LIFECYCLE_RESUME_AUTHORITY_REFUSED');
      },
      async rollback () { await query('ROLLBACK'); state.open = false; },
      async pending () { return (await query(pendingSQL(namespace, 'resume-pending'), [tenant])).rows; }
    };
    try {
      if (pinned) {
        // Fresh acknowledgement: every participant in the fixed manifest answers
        // now, with one schema identity and datastore, and every backend that can
        // touch clinical rows belongs to one of them.
        registration = await cohorts.pin(cohort, tenant, { client });
        await cohorts.assertComplete(cohort, tenant, { client });
      }
      await readiness.admit(client, namespace, { maintenance: true, intakeProfile:intakeProfile||nativeSelection });
      outcome = await body(api);
    } catch (error) {
      primary = error;
      if (state.commit) primary = fail('LIFECYCLE_RESUME_' + state.commit + '_OUTCOME_UNCERTAIN', { cause: error });
      if (state.open) { try { await client.query('ROLLBACK'); } catch (error) { primary.rollbackError = error; } }
    } finally {
      if (registration) { try { await cohorts.releasePin(registration); } catch (error) { cleanupError = error; } }
      try { client.release(primary || cleanupError || state.transportError || true); }
      catch (error) { cleanupError = cleanupError || error; }
      finally { client.removeListener('error', failed); }
    }
    if (cleanupError) throw fail('LIFECYCLE_RESUME_RELEASE_FAILED', { cause: primary || cleanupError, cleanupError });
    if (primary) throw primary;
    return outcome;
  }

  // What is durable for the tenant now. `lock` takes the same bounded non-key
  // row claim a restore takes, so a restore and a resume cannot both proceed.
  async function read (s, tenant, { lock = false } = {}) {
    const w = (await s.query('SELECT /* resume-window */ lock_key::text,phase,generation::text,claim_id,artifact_digest FROM ' + windows +
      ' WHERE tenant_id=$1' + (lock ? ' FOR NO KEY UPDATE NOWAIT' : ''), [tenant])).rows;
    if (w.length !== 1 || w[0].lock_key !== keys.get(tenant) || !/^[1-9][0-9]*$/.test(w[0].generation || '')) throw fail('LIFECYCLE_RESUME_WINDOW_CHANGED');
    const window = w[0];
    let restore = null;
    if (window.phase === 'suspended') {
      // The read policy shows only this role's own restores: a claim made by
      // another database role is not this operator's to resume.
      const a = (await s.query('SELECT /* resume-audit */ a.generation::text AS generation,a.artifact_digest,a.state,a.owner_pid,a.owner_birth::text AS owner_birth,' +
        'EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity b WHERE b.pid=a.owner_pid AND (b.backend_start IS NULL OR b.backend_start=a.owner_birth)) AS owner_present,' +
        'EXISTS (SELECT 1 FROM ' + resumes + ' r WHERE r.claim_id=a.claim_id) AS resumed FROM ' + audit + ' a WHERE a.tenant_id=$1 AND a.claim_id=$2', [tenant, window.claim_id])).rows;
      if (a.length === 1) restore = a[0];
    }
    return { window, restore };
  }
  function describe (tenant, { window, restore }) {
    const reasons = [];
    if(intakeProfile)try{require('./generation-domain').assertGeneration(window.generation);}catch(error){reasons.push(error.code);}
    const interrupted = restore && Object.hasOwn(INTERRUPTED, restore.state) ? INTERRUPTED[restore.state] : null;
    if (window.phase !== 'suspended') reasons.push('LIFECYCLE_RESUME_NOT_SUSPENDED');
    else if (!restore) reasons.push('LIFECYCLE_RESUME_AUDIT_UNAVAILABLE');
    else {
      if (!interrupted || restore.resumed || restore.generation !== window.generation || restore.artifact_digest !== window.artifact_digest) reasons.push('LIFECYCLE_RESUME_AUDIT_CHANGED');
      if (restore.owner_present !== false) reasons.push('LIFECYCLE_RESUME_RESTORE_OWNER_PRESENT');
    }
    return { tenant, phase: window.phase, generation: window.generation, claimId: window.claim_id, artifactDigest: window.artifact_digest,
      restore: restore ? { state: restore.state, ownerPresent: restore.owner_present !== false } : null, interrupted,
      resumable: reasons.length === 0, reasons };
  }

  function inspect (tenant) {
    return session(tenant, { pinned: false }, async s => {
      await s.begin(); await s.authority();
      const result = describe(tenant, await read(s, tenant));
      const pending = await s.pending();
      result.operations = { unfinished: pending.length, ownerGone: pending.filter(row => row.gone === true).length };
      await s.rollback();
      return result;
    });
  }

  function resume (tenant, { claimId } = {}) {
    if (!UUID.test(claimId || '')) return Promise.reject(fail('LIFECYCLE_RESUME_INPUT_INVALID'));
    return session(tenant, { pinned: true }, async s => {
      await s.begin(); await s.authority();
      const current = await read(s, tenant, { lock: true });
      const seen = describe(tenant, current);
      // The operator resumes the claim they inspected, not whichever holds now.
      if (seen.phase === 'suspended' && seen.claimId !== claimId) throw fail('LIFECYCLE_RESUME_CLAIM_MISMATCH');
      if (!seen.resumable) throw fail(seen.reasons[0], { reasons: seen.reasons });
      // Both interruption stages advanced the generation. Exclude physical
      // transactions while invalidating participant state and committing activation.
      for (const deadline = Date.now() + lockWaitMs; ;) {
        const locked = (await s.query('SELECT /* resume-exclusive */ pg_try_advisory_xact_lock($1::bigint) AS held', [keys.get(tenant)])).rows[0];
        if (locked?.held === true) break;
        if (Date.now() >= deadline) throw fail('LIFECYCLE_RESUME_LOCK_BUSY');
        await delay(Math.min(25, Math.max(1, deadline - Date.now())));
      }
      await cohorts.invalidate(cohort, tenant);
      await cohorts.assertComplete(cohort, tenant, { client: s.client });
      await s.query('SELECT /* resume-refresh */ pg_catalog.pg_stat_clear_snapshot()');
      const again = await read(s, tenant);
      if (again.restore?.owner_present !== false || again.restore.state !== current.restore.state) throw fail('LIFECYCLE_RESUME_AUDIT_CHANGED');
      const resumeId = randomUUID();
      const activated = await s.query('UPDATE ' + windows + " SET phase='active',claim_id=NULL,artifact_digest=NULL WHERE tenant_id=$1 AND phase='suspended' AND generation=$2 AND claim_id=$3 AND artifact_digest=$4",
        [tenant, seen.generation, claimId, seen.artifactDigest]);
      if (activated.rowCount !== 1) throw fail('LIFECYCLE_RESUME_WINDOW_CHANGED');
      const recorded = await s.query('INSERT INTO ' + resumes + ' (tenant_id,resume_id,claim_id,generation,artifact_digest,interrupted) VALUES ($1,$2,$3,$4,$5,$6)',
        [tenant, resumeId, claimId, seen.generation, seen.artifactDigest, seen.interrupted]);
      if (recorded.rowCount !== 1) throw fail('LIFECYCLE_RESUME_AUDIT_CHANGED');
      const recommission = require('./recommission-control');
      if (seen.interrupted === 'data-replaced' && recommission.selected(intakeProfile||nativeSelection)) await recommission.activate(s.query, {
        namespace, tenant, claimId, generation: seen.generation, artifactDigest: seen.artifactDigest
      });
      await s.authority();
      await s.commit('RESUME');
      return { tenant, resumeId, claimId, generation: seen.generation, interrupted: seen.interrupted, state: 'active' };
    });
  }

  // A record is cleared only when both hold: no backend can be its owner (the
  // database's own session list), and no participant process is still running
  // it (each participant's fresh answer, under the pin). Either alone is not
  // enough: a process that lost its connection can still be inside the body.
  function clearOperations (tenant) {
    return session(tenant, { pinned: true }, async s => {
      await s.begin(); await s.authority();
      const before = await s.pending();
      const running = new Set((await cohorts.operations(cohort, tenant)).operations);
      await cohorts.assertComplete(cohort, tenant, { client: s.client });
      const cleared = [], retained = [];
      for (const row of before) {
        if (row.gone !== true) retained.push({ operation: row.operation_id, reason: 'OWNER_BACKEND_PRESENT' });
        else if (running.has(row.operation_id)) retained.push({ operation: row.operation_id, reason: 'OWNER_PROCESS_RUNNING' });
        else {
          const recorded = await s.query('INSERT INTO ' + clearance + ' (tenant_id,operation_id,generation,marker_pid,marker_birth) VALUES ($1,$2,$3,$4,$5::timestamptz)',
            [tenant, row.operation_id, row.generation, row.owner_pid, row.owner_birth]);
          if (recorded.rowCount !== 1) throw fail('LIFECYCLE_CLEARANCE_CHANGED');
          cleared.push(row.operation_id);
        }
      }
      await s.authority();
      if (cleared.length) await s.commit('CLEARANCE'); else await s.rollback();
      return { tenant, cleared, retained };
    });
  }

  const track = work => { running.add(work); work.then(() => running.delete(work), () => running.delete(work)); return work; };
  return Object.freeze({
    inspect: tenant => track(inspect(tenant)),
    resume: (tenant, options) => track(resume(tenant, options)),
    clearOperations: tenant => track(clearOperations(tenant)),
    async close () { closed = true; await Promise.allSettled([...running]); }
  });
}
module.exports = { create, INTERRUPTED };
