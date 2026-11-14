'use strict';
// Only typed delivery generations are mutable scheduling authority. Clinical
// frames remain in the evaluator's completed-output row.
const KIND = 'realtime-output-delivery-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const revision = value => { if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) throw new TypeError('Exact positive delivery revision required'); return value; };
const COLUMNS = Object.freeze(['output_received','output_completed','output_owner','output_retry_at','output_delivery_version']);
function create ({ config, connection, worker, assertOwner = () => {}, now = Date.now }) {
  const namespace = config.namespaces.checkpoint, consumer = config.consumer;
  if (!UUID.test(worker) || typeof assertOwner !== 'function' || !/^[a-z][a-z0-9_]{0,62}$/.test(namespace) || !/^realtime-[A-Za-z0-9_-]{1,112}$/.test(consumer) ||
      [connection.updateRealtimeReceipts, connection.readOnly, now].some(fn => typeof fn !== 'function')) throw new TypeError('Explicit typed realtime delivery ports required');
  const table = '"' + namespace + '".tenant_consumer_checkpoint';
  const counters = { received: 0, completed: 0, retries: 0, workQueries: 0, metadataUpdates:0, metadataRows:0, maxMetadataBatch:0 };
  const valid = tenant => { if (!UUID.test(tenant) || tenant === '00000000-0000-0000-0000-000000000000') throw new TypeError('Canonical realtime receipt tenant required'); };
  const epoch=()=>{const at=now();if(!Number.isSafeInteger(at)||at<0||!Number.isSafeInteger(at+1000))throw new TypeError('Exact realtime receipt time required');return at;};
  async function update (mode, rows) {
    for(const row of rows){valid(row.tenant);assertOwner(row.tenant);if(mode!=='claim')revision(row.revision);}
    const result=await connection.updateRealtimeReceipts({table:namespace+'.tenant_consumer_checkpoint',consumer,worker,mode,rows});
    for(const row of rows)assertOwner(row.tenant);
    counters.metadataUpdates++;counters.metadataRows+=result.rows.length;counters.maxMetadataBatch=Math.max(counters.maxMetadataBatch,result.rows.length);
    return result.rows;
  }
  return Object.freeze({
    async verify () {
      const rows = (await connection.readOnly('SELECT i.indisvalid FROM pg_index i WHERE i.indexrelid=to_regclass($1) AND i.indrelid=to_regclass($2)', [namespace + '.pgstream_realtime_pending', namespace + '.tenant_consumer_checkpoint'])).rows;
      if (rows.length !== 1 || rows[0].indisvalid !== true) throw new Error('REALTIME_RECEIPT_PENDING_INDEX_REQUIRED');
      await connection.readOnly('SELECT ' + COLUMNS.join(',') + ' FROM ' + table + ' WHERE false');
    },
    async receive (tenant, received) {
      const rows=await update('receive',[{tenant,revision:revision(received)}]);
      counters.received++;return rows[0].received;
    },
    async recover (tenants) {
      const ids=[...tenants];
      if(ids.length>config.maxTenants||new Set(ids).size!==ids.length)throw new TypeError('Bounded owned realtime recovery roster required');
      for(let offset=0;offset<ids.length;offset+=64)await update('claim',ids.slice(offset,offset+64).map(tenant=>({tenant})));
    },
    async work (limit = 64) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw new TypeError('Bounded realtime receipt page required');
      counters.workQueries++;
      return (await connection.readOnly(`SELECT tenant_id::text AS tenant,output_received::text AS received FROM ${table} WHERE consumer=$1 AND output_owner=$2::uuid AND output_delivery_version=1 AND output_received>output_completed AND (output_retry_at IS NULL OR output_retry_at<=$3) ORDER BY output_retry_at NULLS FIRST,tenant_id LIMIT $4`, [consumer, worker, epoch(), limit])).rows;
    },
    async nextDue () {
      counters.workQueries++;
      const row=(await connection.readOnly(`SELECT min(output_retry_at)::text AS due FROM ${table} WHERE consumer=$1 AND output_owner=$2::uuid AND output_delivery_version=1 AND output_received>output_completed`,[consumer,worker])).rows[0];
      if(row?.due===null || row?.due===undefined)return null;
      const due=Number(row.due);
      if(!Number.isSafeInteger(due)||due<0)throw new Error('REALTIME_RECEIPT_DUE_INVALID');
      return due;
    },
    async complete (tenant, received) {await update('complete',[{tenant,revision:received}]);counters.completed++;},
    async retry (tenant, received) {await update('retry',[{tenant,revision:received,due:epoch()+1000}]);counters.retries++;},
    async finish (rows, outcomes) {
      const complete=[],retry=[],due=epoch()+1000;
      if(!Array.isArray(rows)||rows.length>64)throw new TypeError('Bounded realtime completion page required');
      for(const row of rows)(outcomes?.get(row.tenant)===true?complete:retry).push({tenant:row.tenant,revision:row.received,...(outcomes?.get(row.tenant)===true?{}:{due})});
      const results=await Promise.allSettled([complete.length?update('complete',complete):null,retry.length?update('retry',retry):null]);
      const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;
      counters.completed+=complete.length;counters.retries+=retry.length;
    },
    stats: () => Object.freeze({ ...counters })
  });
}
function start ({ store, check, watched, jobContext, setTimer = setTimeout, clearTimer = clearTimeout, flushMs = 100, retryMs = 1000 }) {
  if ([store.work, store.nextDue, store.complete, store.retry, check, watched, setTimer, clearTimer].some(fn => typeof fn !== 'function') ||
      !Number.isSafeInteger(flushMs) || flushMs < 1 || !Number.isSafeInteger(retryMs) || retryMs < flushMs) throw new TypeError('Bounded realtime pending scheduler required');
  const jobs=require('../server/serve/evaluator-job-context').claim(jobContext,'delivery');
  let closed = false, running = null, timer = null, timerAt = null, demand = 0, again = false;
  const counters = { batches: 0, selected: 0, maxBatch: 0, failures: 0 };
  function arm (delay) {
    if (closed) return;
    delay=Math.min(2147483647,Math.max(0,Math.ceil(delay)));
    const at = Date.now() + delay;
    if (timer && timerAt <= at) return;
    if (timer) clearTimer(timer);
    timerAt = at;
    timer = setTimer(jobs.bind(() => { timer = null; timerAt = null; drain().catch(() => {}); }), delay); timer.unref?.();
  }
  function drain(){return jobs.run(runDrain);}
  async function runDrain () {
    if (closed) return;
    if (running) { again = true; return running; }
    demand = 0;
    running = (async () => {
      let pages = 0;
      do {
        again = false;
        const rows = await store.work(64);
        if (closed || !rows.length) return;
        counters.batches++; counters.selected += rows.length; counters.maxBatch = Math.max(counters.maxBatch, rows.length);
        const selected = rows; // Control changes apply even to an idle or unwatched tenant.
        let error, outcomes;
        try { if (selected.length) outcomes = await check(selected.map(row => row.tenant)); } catch (failure) { error = failure; counters.failures++; }
        const results=outcomes instanceof Map?outcomes:new Map(rows.map(row=>[row.tenant,!error]));
        if(store.finish)await store.finish(rows,results);
        else {
          const acknowledgements=await require('../server/serve/tenant-startup').settleLimited(rows,4,row => results.get(row.tenant)!==true ? store.retry(row.tenant, row.received) : store.complete(row.tenant, row.received));
          const failure=acknowledgements.find(value=>value.status==='rejected');if(failure)throw failure.reason;
        }
        // This timer owns known failed work only; an empty healthy worker has
        // no discovery timer or SQL. A new receipt can advance the retry.

        if (rows.length === 64) again = true;
      } while (again && !closed && ++pages < 4);
      if (again) arm(0);
    })().then(async () => {
      // Reconstruct the earliest actual durable retry, including a later page
      // whose due time outlives the first page's timer. No idle polling follows.
      const due = await store.nextDue();
      if(due!==null)arm(Math.max(0,due-Date.now()));
    }).catch(error => { counters.failures++; arm(retryMs); throw error; }).finally(() => { running = null; if (again && !closed) arm(0); });
    return running;
  }
  function wake ({ immediate = false } = {}) {
    if (closed) return;
    demand++;
    if (running) { again = true; return; }
    Promise.resolve(jobs.run(()=>arm(immediate || demand >= 64 ? 0 : flushMs))).catch(()=>{});
  }
  wake({ immediate: true }); // startup repairs a COMMIT/wake/ACK crash gap
  return Object.freeze({ wake, drain, stats: () => Object.freeze({ ...counters }),
    async close () { closed = true; if (timer) clearTimer(timer); timer = null; await Promise.allSettled([running]); jobs.close(); } });
}
module.exports = { create, start, KIND, COLUMNS, revision };
