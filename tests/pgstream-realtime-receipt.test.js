'use strict';
const assert=require('node:assert/strict');
const receipts=require('../lib/pgstream/realtime-receipt');
const contexts=require('../lib/server/serve/evaluator-job-context');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
describe('durable realtime output scheduling source protocol',function(){
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
  it('uses bounded fixed metadata SQL outside a suspended clinical operation and batches independent outcomes',async function(){
    const updates=[],queries=[],released=[];
    const worker='33333333-3333-4333-8333-333333333333';
    const pool={connect:async()=>({query:async(statement,values)=>{const sql=typeof statement==='string'?statement:statement.text;queries.push(sql);if(!values)return {rows:[],command:sql};assert.match(statement.name,/^realtime-receipt-v2:rt_checkpoint:(receive|claim|complete|retry)$/);const rows=JSON.parse(values[2]);updates.push({sql,rows});return {rows:rows.map(row=>({tenant:row.tenant,received:row.revision||'1'}))};},release:error=>released.push(error)})};
    const store=receipts.create({config:{namespaces:{checkpoint:'rt_checkpoint'},consumer:'realtime-test',maxTenants:64},worker,
      operationWindow:{run:()=>assert.fail('SUSPENDED_CLINICAL_OPERATION_MUST_NOT_RUN')},
      connection:{readOnly:async()=>({rows:[]}),updateRealtimeReceipts:options=>require('../lib/pgstream/realtime-receipt-sql').update({pool,observeBackend:async()=>{},...options})}});
    await store.receive(A,'9007199254740993');await store.recover([A,B]);
    await store.finish([{tenant:A,received:'9007199254740993'},{tenant:B,received:'2'}],new Map([[A,true],[B,false]]));
    assert.equal(updates.length,4);assert.equal(updates[1].rows.length,2,'BOOT_CLAIM_ONE_BOUNDED_UPDATE');
    assert.match(updates[2].sql,/output_completed/);assert.match(updates[3].sql,/output_retry_at=w.due/);
    assert.equal(queries.filter(sql=>sql==='COMMIT').length,4);assert(released.every(error=>error===undefined));
    assert.equal(store.stats().maxMetadataBatch,2);
  });
  it('does not acknowledge unknown metadata COMMIT and rejects malformed fields before pool acquisition',async function(){
    const helper=require('../lib/pgstream/realtime-receipt-sql'),failure=Error('UNKNOWN_COMMIT');let acquired=0,released;
    const options={table:'rt_checkpoint.tenant_consumer_checkpoint',consumer:'realtime-test',worker:'33333333-3333-4333-8333-333333333333',mode:'receive',rows:[{tenant:A,revision:'1'}],observeBackend:async()=>{},
      pool:{connect:async()=>{acquired++;return {query:async(sql)=>{if(sql==='COMMIT')throw failure;return {rows:sql==='BEGIN'?[]:[{tenant:A,received:'1'}]};},release:error=>{released=error;}};}}};
    await assert.rejects(helper.update({...options,rows:[{tenant:A,revision:'9223372036854775808'}]}));assert.equal(acquired,0);
    await assert.rejects(helper.update(options),error=>error===failure);assert.equal(released,failure);
  });
  it('drains durable pending controls even for idle sockets and leaves no steady discovery timer after healthy drain',async function(){
    let rows=[{tenant:A,received:'9007199254740993'},{tenant:B,received:'2'}],queries=0;
    const timers=[],checked=[],completed=[];
    const service=receipts.start({jobContext:contexts.create('delivery'),watched:()=>false,
      store:{nextDue:async()=>null,work:async()=>{queries++;return rows;},complete:async(tenant,revision)=>{completed.push([tenant,revision]);rows=rows.filter(row=>row.tenant!==tenant);},retry:async()=>assert.fail('HEALTHY_MUST_NOT_RETRY')},
      check:async tenants=>checked.push(tenants),setTimer:(fn,ms)=>{const timer={fn,ms};timers.push(timer);return timer;},clearTimer:()=>{}});
    try{
      assert.equal(timers.length,1);await timers.shift().fn();await settle();
      assert.deepEqual(checked,[[A,B]]);assert.deepEqual(completed,[[A,'9007199254740993'],[B,'2']]);
      assert.equal(queries,1);assert.equal(timers.length,0,'IDLE_MUST_NOT_ARM_DISCOVERY');
    }finally{await service.close();}
  });
  it('retains a receipt arriving during durable next-due reconstruction',async function(){
    let rows=[],entered,release,first=true;
    const enteredNextDue=new Promise(resolve=>{entered=resolve;}),timers=[],checked=[];
    const service=receipts.start({jobContext:contexts.create('delivery'),watched:()=>true,
      store:{work:async()=>rows,nextDue:async()=>{if(first){first=false;entered();return new Promise(resolve=>{release=resolve;});}return null;},complete:async()=>{rows=[];},retry:async()=>assert.fail('UNEXPECTED_RETRY')},
      check:async tenants=>checked.push(tenants),setTimer:(fn,ms)=>{const timer={fn,ms};timers.push(timer);return timer;},clearTimer:()=>{}});
    try{
      timers.shift().fn();await enteredNextDue;rows=[{tenant:B,received:'9'}];service.wake({immediate:true});release(null);await settle();
      assert.equal(timers.length,1,'RECEIVE_DURING_DRAIN_MUST_REARM');
      timers.shift().fn();await settle();assert.deepEqual(checked,[[B]]);assert.equal(timers.length,0);
    }finally{await service.close();}
  });
  it('keeps failed work pending and arms only its retry rather than a roster sweep',async function(){
    let fail=true,rows=[{tenant:A,received:'3'}],retried=0;
    const timers=[];
    const service=receipts.start({jobContext:contexts.create('delivery'),watched:()=>true,
      store:{nextDue:async()=>rows.length?Date.now()+1000:null,work:async()=>rows,complete:async()=>{rows=[];},retry:async()=>{retried++;}},check:async()=>{if(fail)throw Error('OUTPUT_UNAVAILABLE');},
      setTimer:(fn,ms)=>{const timer={fn,ms};timers.push(timer);return timer;},clearTimer:()=>{}});
    try{await timers.shift().fn();await settle();assert.equal(retried,1);assert.equal(rows.length,1);assert(timers[0].ms>=990&&timers[0].ms<=1000);
      fail=false;await timers.shift().fn();await settle();assert.equal(rows.length,0);assert.equal(timers.length,0);
    }finally{await service.close();}
  });
});
