'use strict';
const assert = require('node:assert/strict');
const fixture = require('./fixtures/tenant-notifications');
const producer = require('../lib/tenant-notifications/producer');
const notifier = require('../lib/tenant-notifications/component');
const scope = require('../lib/storage/tenant-scope');
const makeEnv = require('../lib/server/tenant-app/environment');
const env = makeEnv({settings:{enable:['simplealarms']}}), levels = require('../lib/levels');
const view = require('../lib/data/views')(env,{language:require('../lib/language')(),levels,moment:require('moment-timezone')});

describe('actual durable producer and outbox recreation protocol', function () {
  let f, source, owned, mode, at;
  beforeEach(function () {f=fixture(); owned=[]; mode=scope.getTenancyMode(); scope.setTenancyMode('multi'); at=Date.UTC(2026,10,6,12);});
  afterEach(async function () {await Promise.all(owned.map(value=>value.close())); scope.setTenancyMode(mode);});
  function clinical (mgdl, runtime='runtime-one', outputRevision=1) {
    const ddata=require('../lib/data/ddata')(); ddata.lastUpdated=at;
    ddata.sgvs=[{_id:'synthetic',mgdl,mills:at-1000,type:'sgv',direction:'Flat'}];
    source={tenant:f.A,identity:'config',runtimeId:runtime,outputRevision,inputCheckpoint:0,eligible:true,
      result:{tenant:f.A,...view.evaluateCycle({now:at,ddata})}};
  }
  function open (send, reader={read:async()=>[]}) {
    const p=producer({store:f.store,reader,current:()=>source,currentConfig:async()=>({tenant:f.A,identity:source.identity}),isCurrent:async()=>true,
      consumer:'realtime-test',now:()=>at,maxRows:10,maxBytes:65536,maxPayloadBytes:10000});
    const n=notifier({store:f.store,adapter:{id:'realtime-test',send},selectCycle:p.select,isCurrent:async()=>true,
      allows:async()=>true,now:()=>at,normalPolicy:'realtime-cycle',requireIntentOrigin:true,
      maxRows:10,maxPayloadBytes:10000,maxInflight:1,attemptTimeoutMs:1000,retryDelayMs:1});
    owned.push(n,p); return {p,n};
  }
  it('retries an unchanged meaningful uncertain request with its original UUID after actual producer/component recreation while admitting one fresh RT output', async function () {
    clinical(50); const effects=[];
    const first=open((row,callback)=>{effects.push(row);callback(new Error('accepted but response uncertain'));});
    await first.p.select(f.A); await first.n.retry(f.A); const original=effects[0].id;
    await first.n.close(); first.p.close(); at+=2; clinical(50,'runtime-after-restart');
    const next=open((row,callback)=>{effects.push(row);callback(null,{accepted:true});});
    await next.p.select(f.A); await next.n.retry(f.A);
    assert.equal(effects.filter(row=>row.id===original).length,2,'PRODUCER_RESTART_SAME_UUID');
    assert.equal(new Set(effects.map(row=>row.id)).size,2,'fresh successful RT cycle admits one new logical event');
    const rows=f.snapshot().requests; assert.ok(rows.every(row=>row.state==='accepted'));
    await next.p.select(f.A); await next.n.retry(f.A); assert.equal(f.snapshot().requests.length,rows.length,'PRODUCER_SAME_OUTPUT_ONCE');
  });
  it('consumes fresh committed control ACK after restart initial acquisition refusal without inventing a clinical result', async function () {
    clinical(50); const first=open((row,callback)=>callback(null,{accepted:true})); await first.p.select(f.A); await first.n.retry(f.A);
    first.p.close(); await first.n.close();
    const alarm=require('./fixtures/tenant-alarm-protocol')(); alarm.now=at+1; at++;
    await alarm.writer.ack(alarm.operation(2,'default',1000));
    const runtime=await require('../lib/server/serve/evaluator-runtime')({tenants:[f.A],readCurrent:async()=>({tenant:f.A,identity:'config-after-restart'}),
      create:async()=>({evaluate:async()=>{throw new Error('initial clinical acquisition refused');},close(){}}),
      recoveryIntervalMs:100,timeIntervalMs:100,now:()=>at,schedule:()=>({}),cancel(){}});
    owned.push(runtime); assert.equal(runtime.last(f.A),null);
    const p=producer({store:f.store,reader:alarm.reader,current:runtime.last,isCurrent:runtime.isCurrent,
      currentConfig:async()=>({tenant:f.A,identity:'config-after-restart'}),consumer:'realtime-test',now:()=>at,maxRows:10,maxBytes:65536,maxPayloadBytes:10000}); owned.push(p);
    const selected=await p.select(f.A);
    assert.equal(runtime.last(f.A),null,'CONTROL_CLEAR_NO_FABRICATED_CLINICAL');
    assert.deepEqual(selected.result.emitted,[{clear:true,title:'All Clear',message:"default - Urgent was ack'd",group:'default'}], 'PRODUCER_COLD_FAILED_CLINICAL_CONTROL_CLEAR');
  });
  // Controlled interleaving, no timers: the evaluator publishes one newer output
  // (a time-only tick: same reading, next outputRevision) while the producer's
  // suppression read is pending, i.e. between observing the output and committing.
  function publishDuringRead () {
    const reader={pending:0,async read () {
      if (reader.pending && --reader.pending===0) clinical(50,source.runtimeId,source.outputRevision+1);
      return [];
    }};
    return reader;
  }
  it('selects again against the newer evaluator output published during a selection instead of refusing', async function () {
    clinical(50); const reader=publishDuringRead(); const value=open((row,callback)=>callback(null,{accepted:true}),reader);
    reader.pending=1;
    const selected=await value.p.select(f.A);
    assert.equal(reader.pending,0,'the newer output was published inside the selection');
    assert.deepEqual(f.producerStates()[0].producer.output,['config','runtime-one',2,0],'PRODUCER_STALE_RESELECTS_NEWER_OUTPUT');
    assert.equal(selected.eligible,true); assert.equal(selected.result.emitted.length,1);
  });
  it('hands off a committed request when a newer evaluator output is published during its attempt', async function () {
    clinical(50); const reader=publishDuringRead(); const effects=[];
    const value=open((row,callback)=>{effects.push(row);callback(null,{accepted:true});},reader);
    await value.p.select(f.A); const original=f.snapshot().requests[0];
    reader.pending=1; // the first suppression read after the attempt has begun (attempting is committed)
    await value.n.retry(f.A);
    assert.equal(reader.pending,0,'the newer output was published inside the attempt');
    assert.equal(f.snapshot().requests.find(row=>row.request_id===original.request_id).state,'accepted','PRODUCER_STALE_ATTEMPT_NOT_STRANDED');
    assert.deepEqual(effects.map(row=>row.id),[original.request_id]);
  });
  it('does not advance durable producer revision for an unchanged output after JSONB-like object-key reordering', async function () {
    clinical(50); const value=open((row,callback)=>callback(null,{accepted:true})); await value.p.select(f.A);
    const before=f.producerStates()[0]; f.jsonbRoundTrip();
    assert.notEqual(JSON.stringify(f.producerStates()[0].producer),JSON.stringify(before.producer),'roundtrip actually changes object-key insertion order');
    assert.deepEqual(f.producerStates()[0].producer,before.producer,'roundtrip preserves JSON values and array order');
    await value.p.select(f.A); const after=f.producerStates()[0];
    assert.equal(after.revision,before.revision,'PRODUCER_JSONB_UNCHANGED_NO_REVISION');
    assert.deepEqual(after.producer,before.producer); assert.equal(f.snapshot().requests.length,1);
  });
  it('rolls producer state and request intents back together when durable COMMIT refuses', async function () {
    clinical(50); let attempts=0; const value=open((row,callback)=>{attempts++;callback(null,{accepted:true});});
    f.failCommit(true); await assert.rejects(value.p.select(f.A),/SYNTHETIC_COMMIT_FAILURE/);
    assert.deepEqual(f.producerStates(),[]); assert.deepEqual(f.snapshot().requests,[]); assert.equal(attempts,0,'PRODUCER_STATE_INTENT_ATOMIC_ROLLBACK');
    f.failCommit(false); await value.p.select(f.A); await value.n.retry(f.A); assert.equal(attempts,1);
  });
  it('atomically retires an obsolete normal request and a stale clear origin before a newer alarm can hand off', async function () {
    clinical(50); const effects=[]; const value=open((row,callback)=>{effects.push(row);callback(new Error('uncertain'));});
    await value.p.select(f.A); await value.n.retry(f.A); const alarm=effects[0].id;
    at+=2; clinical(111,'runtime-one',2); await value.p.select(f.A); await value.n.retry(f.A);
    const clear=effects.find(row=>row.notification.clear); assert.ok(clear);
    assert.equal(f.snapshot().requests.find(row=>row.request_id===alarm).state,'cancelled');
    at+=2; clinical(50,'runtime-one',3); await value.p.select(f.A);
    assert.equal(f.snapshot().requests.find(row=>row.request_id===clear.id).state,'cancelled','PRODUCER_STALE_CLEAR_RETIRED');
    const before=effects.length; await value.n.retry(f.A); assert.ok(effects.slice(before).every(row=>!row.notification.clear));
  });
});
