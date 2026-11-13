'use strict';
const assert = require('node:assert/strict');
const fixture = require('./fixtures/tenant-notifications');
const producer = require('../lib/tenant-notifications/producer');
const notifier = require('../lib/tenant-notifications/component');
const scope = require('../lib/storage/tenant-scope');
const {contentDigest} = require('../lib/server/serve/evaluator-runtime');
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
    const result={tenant:f.A,...view.evaluateCycle({now:at,ddata})};
    source={tenant:f.A,identity:'config',runtimeId:runtime,outputRevision,inputCheckpoint:0,eligible:true,
      contentDigest:contentDigest(result),result};
  }
  function open (send, reader={read:async()=>[]}) {
    const p=producer({store:f.store,reader,current:()=>source,currentConfig:async()=>({tenant:f.A,identity:source.identity}),isCurrent:async()=>true,
      consumer:'realtime-test',now:()=>at,maxRows:10,maxBytes:65536,maxPayloadBytes:10000});
    const n=notifier({store:f.store,adapter:{id:'realtime-test',send},selectCycle:p.select,isCurrent:async()=>true,
      allows:async()=>true,now:()=>at,normalPolicy:'realtime-cycle',requireIntentOrigin:true,
      maxRows:10,maxPayloadBytes:10000,maxInflight:1,attemptTimeoutMs:1000,retryDelayMs:1});
    owned.push(n,p); return {p,n};
  }
  it('retries an unchanged meaningful uncertain request with its original UUID after actual producer/component recreation; identical output from the new runtime admits no new event', async function () {
    clinical(50); const effects=[];
    const first=open((row,callback)=>{effects.push(row);callback(new Error('accepted but response uncertain'));});
    await first.p.select(f.A); await first.n.retry(f.A); const original=effects[0].id;
    await first.n.close(); first.p.close(); at+=2; clinical(50,'runtime-after-restart');
    const next=open((row,callback)=>{effects.push(row);callback(null,{accepted:true});});
    await next.p.select(f.A); await next.n.retry(f.A);
    assert.equal(effects.filter(row=>row.id===original).length,2,'PRODUCER_RESTART_SAME_UUID');
    // The output is identified by content: a restarted evaluator with the same
    // output is the same output, so the alarm waits for its repeat clock.
    assert.equal(new Set(effects.map(row=>row.id)).size,1,'PRODUCER_RESTART_NO_IMMEDIATE_RESEND');
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
    assert.deepEqual(f.producerStates()[0].producer.output,['config',source.contentDigest,0],'PRODUCER_STALE_RESELECTS_NEWER_OUTPUT');
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
  // Single-site repeat: the same evaluator output (no new revision) is processed
  // again on the tenant heartbeat clock (60 s default here: currentConfig has no env).
  it('repeats an unacknowledged alarm on the heartbeat clock, not on identical evaluator output', async function () {
    clinical(50); const effects=[]; const value=open((row,callback)=>{effects.push(row);callback(null,{accepted:true});});
    await value.p.select(f.A); await value.n.retry(f.A); assert.equal(effects.length,1); const t0=at;
    at=t0+30000; await value.p.select(f.A); await value.n.retry(f.A);
    assert.equal(effects.length,1,'PRODUCER_NO_REPEAT_BEFORE_HEARTBEAT');
    at=t0+60000; const selected=await value.p.select(f.A); await value.n.retry(f.A);
    assert.equal(effects.length,2,'PRODUCER_REPEAT_ON_HEARTBEAT'); assert.notEqual(effects[1].id,effects[0].id);
    assert.equal(effects[1].notification.title,effects[0].notification.title); assert.equal(selected.repeatAt,t0+120000);
  });
  it('does not repeat an acknowledged alarm during its silence', async function () {
    clinical(50); const effects=[], acks=[]; const value=open((row,callback)=>{effects.push(row);callback(null,{accepted:true});},{read:async()=>acks});
    await value.p.select(f.A); await value.n.retry(f.A); const t0=at;
    acks.push({group:'default',level:2,ackedAt:t0+1,expiresAt:t0+1+60*60000}); at=t0+2;
    await value.p.select(f.A); await value.n.retry(f.A); assert.equal(effects.at(-1).notification.clear,true,'the ack clear is delivered');
    const delivered=effects.length;
    for (const step of [61000,121000,181000]) { at=t0+step; await value.p.select(f.A); await value.n.retry(f.A); }
    assert.equal(effects.length,delivered,'PRODUCER_ACK_SILENCE_HOLDS');
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
  it('retains the original repeat deadline across unavailable model and identical recovery before due', async function () {
    clinical(50);const original=source,effects=[];
    const value=open((row,callback)=>{effects.push(row);callback(null,{accepted:true});});
    await value.p.select(f.A);await value.n.retry(f.A);
    const before=f.producerStates()[0].producer,deadline=before.repeatAt,request=f.snapshot().requests[0];
    at+=1000;source={...original,eligible:false};await value.p.select(f.A);await value.n.retry(f.A);
    const unavailable=f.producerStates()[0].producer;
    assert.deepEqual(unavailable.output,before.output);assert.equal(effects.length,1,'UNAVAILABLE_MODEL_ADMITS_NO_NORMAL_EFFECT');
    at+=3438;source={...original,runtimeId:'fresh-owner',outputRevision:1};await value.p.select(f.A);await value.n.retry(f.A);
    assert.equal(f.snapshot().requests.length,1,'IDENTICAL_RECOVERY_BEFORE_DUE_RETAINS_REQUEST');
    assert.equal(f.snapshot().requests[0].request_id,request.request_id);assert.equal(effects.length,1);
    assert.equal(unavailable.repeatAt,deadline);assert.equal(f.producerStates()[0].producer.repeatAt,deadline);
  });
  it('retains the genuine due-repeat cause after unavailable model instead of inventing a missing-clock repeat', async function () {
    clinical(50);const original=source,value=open((row,callback)=>callback(null,{accepted:true}));
    await value.p.select(f.A);await value.n.retry(f.A);const before=f.producerStates()[0].producer;
    at+=1000;source={...original,eligible:false};await value.p.select(f.A);
    at=before.repeatAt;source={...original,runtimeId:'fresh-owner'};await value.p.select(f.A);await value.n.retry(f.A);
    const rows=f.snapshot().requests;assert.equal(rows.length,2);assert(rows.every(row=>row.state==='accepted'));
    const expected=require('../lib/tenant-notifications/contract').digest(JSON.stringify(['producer-transition-v2',['repeat',before.output,before.repeatAt],0]));
    assert.equal(rows[1].origin,expected,'REAL_DUE_REPEAT_KEEPS_ORIGINAL_DEADLINE_PROVENANCE');
  });
  it('still retires the repeat deadline for a valid normal output and emits a new realarm after it', async function () {
    clinical(50);const effects=[],value=open((row,callback)=>{effects.push(row);callback(null,{accepted:true});});
    await value.p.select(f.A);await value.n.retry(f.A);at+=1000;clinical(120);await value.p.select(f.A);await value.n.retry(f.A);
    assert.equal(f.producerStates()[0].producer.repeatAt,undefined);assert(effects.some(row=>row.notification.clear));
    at+=1000;clinical(50,'fresh-after-normal');await value.p.select(f.A);await value.n.retry(f.A);
    assert.equal(effects.filter(row=>!row.notification.clear).length,2,'VALID_NORMAL_TO_ALARM_IS_NEW_EFFECT');
    assert.equal(f.producerStates()[0].producer.repeatAt,at+60000);
  });

});
