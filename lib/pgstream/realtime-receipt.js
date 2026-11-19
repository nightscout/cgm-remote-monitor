'use strict';
// Realtime is the sole owner of completed-output delivery progress and retry.
// The evaluator's committed delivery_revision (completed output and the raw
// storage-event tail) is the obligation; the evaluator sends only a disposable
// wake naming tenants (lib/pgstream/output-wake.js). This role reads the
// indexed obligation on its own receipt, delivers through the existing addressed
// check, and records completion or one retry for the whole page. Clinical
// frames remain in the evaluator's completed-output row.
const KIND = 'realtime-output-delivery-v1';
function contractDigest(namespace,consumer){
  if(typeof namespace!=='string'||!/^[a-z][a-z0-9_]{0,62}$/.test(namespace)||namespace.startsWith('pg_')||['public','information_schema'].includes(namespace)||typeof consumer!=='string'||!/^realtime-[A-Za-z0-9_-]{1,112}$/.test(consumer))throw new TypeError('Explicit realtime receipt identity required');
  return require('node:crypto').createHash('sha256').update(JSON.stringify([KIND,namespace,consumer])).digest('hex');
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const revision = value => { if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) throw new TypeError('Exact positive delivery revision required'); return value; };
const COLUMNS = Object.freeze(['output_received','output_completed','output_owner','output_retry_at','output_delivery_version']);
const PAGE = 64;
// Lost-wake reconciliation cadence. It matches the evaluator's bounded
// recovery deadline (pgstream bounds.recoveryMs default) without a new setting.
const RECOVERY_MS = 30000;
function create ({ config, connection, worker, assertOwner = () => {}, confirmOwner = async () => {}, selectTenants = async tenants => tenants, now = Date.now }) {
  const namespace = config.namespaces.checkpoint, consumer = config.consumer;
  const source = config.completedOutput;
  if (!UUID.test(worker) || typeof assertOwner !== 'function' || !/^[a-z][a-z0-9_]{0,62}$/.test(namespace) || !/^realtime-[A-Za-z0-9_-]{1,112}$/.test(consumer) ||
      !source || !/^[a-z][a-z0-9_]{0,62}$/.test(source.namespace) || !/^evaluator-[A-Za-z0-9_-]{1,100}$/.test(source.consumer) ||
      [connection.updateRealtimeReceipts, connection.readOnly, now].some(fn => typeof fn !== 'function')) throw new TypeError('Explicit typed realtime delivery ports required');
  const table = '"' + namespace + '".tenant_consumer_checkpoint', obligations = '"' + source.namespace + '".tenant_consumer_checkpoint';
  const binding = require('./realtime-obligation').binding(source.namespace, namespace, source.consumer, consumer);
  // The inspection contract fixes these keys; `received` counts owed rows selected.
  const counters = { received: 0, completed: 0, retries: 0, workQueries: 0, metadataUpdates:0, metadataRows:0, maxMetadataBatch:0 };
  const valid = tenant => { if (!UUID.test(tenant) || tenant === '00000000-0000-0000-0000-000000000000') throw new TypeError('Canonical realtime receipt tenant required'); };
  const epoch=()=>{const at=now();if(!Number.isSafeInteger(at)||at<0||!Number.isSafeInteger(at+1000))throw new TypeError('Exact realtime receipt time required');return at;};
  const page = tenants => { const ids=[...tenants]; if(!ids.length||ids.length>PAGE||new Set(ids).size!==ids.length)throw new TypeError('Bounded realtime delivery page required'); for(const tenant of ids){valid(tenant);assertOwner(tenant);} return ids; };
  async function update (mode, rows) {
    for(const row of rows){valid(row.tenant);assertOwner(row.tenant);if(mode==='finish')revision(row.revision);}
    const result=await connection.updateRealtimeReceipts({table:namespace+'.tenant_consumer_checkpoint',consumer,worker,mode,rows,confirm:async()=>{
      if(mode==='claim')await confirmOwner();
      for(const row of rows)assertOwner(row.tenant);
    }});
    counters.metadataUpdates++;counters.metadataRows+=result.rows.length;counters.maxMetadataBatch=Math.max(counters.maxMetadataBatch,result.rows.length);
    return result.rows;
  }
  return Object.freeze({
    async verify () {
      const rows = (await connection.readOnly(`SELECT i.indisvalid,
        (SELECT count(*) FROM pg_trigger t WHERE t.tgenabled IN ('O','A') AND t.tgfoid=to_regprocedure($5)
          AND ((t.tgrelid=to_regclass($2) AND t.tgname=$6) OR (t.tgrelid=to_regclass($3) AND t.tgname IN ($4,$7)))) AS bindings
        FROM pg_index i WHERE i.indexrelid=to_regclass($1) AND i.indrelid=to_regclass($2)`,
      [namespace + '.pgstream_realtime_owed', table, obligations, binding.name, binding.functionName + '()', binding.receiptTrigger, binding.lifetimeTrigger])).rows;
      if (rows.length !== 1 || rows[0].indisvalid !== true || rows[0].bindings !== '3') throw new Error('REALTIME_RECEIPT_OBLIGATION_REQUIRED');
      await connection.readOnly('SELECT output_target,' + COLUMNS.join(',') + ' FROM ' + table + ' WHERE false');
    },
    // Both sides of this consumer's obligation live on one indexed row.
    async pending (after = null) {
      if (after !== null) valid(after);
      const { count = 1, ordinal = 0 } = config.ownership || {};
      const slice = require('../pool-membership/slice').sqlPredicate(count, ordinal, 'r.tenant_id');
      const values = [consumer, worker, epoch()];
      if (after !== null) values.push(after);
      const result = await connection.readOnly(`SELECT r.tenant_id::text AS tenant, r.output_owner::text AS owner
        FROM ${table} r WHERE r.consumer=$1 AND r.output_pending_tenant IS NOT NULL
          AND r.output_delivery_version IN (0,1) AND ${slice} ${after === null ? '' : 'AND r.output_pending_tenant>$4::uuid'}
          AND (r.output_owner IS DISTINCT FROM $2::uuid OR r.output_retry_at IS NULL OR r.output_retry_at<=$3 OR r.output_target>r.output_received)
        ORDER BY r.output_pending_tenant LIMIT 64`, values);
      const previous = result.rows.filter(row => row.owner && row.owner !== worker).map(row => row.tenant);
      if (previous.length) {
        const admitted = await selectTenants(previous);
        if (admitted.length) await update('claim', admitted.map(tenant => ({ tenant })));
      }
      return result.rows.map(row => row.tenant);
    },
    // ONE read-only statement: owed (evaluator revision above this role's
    // completion), owned or unclaimed, and due (no backoff, or a newer
    // revision than the failed attempt).
    async work (tenants) {
      const ids=page(tenants);counters.workQueries++;
      const rows=(await connection.readOnly(`SELECT r.tenant_id::text AS tenant,r.output_target::text AS received FROM ${table} r
        WHERE r.consumer=$1 AND r.tenant_id=ANY($3::uuid[]) AND r.output_delivery_version IN (0,1) AND (r.output_owner IS NULL OR r.output_owner=$2::uuid)
          AND r.output_target>r.output_completed AND (r.output_retry_at IS NULL OR r.output_retry_at<=$4 OR r.output_target>r.output_received)
        ORDER BY r.tenant_id`, [consumer, worker, ids, epoch()])).rows;
      counters.received+=rows.length;return rows;
    },
    // ONE UPDATE records the whole page: completion for delivered tenants and
    // one retry due time for the rest. Owner and monotone revision fences hold.
    async finish (rows, outcomes, due) {
      if(!Array.isArray(rows)||!rows.length||rows.length>PAGE)throw new TypeError('Bounded realtime completion page required');
      if(due===undefined)due=epoch()+1000;
      if(!Number.isSafeInteger(due)||due<0)throw new TypeError('Exact realtime retry time required');
      const values=rows.map(row=>({tenant:row.tenant,revision:row.received,ok:outcomes?.get(row.tenant)===true,due}));
      await update('finish',values);
      for(const value of values)if(value.ok)counters.completed++;else counters.retries++;
    },
    stats: () => Object.freeze({ ...counters })
  });
}
// Addressed wakes coalesce for flushMs, so the raw-tail and output revisions
// of one evaluator cycle share one delivery. A bounded paged reconciliation
// of outstanding delivery revisions runs at start and every recoveryMs; it recovers any wake
// lost in transit, before startup or across an evaluator restart.
function start ({ store, check, admits = () => true, selectTenants = async tenants => tenants, jobContext, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now, flushMs = 100, retryMs = 1000, recoveryMs = RECOVERY_MS, maxTenants = 10000 }) {
  if ([store.work, store.finish, store.pending, check, admits, selectTenants, setTimer, clearTimer, now].some(fn => typeof fn !== 'function') ||
      !Number.isSafeInteger(flushMs) || flushMs < 1 || !Number.isSafeInteger(retryMs) || retryMs < flushMs ||
      !Number.isSafeInteger(recoveryMs) || recoveryMs < retryMs || recoveryMs > 2147483647 || !Number.isSafeInteger(maxTenants) || maxTenants < 1) throw new TypeError('Bounded realtime pending scheduler required');
  const jobs=require('../server/serve/evaluator-job-context').claim(jobContext,'delivery');
  let closed = false, running = null, timer = null, timerAt = null, again = false, recoveryTimer = null, scan = null;
  const addressed = new Set(), failed = new Map();
  const counters = { batches: 0, selected: 0, maxBatch: 0, failures: 0, wakes: 0, overflow: 0, reconciliations: 0, reconciliationPages: 0 };
  function arm (delay) {
    if (closed) return;
    delay=Math.min(2147483647,Math.max(0,Math.ceil(delay)));
    const at = now() + delay;
    if (timer && timerAt <= at) return;
    if (timer) clearTimer(timer);
    timerAt = at;
    timer = setTimer(jobs.bind(() => { timer = null; timerAt = null; drain().catch(() => {}); }), delay); timer?.unref?.();
  }
  function reconcile () {
    if (closed) return;
    if (!scan) scan = { after: null };
    counters.reconciliations++;
    arm(0);
  }
  function scheduleRecovery () {
    if (closed) return;
    recoveryTimer = setTimer(jobs.bind(() => { recoveryTimer = null; try { reconcile(); } catch { counters.failures++; } scheduleRecovery(); }), recoveryMs); recoveryTimer?.unref?.();
  }
  async function nextPage () {
    // A pending reconciliation page goes first so continuous live wakes cannot
    // starve recovery; addressed wakes and due retries share later pages.
    if (scan) {
      const ids = await store.pending(scan.after);
      counters.reconciliationPages++;
      if (ids.length === PAGE) scan.after = ids.at(-1);
      else scan = null;
      if (ids.length) return ids.filter(admits);
    }
    const at = now(), ids = [];
    for (const tenant of addressed) { if (ids.length === 64) break; ids.push(tenant); }
    for (const [tenant, due] of failed) { if (ids.length === 64) break; if (due <= at && !ids.includes(tenant)) ids.push(tenant); }
    for (const tenant of ids) addressed.delete(tenant);
    return ids.filter(admits);
  }
  function drain(){return jobs.run(runDrain);}
  async function runDrain () {
    if (closed) return;
    if (running) { again = true; return running; }
    running = (async () => {
      let pages = 0;
      do {
        again = false;
        const candidates = await nextPage();
        const ids = candidates.length ? await selectTenants(candidates) : [];
        for (const tenant of candidates) if (!ids.includes(tenant)) failed.delete(tenant);
        if (!ids.length) { if (scan || addressed.size) again = true; continue; }
        let rows;const at = now();
        try { rows = await store.work(ids); }
        catch (error) { for (const tenant of ids) failed.set(tenant, now() + retryMs); throw error; }
        // A due retry that is no longer owed was completed by a newer page. A
        // retry still in backoff stays known: its durable due time excluded it.
        const owed = new Set(rows.map(row => row.tenant));
        for (const tenant of ids) if (!owed.has(tenant) && (failed.get(tenant) ?? -Infinity) <= at) failed.delete(tenant);
        if (closed || !rows.length) { again = !!scan || addressed.size > 0; continue; }
        counters.batches++; counters.selected += rows.length; counters.maxBatch = Math.max(counters.maxBatch, rows.length);
        let error, outcomes;
        // Control changes apply even to an idle or unwatched tenant.
        try { outcomes = await check(rows.map(row => row.tenant)); } catch (failure) { error = failure; counters.failures++; }
        const results=outcomes instanceof Map&&!error?outcomes:new Map(rows.map(row=>[row.tenant,false]));
        const due = now() + retryMs;
        try { await store.finish(rows, results, due); }
        catch (failure) { for (const row of rows) failed.set(row.tenant, due); throw failure; }
        for (const row of rows) { if (results.get(row.tenant) === true) failed.delete(row.tenant); else failed.set(row.tenant, due); }
        again = !!scan || addressed.size > 0;
      } while (again && !closed && ++pages < 4);
    })().catch(error => { counters.failures++; scan = null; again = false; throw error; }).finally(() => {
      running = null;
      if (closed) return;
      if (again || scan || addressed.size) arm(0);
      else if (failed.size) arm(Math.min(...failed.values()) - now());
    });
    return running;
  }
  function wake ({ tenants = [], immediate = false } = {}) {
    if (closed) return;
    for (const tenant of tenants) {
      counters.wakes++;
      if (addressed.has(tenant)) continue;
      // RAM is bounded; durable reconciliation recovers overflow.
      if (addressed.size >= maxTenants) { counters.overflow++; if (!scan) { try { reconcile(); } catch { counters.failures++; } } continue; }
      addressed.add(tenant);
    }
    if (running) { again = true; return; }
    Promise.resolve(jobs.run(()=>arm(immediate || addressed.size >= 64 ? 0 : flushMs))).catch(()=>{});
  }
  reconcile(); scheduleRecovery(); // startup repairs a COMMIT/wake crash gap
  return Object.freeze({ wake, drain, reconcile, stats: () => Object.freeze({ ...counters, addressed: addressed.size, failed: failed.size }),
    async close () { closed = true; for (const value of [timer, recoveryTimer]) if (value) clearTimer(value); timer = null; recoveryTimer = null; await Promise.allSettled([running]); jobs.close(); } });
}
module.exports = { create, start, KIND, COLUMNS, revision, contractDigest, RECOVERY_MS };
