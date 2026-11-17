'use strict';
// Realtime is the sole owner of completed-output delivery progress. The
// evaluator commits delivery_revision and sends a disposable wake. Physical
// PostgreSQL fences belong to pgstream-typed-migration.integration.test.js.
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const receipts=require('../lib/pgstream/realtime-receipt');
const wakes=require('../lib/pgstream/output-wake');
const contexts=require('../lib/server/serve/evaluator-job-context');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',C='44444444-4444-4444-8444-444444444444';
const W='33333333-3333-4333-8333-333333333333',OTHER='55555555-5555-4555-8555-555555555555';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const config={namespaces:{checkpoint:'rt_checkpoint'},consumer:'realtime-test',maxTenants:64,completedOutput:{namespace:'eval_checkpoint',consumer:'evaluator-test'}};
function ablate(file,needle,replacement){
  const path=require.resolve(file),source=fs.readFileSync(path,'utf8');assert(source.includes(needle),'ABLATION_NEEDLE_MISSING '+needle);
  const module={exports:{}};vm.runInThisContext('(function(require,module,exports){'+source.replace(needle,replacement)+'\n})',{filename:path})(require('node:module').createRequire(path),module,module.exports);return module.exports;
}
// A durable model of the two rows the fixed SQL reads and writes: the
// evaluator's committed delivery_revision and this realtime role's progress
// row. It mirrors the SQL predicates; the native suite proves the SQL itself.
function lab({start=receipts.start,roster=[A,B,C],retryMs=1000,recoveryMs=30000,flushMs=100,deliver=async()=>true,admits}={}){
  let now=1000,id=0;const timers=new Map(),evaluator=new Map(),rows=new Map(),calls={work:[],finish:[],check:[]};
  for(const tenant of roster)rows.set(tenant,{received:0,completed:0,retry:null,owner:null});
  const store={
    async work(ids){calls.work.push([...ids]);return ids.filter(tenant=>{const e=evaluator.get(tenant),r=rows.get(tenant);return e!==undefined&&r&&(r.owner===null||r.owner===W)&&e>r.completed&&(r.retry===null||r.retry<=now||e>r.received);}).sort().map(tenant=>({tenant,received:String(evaluator.get(tenant))}));},
    async finish(list,outcomes,due){calls.finish.push(list.map(row=>[row.tenant,row.received,outcomes.get(row.tenant)===true]));
      if(list.some(row=>rows.get(row.tenant).owner!==null&&rows.get(row.tenant).owner!==W))throw Error('REALTIME_RECEIPT_NOT_PROVISIONED_OR_REPLACED');
      for(const row of list){const r=rows.get(row.tenant),revision=Number(row.received),ok=outcomes.get(row.tenant)===true;
        const received=Math.max(r.received,revision),completed=ok?Math.max(r.completed,revision):r.completed;
        r.retry=received<=completed?null:ok?r.retry:due;r.received=received;r.completed=completed;r.owner=W;}}
  };
  const value=start({store,jobContext:contexts.create('delivery'),roster:()=>roster,...(admits?{admits}:{}),flushMs,retryMs,recoveryMs,now:()=>now,
    check:async tenants=>{calls.check.push([...tenants]);const out=new Map();for(const tenant of tenants)out.set(tenant,await deliver(tenant));return out;},
    setTimer:(fn,ms)=>{const key=++id;timers.set(key,{fn,at:now+ms});return key;},clearTimer:key=>timers.delete(key)});
  return {value,calls,timers,evaluator,rows,commit(tenant){evaluator.set(tenant,(evaluator.get(tenant)??0)+1);return evaluator.get(tenant);},
    async flush(ms=0){const target=now+ms;for(let turn=0;turn<400;turn++){await settle();const due=[...timers].filter(([,row])=>row.at<=target).sort((a,b)=>a[1].at-b[1].at);if(!due.length)break;const [key,row]=due[0];timers.delete(key);now=Math.max(now,row.at);await row.fn();}now=target;await settle();}};
}
describe('durable realtime output delivery ownership',function(){
  it('provisions a stable narrow receipt identity without constructing a clinical replay consumer',function(){
    const digest=receipts.contractDigest('rt_checkpoint','realtime-test');assert.match(digest,/^[a-f0-9]{64}$/);
    assert.equal(digest,receipts.contractDigest('rt_checkpoint','realtime-test'));
    assert.notEqual(digest,receipts.contractDigest('other_checkpoint','realtime-test'));
    assert.notEqual(digest,receipts.contractDigest('rt_checkpoint','realtime-other'));
    assert.throws(()=>receipts.contractDigest('public','realtime-test'));
  });
  it('preserves exact producer revisions and refuses bigint overflow and unsafe numeric values before SQL',function(){
    for(const value of ['1','9007199254740993','9223372036854775807'])assert.equal(receipts.revision(value),value);
    for(const value of [1,9007199254740992,'0','01','9223372036854775808'])assert.throws(()=>receipts.revision(value),/Exact positive/);
  });
  it('reads the obligation in one read-only join and records a whole page in one fenced UPDATE',async function(){
    const reads=[],queries=[],released=[];let owned=true;
    const pool={connect:async()=>({query:async(statement,values)=>{const sql=typeof statement==='string'?statement:statement.text;queries.push(sql);if(!values)return {rows:[],command:sql};
      assert.match(statement.name,/^realtime-receipt-v3:rt_checkpoint:(claim|finish)$/);const rows=JSON.parse(values[2]);return {rows:rows.map(row=>({tenant:row.tenant,completed:row.revision||'0'}))};},release:error=>released.push(error)})};
    const sql=extra=>({readOnly:async(text,values)=>{reads.push({sql:text,values});return {rows:[{tenant:A,received:'9007199254740993'}]};},updateRealtimeReceipts:options=>require('../lib/pgstream/realtime-receipt-sql').update({pool,observeBackend:async()=>{},...options,...extra?.(options)})});
    const store=receipts.create({config,worker:W,assertOwner:tenant=>{if(!owned||tenant===C)throw Error('REALTIME_OWNER_UNAVAILABLE');},connection:sql()});
    assert.deepEqual(await store.work([A,B]),[{tenant:A,received:'9007199254740993'}]);
    assert.equal(reads.length,1,'ONE_READ_PER_PAGE');
    assert.match(reads[0].sql,/JOIN "eval_checkpoint"\.tenant_consumer_checkpoint e ON e\.tenant_id=r\.tenant_id AND e\.consumer=\$2/);
    assert.match(reads[0].sql,/e\.delivery_revision>r\.output_completed/);assert.match(reads[0].sql,/r\.output_owner IS NULL OR r\.output_owner=\$3::uuid/);
    assert.deepEqual(reads[0].values.slice(0,4),['realtime-test','evaluator-test-completed',W,[A,B]]);
    await store.recover([A,B]);
    await store.finish([{tenant:A,received:'9007199254740993'},{tenant:B,received:'2'}],new Map([[A,true],[B,false]]),5000);
    const statements=queries.filter(text=>text.startsWith('WITH work'));
    assert.equal(statements.length,2,'ONE_CLAIM_AND_ONE_FINISH');assert.match(statements[1],/output_completed=CASE WHEN w\.ok THEN GREATEST/);
    assert.equal(queries.filter(text=>text==='COMMIT').length,2);assert(released.every(error=>error===undefined));
    assert.equal(store.stats().completed,1);assert.equal(store.stats().retries,1);assert.equal(store.stats().received,1);
    // The realtime-inspection contract fixes the delivery stats key set.
    const contract=require('../lib/server/internal-api/contracts').realtimeInspection;
    const schema=contract.operations.inspectRealtime.response.properties.stats.properties.delivery.anyOf[0];
    assert.deepEqual(Object.keys(store.stats()).sort(),[...schema.required].sort(),'INSPECTION_DELIVERY_STATS_CONTRACT');
    await assert.rejects(store.work([C]),/REALTIME_OWNER_UNAVAILABLE/);assert.equal(reads.length,1,'NON_OWNER_PAGE_REFUSED_BEFORE_SQL');
    for(const bad of [[],[A,A],Array.from({length:65},(_,i)=>'00000000-0000-4000-8000-'+String(i).padStart(12,'0')),['invalid']])await assert.rejects(store.work(bad),/Bounded realtime delivery page|Canonical/);
    // Ownership is confirmed under the row locks: a loss before COMMIT commits nothing.
    const before=queries.filter(text=>text==='COMMIT').length;
    const losing=receipts.create({config,worker:W,assertOwner:()=>{if(!owned)throw Error('REALTIME_OWNER_UNAVAILABLE');},connection:sql(options=>({confirm:async()=>{owned=false;await options.confirm();}}))});
    await assert.rejects(losing.finish([{tenant:A,received:'3'}],new Map([[A,true]]),5000),/REALTIME_OWNER_UNAVAILABLE/);
    assert.equal(queries.filter(text=>text==='COMMIT').length,before,'OWNER_LOSS_MUST_NOT_COMMIT');
  });
  it('does not confirm an unknown COMMIT, refuses a replaced row before COMMIT and rejects malformed fields before pool acquisition',async function(){
    const helper=require('../lib/pgstream/realtime-receipt-sql'),failure=Error('UNKNOWN_COMMIT');let acquired=0,released,commits=0,returned=1;
    const options={table:'rt_checkpoint.tenant_consumer_checkpoint',consumer:'realtime-test',worker:W,mode:'finish',rows:[{tenant:A,revision:'1',ok:true,due:5}],observeBackend:async()=>{},
      pool:{connect:async()=>{acquired++;return {query:async(sql)=>{if(sql==='COMMIT'){commits++;throw failure;}return {rows:sql==='BEGIN'?[]:Array.from({length:returned},()=>({tenant:A,completed:'1'}))};},release:error=>{released=error;}};}}};
    for(const rows of [[{tenant:A,revision:'9223372036854775808',ok:true,due:5}],[{tenant:A,revision:'1',ok:'yes',due:5}],[{tenant:A,revision:'1',due:5}],[{tenant:A,revision:'1',ok:true,due:5,extra:1}]])await assert.rejects(helper.update({...options,rows}),/Fixed bounded/);
    for(const mode of ['receive','complete','retry'])await assert.rejects(helper.update({...options,mode}),/Fixed bounded/,'RETIRED_MODE '+mode);
    assert.equal(acquired,0);
    await assert.rejects(helper.update(options),error=>error===failure);assert.equal(released,failure);
    returned=0;await assert.rejects(helper.update(options),/REALTIME_RECEIPT_NOT_PROVISIONED_OR_REPLACED/);assert.equal(commits,1,'REFUSED_PAGE_MUST_NOT_COMMIT');
  });
  it('coalesces the raw-tail and output wakes of one cycle into one delivery and leaves only the bounded recovery timer when idle',async function(){
    const f=lab();try{
      await f.flush();assert.deepEqual(f.calls.work,[[A,B,C]],'STARTUP_RECONCILIATION_ONE_PAGE');assert.equal(f.calls.check.length,0);
      f.commit(A);f.value.wake({tenants:[A]});await f.flush(40);f.commit(A);f.value.wake({tenants:[A]});
      assert.equal(f.calls.work.length,1,'DEBOUNCE_HOLDS_FIRST_WAKE');await f.flush(60);
      assert.deepEqual(f.calls.work.slice(1),[[A]]);assert.deepEqual(f.calls.check,[[A]]);assert.deepEqual(f.calls.finish,[[[A,'2',true]]]);
      assert.equal(f.rows.get(A).completed,2);assert.equal(f.timers.size,1,'IDLE_ONLY_RECOVERY_TIMER');
      assert.equal([...f.timers.values()][0].at,1000+30000);
    }finally{await f.value.close();}assert.equal(f.timers.size,0);
  });
  it('(a) recovers a lost wake through the bounded reconciliation scan within recoveryMs; (e) ablating the scan strands it',async function(){
    async function criterion(start){const f=lab({start,recoveryMs:5000});try{
      await f.flush();f.commit(B);await f.flush(4999);assert.equal(f.rows.get(B).completed,0,'NO_WAKE_NO_EARLY_DELIVERY');
      await f.flush(1);assert.equal(f.rows.get(B).completed,1,'LOST_WAKE_MUST_RECOVER_WITHIN_RECOVERY_MS');
      assert(f.calls.work.every(page=>page.length<=64));
    }finally{await f.value.close();}}
    await criterion(receipts.start);
    const broken=ablate('../lib/pgstream/realtime-receipt','function reconcile () {\n    if (closed) return;','function reconcile () {\n    return;');
    await assert.rejects(criterion(broken.start),/LOST_WAKE_MUST_RECOVER_WITHIN_RECOVERY_MS/);
    await criterion(receipts.start);
  });
  it('(b) retries a failed frame delivery exactly once per due interval and never completes it early',async function(){
    async function criterion(start){let healthy=false;const f=lab({start,deliver:async()=>healthy});try{
      await f.flush();f.commit(A);f.value.wake({tenants:[A]});await f.flush(100);
      assert.equal(f.calls.check.length,1);assert.equal(f.rows.get(A).completed,0,'FAILED_DELIVERY_MUST_NOT_COMPLETE');assert.equal(f.rows.get(A).retry,1100+1000);
      f.value.wake({tenants:[A]});await f.flush(999);assert.equal(f.calls.check.length,1,'NO_RETRY_BEFORE_DUE');
      await f.flush(1);assert.equal(f.calls.check.length,2,'EXACTLY_ONE_RETRY_AT_DUE');assert.equal(f.rows.get(A).completed,0);
      healthy=true;await f.flush(1000);assert.equal(f.calls.check.length,3);assert.equal(f.rows.get(A).completed,1);assert.equal(f.rows.get(A).retry,null);
      await f.flush(5000);assert.equal(f.calls.check.length,3,'COMPLETED_WORK_NOT_REDELIVERED');
    }finally{await f.value.close();}}
    await criterion(receipts.start);
    const ignoringFailure=ablate('../lib/pgstream/realtime-receipt','const results=outcomes instanceof Map&&!error?outcomes:','const results=new Map(rows.map(row=>[row.tenant,true]))||');
    await assert.rejects(criterion(ignoringFailure.start),/FAILED_DELIVERY_MUST_NOT_COMPLETE/);
    // Forgetting a retry that is still in backoff (the durable due time hid it
    // from one wake's page) strands it until reconciliation: no retry at due.
    const forgetful=ablate('../lib/pgstream/realtime-receipt','if (!owed.has(tenant) && (failed.get(tenant) ?? -Infinity) <= at) failed.delete(tenant);','if (!owed.has(tenant)) failed.delete(tenant);');
    await assert.rejects(criterion(forgetful.start),/EXACTLY_ONE_RETRY_AT_DUE/);
    await criterion(receipts.start);
  });
  it('(b) a thrown check retries the page and never completes it early',async function(){
    async function criterion(start){let fail=true;const f=lab({start,deliver:async()=>{if(fail)throw Error('OUTPUT_UNAVAILABLE');return true;}});try{
      await f.flush();f.commit(C);f.value.wake({tenants:[C]});await f.flush(100);
      assert.equal(f.rows.get(C).completed,0,'THROWN_CHECK_MUST_NOT_COMPLETE');assert.equal(f.rows.get(C).retry,1100+1000);
      fail=false;await f.flush(1000);assert.equal(f.rows.get(C).completed,1);
    }finally{await f.value.close();}}
    await criterion(receipts.start);
    const early=ablate('../lib/pgstream/realtime-receipt','new Map(rows.map(row=>[row.tenant,false]))','new Map(rows.map(row=>[row.tenant,true]))');
    await assert.rejects(criterion(early.start),/THROWN_CHECK_MUST_NOT_COMPLETE/);
    await criterion(receipts.start);
  });
  it('(c) a newer revision committed during delivery remains pending and is then delivered',async function(){
    let f;f=lab({deliver:async tenant=>{if(tenant===A&&f.evaluator.get(A)===1)f.commit(A);return true;}});try{
      await f.flush();f.commit(A);f.value.wake({tenants:[A]});await f.flush(100);
      assert.deepEqual(f.calls.finish.at(-1),[[A,'1',true]],'DELIVERED_PAGE_RECORDS_THE_REVISION_IT_READ');
      assert.equal(f.rows.get(A).completed,1);assert.equal(f.evaluator.get(A),2);
      f.value.wake({tenants:[A]});await f.flush(100);assert.equal(f.rows.get(A).completed,2);
    }finally{await f.value.close();}
  });
  it('(d) never selects or completes a tenant this realtime does not own',async function(){
    const owned=new Set([A]);const f=lab({admits:tenant=>owned.has(tenant)});try{
      await f.flush();assert.deepEqual(f.calls.work,[[A]]);f.commit(B);f.value.wake({tenants:[B]});await f.flush(30000);
      assert.equal(f.rows.get(B).completed,0);assert(f.calls.work.every(page=>!page.includes(B)),'NON_OWNER_MUST_NOT_BE_SELECTED');
      f.rows.get(A).owner=OTHER;f.commit(A);f.value.wake({tenants:[A]});await f.flush(100);assert.equal(f.rows.get(A).completed,0,'ANOTHER_OWNERS_ROW_NOT_SELECTED');
    }finally{await f.value.close();}
  });
  it('bounds addressed RAM and pages reconciliation at 64 tenants per read',async function(){
    const roster=Array.from({length:130},(_,i)=>'00000000-0000-4000-8000-'+String(i).padStart(12,'0'));
    const f=lab({roster});try{
      for(const tenant of roster)f.commit(tenant);await f.flush();
      assert.deepEqual(f.calls.work.map(page=>page.length),[64,64,2]);assert(roster.every(tenant=>f.rows.get(tenant).completed===1));
      for(const tenant of roster)f.commit(tenant);f.value.wake({tenants:roster.slice(0,64)});f.value.wake({tenants:roster.slice(64)});await f.flush(100);
      assert(f.calls.work.slice(3).every(page=>page.length<=64));assert(roster.every(tenant=>f.rows.get(tenant).completed===2));
    }finally{await f.value.close();}
  });
  it('retains a wake arriving while a page is being delivered',async function(){
    let enter,release,first=true;const entered=new Promise(done=>{enter=done;}),held=new Promise(done=>{release=done;});
    const f=lab({deliver:async()=>{if(first){first=false;enter();await held;}return true;}});try{
      await f.flush();f.commit(A);f.value.wake({tenants:[A]});const draining=f.flush(100);await entered;
      f.commit(B);f.value.wake({tenants:[B]});release();await draining;await f.flush(100);
      assert.equal(f.rows.get(A).completed,1);assert.equal(f.rows.get(B).completed,1);
    }finally{await f.value.close();}
  });
});
describe('evaluator completed-output wake (best effort, no durable ACK)',function(){
  function sender({fail=false,admits}={}){
    let id=0;const timers=new Map(),sent=[];let gate=null;
    const value=wakes.create({send:async body=>{sent.push(body.tenants);if(gate)await gate;if(fail)throw Error('RT_OUTAGE');},...(admits?{admits}:{}),maxTenants:100,
      setTimer:fn=>{const key=++id;timers.set(key,fn);return key;},clearTimer:key=>timers.delete(key)});
    return {value,sent,timers,hold(){let release;gate=new Promise(done=>{release=done;});return ()=>{gate=null;release();};},
      async flush(){for(let turn=0;turn<50;turn++){await settle();const next=[...timers];if(!next.length)break;for(const [key,fn]of next){timers.delete(key);fn();}}await settle();}};
  }
  it('coalesces distinct tenants into bounded batches with one RPC in flight',async function(){
    const f=sender(),ids=Array.from({length:100},(_,i)=>'00000000-0000-4000-8000-'+String(i).padStart(12,'0'));
    for(const tenant of ids)f.value.wake(tenant);f.value.wake(ids[0]);await f.flush();await f.value.flush();
    assert.deepEqual(f.sent.map(batch=>batch.length),[64,36]);assert.deepEqual(new Set(f.sent.flat()),new Set(ids));
    const release=f.hold();f.value.wake(A);await f.flush();f.value.wake(B);f.value.wake(C);await f.flush();assert.equal(f.sent.length,3,'ONE_IN_FLIGHT');
    release();await f.value.flush();await f.flush();await f.value.flush();
    assert.deepEqual(f.sent.slice(3),[[B,C]]);assert.equal(f.value.stats().batches,4);await f.value.close();
  });
  it('never retries or records a refused wake; realtime reconciliation owns recovery',async function(){
    const f=sender({fail:true});f.value.wake(A);await f.flush();await f.value.flush();await f.flush();
    assert.deepEqual(f.sent,[[A]]);assert.equal(f.value.stats().failures,1);assert.equal(f.timers.size,0,'NO_EVALUATOR_DELIVERY_RETRY_TIMER');await f.value.close();
  });
  it('admits only configured tenants, bounds RAM and stops on close',async function(){
    const f=sender({admits:tenant=>tenant!==B});f.value.wake(B);await f.flush();assert.equal(f.sent.length,0);
    const small=wakes.create({send:async()=>{},maxTenants:1,setTimer:()=>1,clearTimer:()=>{}});small.wake(A);small.wake(C);assert.equal(small.stats().dropped,1);await small.close();small.wake(A);assert.equal(small.stats().pending,0);
    await f.value.close();f.value.wake(A);await f.flush();assert.equal(f.sent.length,0);
  });
  it('end to end: a dropped wake is recovered by realtime; a delivered wake needs no evaluator state',async function(){
    const f=lab({recoveryMs:5000});let drop=true;
    const wake=wakes.create({send:async body=>{if(drop)throw Error('RT_OUTAGE');f.value.wake({tenants:body.tenants});},setTimer:fn=>setImmediate(fn),clearTimer:clearImmediate});
    try{await f.flush();f.commit(A);wake.wake(A);await settle();await settle();await f.flush(100);assert.equal(f.rows.get(A).completed,0);
      await f.flush(5000);assert.equal(f.rows.get(A).completed,1,'REALTIME_RECONCILES_DROPPED_WAKE');
      drop=false;f.commit(A);wake.wake(A);await settle();await settle();await f.flush(100);assert.equal(f.rows.get(A).completed,2);
    }finally{await wake.close();await f.value.close();}
  });
});
