'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const consumerFactory = require('../lib/change-feed/consumer');
const readerFactory = require('../lib/change-feed/reader');
const parser = require('../lib/change-feed/config');
const decoder = require('../lib/change-feed/pgoutput');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const base = parser.parse({ connectionEnv: 'PG',channel: 'd6_signal',pageSize: 1,degradedPages: 1,intervalMs: 10,heartbeatTimeoutMs: 100 });
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
function consumer (tenants = [A,B], extra = {}) {
  const client = new EventEmitter(), checks = [], order = [];
  client.query = async text => { order.push(text); };
  client.end = async () => client.emit('end');
  const instance = consumerFactory.create({ config: base,tenants,check: async batch => { checks.push(batch); order.push('check'); },
    connect: async () => client,schedule: () => null,cancel: () => {},alert: () => {},...extra });
  return { instance,client,checks,order };
}
function message (k,t) { return { channel: base.channel,payload: JSON.stringify({ v: 1,k,t }) }; }
describe('D6 bounded signalling', function () {
  it('requires bounded explicit configs and a dedicated feed-reader process', async function () {
    assert.throws(() => parser.parse({ connectionEnv: 'PG',channel: 'x',pageSize: 0 }),/FEED_CONFIG/);
    assert.throws(() => parser.parse({ connectionEnv: 'PG',channel: 'x',pageSize: 1025 }),/FEED_CONFIG/);
    assert.throws(() => parser.parse({ connectionEnv: 'PG',channel: 'pg_notify' }),/FEED_CONFIG/);
    await assert.rejects(require('../lib/server/serve').start(['feed-reader','api'],{HOSTNAME:'127.0.0.1',PORT:1337},null,{}),/dedicated/);
  });
  it('commits LISTEN before first reconcile; pages with constant cost at different N', async function () {
    for (const n of [10,1000]) {
      const tenants = Array.from({length:n},(_,i) => '10000000-0000-4000-8000-'+i.toString(16).padStart(12,'0'));
      const f = consumer(tenants);
      try { await f.instance.start(); await f.instance.tick(); assert.equal(f.order[0],'LISTEN "d6_signal"');
        assert.deepEqual(f.checks.map(batch => batch.length),[1,1]); assert.notEqual(f.checks[0][0],f.checks[1][0]); }
      finally { await f.instance.close(); }
    }
  });
  it('recovers a lost hint with healthy paging, ignores unknown tenant and coalesces duplicate hints', async function () {
    const f = consumer();
    try {
      await f.instance.start();
      f.client.emit('notification',{channel:base.channel,payload:JSON.stringify({v:1,k:'heartbeat',reader:A})});
      await f.instance.tick(); await f.instance.tick();
      assert.ok(f.checks.some(batch => batch.includes(B)),'D6_LOST_HINT_BACKSTOP');
      f.client.emit('notification',message('data',B)); f.client.emit('notification',message('data',B));
      f.client.emit('notification',message('data','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
      await f.instance.tick(); assert.equal(f.checks.at(-1).filter(t => t===B).length,1);
      assert.ok(f.checks.flat().every(t => [A,B].includes(t)));
    } finally { await f.instance.close(); }
  });
  it('degrades on missing heartbeat, reconnects listener and reconciles after LISTEN again', async function () {
    let at = 1000;
    const f = consumer([A,B],{now:()=>at});
    try { await f.instance.start();
      f.client.emit('notification',{channel:base.channel,payload:JSON.stringify({v:1,k:'heartbeat',reader:A})});
      await f.instance.tick(); await f.instance.tick(); assert.equal(f.instance.health().degraded,false);
      at += 101; await f.instance.tick(); assert.equal(f.instance.health().degraded,true);
      f.client.emit('end'); await f.instance.tick(); assert.equal(f.order.filter(v=>v.startsWith('LISTEN')).length,2);
    } finally { await f.instance.close(); }
  });
  it('never advances after decode/notification refusal; notification commit precedes acknowledgement', async function () {
    // An empty batch exercises heartbeat without any advancing; malformed input
    // is a real decoder refusal, not a connection/setup failure.
    const calls = [], store = {peek:async()=>[{data:Buffer.from('bad')}],notify:async()=>calls.push('notify'),advance:async()=>calls.push('advance'),close:async()=>{}};
    const r = readerFactory.create({config:{...base,pollMs:10,heartbeatMs:10,rssRefuseBytes:1e9,clockNamespace:'clock',activityNamespace:'control'},store,schedule:()=>null,cancel:()=>{},alert:()=>{}});
    await r.pass(); assert.deepEqual(calls,[]); assert.equal(r.health().degraded,true); await r.close();
  });
  it('rejects truncated, unsupported and oversized binary messages without returning a checkpoint', function () {
    for (const data of [Buffer.from('x'),Buffer.from('B'),Buffer.alloc(2048)]) {
      assert.throws(()=>decoder.decode([{data}],{clockNamespace:'clock',activityNamespace:'control',maxBytes:1024}),/FEED_/);
    }
  });
  it('targets realtime detection after a hint, not the full configured roster', async function () {
    const tenants = [A,B], calls = [], projections = new Map(tenants.map(t=>[t,0]));
    const runtime = await require('../lib/server/realtime/runtime')({tenants,eventDriven:true,recoveryIntervalMs:1000,schedule:()=>null,cancel:()=>{},concurrency:1,
      readCurrent:async tenant=>({tenant,identity:'stable'}),create:current=>({acquire:async()=>({checkpoint:projections.get(current.tenant),frame:{}})}),fanout:async()=>{},
      detect:async selected=>{calls.push(selected);return new Map(selected.map(t=>[t,{identity:'stable',stamp:projections.get(t)}]));}});
    try { projections.set(A,1); await runtime.check([A]); assert.deepEqual(calls,[[A]]); assert.equal(runtime.last(A).checkpoint,1);
      await runtime.tick(); assert.equal(calls.length,1,'D6_IDLE_NO_FULL_SCAN'); }
    finally {await runtime.close();}
  });
  it('paused realtime data work stops while a control page can discover resumption', async function () {
    let paused = false, acquires = 0, invalidates = 0;
    const runtime = await require('../lib/server/realtime/runtime')({tenants:[A],eventDriven:true,recoveryIntervalMs:1000,schedule:()=>null,cancel:()=>{},concurrency:1,
      readCurrent:async tenant=>paused?null:{tenant,identity:'stable'},create:()=>({acquire:async()=>{acquires++;return {checkpoint:1,frame:{}};}}),fanout:async()=>{},
      detect:async selected=>{if(paused)invalidates++;return new Map(selected.map(t=>[t,{identity:paused?null:'stable',stamp:1}]));}});
    try { const before=acquires;paused=true;await runtime.check([A]);assert.equal(acquires,before);assert.equal(invalidates,1);
      paused=false;await runtime.check([A]);assert.equal(acquires,before+1); }
    finally {await runtime.close();}
  });
  it('uses subset evaluator recovery and disarms/reacquires paused tenants without data writes', async function () {
    const stamps = new Map([[A,1],[B,1]]), paused = new Set(), reads = [], cycles = [], schedules = [];
    const runtime = await require('../lib/server/serve/evaluator-runtime')({tenants:[A,B],externalRecovery:true,
      recoveryIntervalMs:1000,timeIntervalMs:1000,schedule:fn=>{schedules.push(fn);return fn;},cancel:()=>{},
      setTimer:()=>null,clearTimer:()=>{},readCurrent:async tenant=>({tenant,identity:'a'.repeat(64)}),
      readStamps:async selected=>{reads.push(selected);return new Map(selected.map(t=>[t,{stamp:stamps.get(t),deleted:0}]));},
      activity:{check:async(op,tenant)=>({eligible:!paused.has(tenant),state:paused.has(tenant)?'paused':'active',code:paused.has(tenant)?'TENANT_PAUSED':null})},
      create:async current=>({evaluate:async()=>{cycles.push(current.tenant);return {checkpoint:stamps.get(current.tenant),signature:{stamp:stamps.get(current.tenant),deleted:0}};},evaluateTime:async()=>({checkpoint:1}),close:()=>{}})});
    try {
      assert.equal(schedules.length,1,'D6_EVALUATOR_NO_FULL_RECOVERY_TIMER');
      cycles.length=0;stamps.set(A,2);await runtime.backstop([A]);assert.deepEqual(reads,[[A]]);assert.deepEqual(cycles,[A]);
      cycles.length=0;paused.add(A);await runtime.backstop([A]);assert.equal(runtime.last(A),null);assert.deepEqual(cycles,[]);
      paused.delete(A);await runtime.backstop([A]);assert.deepEqual(cycles,[A]);assert.ok(runtime.last(A));
      assert.equal(runtime.last(B).inputCheckpoint,1,'D6_EVALUATOR_OTHER_TENANT_UNCHANGED');
    } finally {await runtime.close();}
  });
  it('RSS soft refusal issues no peek and cannot acknowledge a batch', async function () {
    let reads=0,acks=0;
    const r=readerFactory.create({config:{...base,pollMs:10,heartbeatMs:10,rssRefuseBytes:100},rss:()=>101,
      store:{peek:async()=>{reads++;return [];},notify:async()=>{},advance:async()=>acks++,close:async()=>{}},alert:()=>{},schedule:()=>null,cancel:()=>{}});
    await r.pass();assert.equal(reads,0);assert.equal(acks,0);assert.equal(r.health().refusal,'FEED_RSS_REFUSED');await r.close();
  });

});
