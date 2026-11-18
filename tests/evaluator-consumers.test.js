'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const scope = require('../lib/storage/tenant-scope');
const parse = require('../lib/server/serve/evaluator-config');
const readiness = require('../lib/server/serve/evaluator-consumer-readiness');
const protocol = require('./fixtures/evaluator-consumers-protocol');
const nativeBoot = require('./fixtures/evaluator-native-recovery-protocol');
const A = '11111111-1111-4111-8111-111111111111';
const plan=require('./fixtures/multitenant-plan'),layout=plan.layout('consumer_cfg');
const urls=Object.fromEntries(Object.entries(plan.syntheticUrls(layout)).map(([role,url])=>[role,url.replace('postgres.example.test','127.0.0.1').replace('nightscout_test_plan','composition_test')]));
const canonical=plan.documents({layout,urls});
function document () {const value=structuredClone(canonical.configs.evaluator);delete value.consumers;return value;}

function selected () {
  return { realtime: { outbox: { connectionEnv: 'OUTBOX_PG', namespace: 'composed_outbox', maxRows: 10, maxBytes: 100000, maxConnections: 2 },
    suppression: { connectionEnv: 'ALARM_PG', namespace: 'composed_alarm', maxRows: 10, maxBytes: 100000, maxConnections: 2 },
    route: { id: 'realtime-composed', maxMessageBytes: 20000, operationTimeoutMs: 500 },
    maxPayloadBytes: 10000, maxInflight: 2, attemptTimeoutMs: 1000, retryDelayMs: 100, pollIntervalMs: 100, retryIntervalMs: 200 } };
}
const source = { ...canonical.environments.evaluator, EVAL_PG: 'postgres://synthetic-evaluator:synthetic@127.0.0.1/composition_test',
  OUTBOX_PG: 'postgres://synthetic-outbox:synthetic@127.0.0.1:5432/composition_test',
  ALARM_PG: 'postgresql://synthetic-reader:synthetic@127.0.0.1/composition_test', NS_REALTIME_INTERNAL_SOCKET: '/tmp/synthetic-composition/rt.sock' };

describe('explicit evaluator consumer configuration', function () {
  it('is default-off and admits same datastore with different restricted principals rather than equal credential URLs', async function () {
    const off = parse.parse(document(), source); assert.equal(off.consumers, undefined);
    assert.equal(await require('../lib/server/serve/evaluator-consumers').prepare({ config: off }), null);
    const d = document(); d.consumers = selected(); const configured = parse.parse(d, source);
    assert.equal(configured.consumers.realtime.outbox.connectionString, source.OUTBOX_PG);
    assert.equal(configured.consumers.realtime.route.socketPath, source.NS_REALTIME_INTERNAL_SOCKET);
  });
  it('refuses unknown routes unsafe namespace/datastore and missing or non-Node-compatible explicit bounds', function () {
    for (const change of [d => { d.consumers.unknown = {}; }, d => { d.consumers.realtime.extra = true; }, d => { d.consumers.realtime.backstopIntervalMs = 60000; },
      d => { delete d.consumers.realtime.retryIntervalMs; }, d => { d.consumers.realtime.pollIntervalMs = 2147483648; },
      d => { d.consumers.realtime.attemptTimeoutMs = 2147483648; }, d => { d.consumers.realtime.route.operationTimeoutMs = 1001; },
      d => { d.consumers.realtime.route.maxMessageBytes = 10000; },
      d => { d.consumers.realtime.outbox.namespace = 'public'; }, d => { d.consumers.realtime.suppression.namespace = d.postgres.namespaces.entries; }]) {
      const d = document(); d.consumers = selected(); change(d); assert.throws(() => parse.parse(d, source), /evaluator consumer/);
    }
    const d = document(); d.consumers = selected();
    assert.throws(() => parse.parse(d, { ...source, OUTBOX_PG: source.OUTBOX_PG.replace('composition_test', 'another_test') }), /evaluator consumer/);
  });
  it('requires restart for consumer infrastructure or credential changes without granting tenant admission from the worker file', async function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consumer-config-')), file = path.join(dir, 'config.json');
    try {
      const d = document(); d.consumers = selected(); fs.writeFileSync(file, JSON.stringify(d));
      const env = { ...source, MULTITENANT_EVALUATOR_CONFIG: file }, loaded = parse.load(env);
      assert.equal(await loaded.readCurrent(A),null,'worker file never substitutes for current admitted registry state');
      d.consumers.realtime.retryIntervalMs++; fs.writeFileSync(file, JSON.stringify(d)); await assert.rejects(loaded.readCurrent(A), /requires restart/);
      d.consumers.realtime.retryIntervalMs--; fs.writeFileSync(file, JSON.stringify(d));
      env.OUTBOX_PG = env.OUTBOX_PG.replace(':synthetic@', ':changed-synthetic@'); await assert.rejects(loaded.readCurrent(A), /requires restart/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('selected actual database consumer readiness protocols', function () {
  let mode;
  beforeEach(function () { mode = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(function () { scope.setTenancyMode(mode); });
  it('screens both physical backend admissions and rechecks structure on explicit invalidation',async function(){
    const filename=require.resolve('../lib/server/serve/evaluator-consumers'), local=require('node:module').createRequire(filename);
    const module={exports:{}},backends=[],checks=[];let unsafe=false,deny=false,readerPort,inRead=false,readBodies=0;
    const proof=kind=>{checks.push(kind);if(unsafe)throw new Error('SYNTHETIC_STRUCTURAL_CHANGE');};
    const connection={transaction:fn=>fn(),async readOnlyTransaction(fn){assert.equal(inRead,false);inRead=true;try{return await fn();}finally{inRead=false;}},end:async()=>{}};
    const mocks={
      '../../storage/postgres-connection':async options=>{assert.equal(typeof options.admitBackend,'function');backends.push(options.admitBackend);await options.admitBackend({physical:backends.length});return connection;},
      '../../tenant-notifications/readiness':async()=>proof('outbox'),
      './evaluator-consumer-readiness':{suppression:async()=>proof('suppression'),sameDatastore:async()=>{},operational:async()=>proof('operational')},
      '../../tenant-notifications/postgres':()=>({own:async()=>{},close:async()=>{},consume:async()=>{},enqueue:async()=>{},due:async()=>[],begin:async()=>{},dispatch:async()=>{},finish:async()=>{},receipts:async()=>[]}),
      '../../tenant-alarms/postgres':{createReader:({connection:db})=>{readerPort=db;return {read:()=>db.readOnlyTransaction(()=>{readBodies++;return [];}),allows:async()=>true};}},
      '../realtime/alarm-transport':{createAdapter:()=>({send(){}}),createSliceAdapter:()=>({send(){}})}
    };
    require('node:vm').runInThisContext('(function(require,module,exports){'+fs.readFileSync(filename,'utf8')+'\n})',{filename})(id=>Object.hasOwn(mocks,id)?mocks[id]:local(id),module,module.exports);
    const d=document();d.consumers=selected();const cfg={...parse.parse(d,source),pgstream:{},readCurrent:async()=>null};
    const window=require('./fixtures/operation-window-runtime-protocol')({trustedWorker:true}).window;
    await window.ready();let value;
    try {
      value=await module.exports.prepare({config:cfg,clinicalConnection:{},current:()=>null,isCurrent:async()=>true,operationWindow:window,
        jobContext:require('../lib/server/serve/evaluator-job-context').create('delivery'),assertOperational:()=>{assert.equal(inRead,true,'SUPPRESSION_AUTHORITY_MUST_RUN_INSIDE_READ');if(deny)throw new Error('SYNTHETIC_SUPPRESSION_AUTHORITY_REFUSED');}});
      assert.deepEqual(checks,['outbox','suppression'],'STARTUP_AND_BOTH_BACKEND_ADMISSIONS');
      const before=readBodies;deny=true;
      await assert.rejects(readerPort.readOnlyTransaction(()=>{readBodies++;}),/SYNTHETIC_SUPPRESSION_AUTHORITY_REFUSED/,'READ_ONLY_PORT_MUST_RETAIN_OPERATIONAL_AUTHORITY');
      assert.equal(readBodies,before,'REFUSED_AUTHORITY_MUST_PRECEDE_SUPPRESSION_BODY');deny=false;
      await value.verifyOperational();unsafe=true;
      await assert.rejects(value.verifyOperational(),/SYNTHETIC_STRUCTURAL_CHANGE/,'DDL_CHANGE_REFUSES');
      for(const admit of backends)await assert.rejects(admit({physical:'replacement'}),/SYNTHETIC_STRUCTURAL_CHANGE/,'REPLACEMENT_BACKEND_REFUSES');
      unsafe=false;await value.verifyOperational();
    } finally {await value?.close();await window.close();}
  });
  it('challenges actual selected connections with one scoped nonce and refuses another datastore without credential comparison', async function () {
    let held = null; const observed = [];
    const clinical = { async transaction (fn) { try { return await fn(); } finally { held = null; } },
      async query (text, values) { held = values[0]; observed.push('owner'); return { rows: [] }; } };
    const target = acquired => ({ transaction: fn => fn(), async query (text, values) {
      assert.equal(values[0], held); assert.equal(scope.currentTenant(), A); observed.push('challenge'); return { rows: [{ acquired }] };
    } });
    await readiness.sameDatastore(clinical, [target(false), target(false)], A);
    assert.deepEqual(observed, ['owner', 'challenge', 'challenge']); assert.equal(held, null);
    await assert.rejects(readiness.sameDatastore(clinical, [target(true)], A), /READINESS_REFUSED/, 'EVALUATOR_CONSUMER_DATASTORE_PROOF');
    assert.equal(held, null); await assert.rejects(readiness.sameDatastore(clinical, [clinical], A), /READINESS_REFUSED/);
  });
  it('screens the selected suppression snapshot role table policy shape and exact read-only catalogue', async function () {
    const migration = require('../migrations/candidates/postgres-alarm-suppression-v1.json').migrations[0];
    const template = { kind: 'r', persistence: 'p', reads: true, secured: true,
      columns: [['tenant_id', 'uuid', true], ['alarm_group', 'text', true], ['alarm_level', 'integer', true], ['acked_at', 'bigint', true], ['expires_at', 'bigint', true]],
      primary_key: ['tenant_id', 'alarm_group', 'alarm_level'], policies: [{ command: '*', roles: [0], permissive: true,
        using: "tenant_id = nullif(current_setting('app.current_tenant_id',true),'')::uuid", check: "tenant_id = nullif(current_setting('app.current_tenant_id',true),'')::uuid" }] };
    const db = flags => ({ async query (text) {
      if (text.includes('suppression-role')) return { rows: [{ uses_schema: true, unrelated: flags.unrelated, creates: flags.creates, operator: flags.operator }] };
      if (text.includes('suppression-shape')) return { rows: [{ ...structuredClone(template), ...(flags.shape || {}) }] };
      return { rows: flags.history || [{ name: migration.name, checksum: migration.checksum }] };
    } });
    await readiness.suppression(db({}), 'alarm_test');
    for (const flags of [{ unrelated: true }, { creates: true }, { operator: true }, { shape: { secured: false } }, { shape: { reads: false } },
      { shape: { policies: [] } }, { shape: { primary_key: ['alarm_group'] } }, { shape: { columns: [] } }, { history: [] }]) {
      await assert.rejects(readiness.suppression(db(flags), 'alarm_test'), /READINESS_REFUSED/, 'EVALUATOR_CONSUMER_SUPPRESSION_SCOPE');
    }
  });
});

describe('actual runtime alarm outbox consumer source composition', function () {
  let mode, owned;
  beforeEach(function () { mode = scope.getTenancyMode(); scope.setTenancyMode('multi'); owned = []; });
  afterEach(async function () { await Promise.all(owned.map(lab => lab.close())); scope.setTenancyMode(mode); });
  async function open (send) { const lab = await protocol(send); owned.push(lab); return lab; }
  it('consumes successful role outputs with committed intent before handoff and normal RT repeats', async function () {
    const l = await open(); await l.start();
    assert.equal(l.effects.length, 2, 'EVALUATOR_CONSUMER_ACTUAL_PATH both tenant outputs consumed');
    for (const request of l.effects) assert.equal(l.files.get(request.tenant).snapshot().requests[0].state, 'accepted');
    await l.consumers.wake(l.A); assert.equal(l.effects.length, 2, 'same output once');
    // Identical content keeps the evaluator revision: no repeat before the
    // tenant heartbeat (60 s default) elapses, one repeat after it.
    await l.runtime.tick(l.A); await l.consumers.wake(l.A); assert.equal(l.effects.length, 2, 'EVALUATOR_CONSUMER_NO_REPEAT_BEFORE_HEARTBEAT');
    l.advance(60000); await l.runtime.tick(l.A); await l.consumers.wake(l.A);
    assert.equal(l.effects.length, 3, 'EVALUATOR_CONSUMER_RT_POLICY alarm repeats on the heartbeat clock');
    assert.notEqual(l.effects[0].id, l.effects.at(-1).id);
    assert.equal(l.consumers.health().tenants.find(row => row.tenant === l.A).state, 'handoff-accepted');
  });
  it('shares equal active poll/retry cadence while retaining durable retry identities', async function () {
    let failing=true;
    const l=await protocol((request,callback)=>callback(failing?new Error('uncertain'):null,{accepted:true}),{retryIntervalMs:100});
    try {
      await l.start();const ids=l.effects.map(row=>row.id);
      assert.equal(l.consumerTimers.length,1,'EQUAL_CADENCE_ONE_ACTIVE_SWEEP');
      failing=false;l.advance(1);l.consumerTimers[0].fn();await Promise.all([l.consumers.flush(l.A),l.consumers.flush(l.B)]);
      assert.equal(l.effects.length,4);assert.deepEqual(new Set(l.effects.slice(2).map(row=>row.id)),new Set(ids));
    } finally {await l.close();}
  });
  it('polls actual runtime timer outputs and retries uncertain same IDs without coupling delivery to clinical progress', async function () {
    let failing = true;
    const l = await open((request, callback) => callback(failing ? new Error('controlled sink absent') : null, { accepted: true }));
    await l.start(); const ids = l.effects.map(row => row.id);
    assert.ok(l.consumers.health().tenants.every(row => row.state === 'pending'));
    failing = false; l.advance(1); l.consumerTimers[1].fn();
    await Promise.all([l.consumers.flush(l.A), l.consumers.flush(l.B)]);
    assert.equal(l.effects.length, 4, 'EVALUATOR_CONSUMER_RETRY_TIMER persisted attempts retried');
    assert.deepEqual(new Set(l.effects.slice(2).map(row => row.id)), new Set(ids));
    l.advance(60000); await l.runtime.tick(l.A); l.consumerTimers[0].fn(); await Promise.all([l.consumers.flush(l.A), l.consumers.flush(l.B)]);
    assert.equal(l.effects.length, 6, 'EVALUATOR_CONSUMER_OUTPUT_POLL timer output actually consumed (one heartbeat repeat per tenant)');
  });
  it('defers failed clinical/config cycles and newly snoozed pending work without stopping the other tenant', async function () {
    const l = await open((request, callback) => callback(new Error('uncertain sink'))); await l.start();
    const a = l.files.get(l.A).snapshot(), b = l.files.get(l.B).snapshot();
    l.refusal.add(l.A); await l.runtime.acquire(l.A); await l.consumers.wake(l.A);
    assert.deepEqual(l.files.get(l.A).snapshot(), a, 'failed clinical cycle cannot enqueue');
    l.advance(60000); await l.runtime.tick(l.B); await l.consumers.wake(l.B); assert.equal(l.files.get(l.B).snapshot().requests.length, b.requests.length + 1);
    l.refusal.delete(l.A); await l.runtime.acquire(l.A);
    await l.alarm.writer.ack(l.alarm.operation(1, 'default', 1000, l.A));
    const effects = l.effects.length; l.advance(1); await l.consumers.retry(l.A);
    const afterAck = l.effects.slice(effects);
    assert.equal(afterAck.length, 1);
    assert.deepEqual(afterAck[0].notification, {clear: true, title: 'All Clear', message: "default - Warning was ack'd", group: 'default'});
    assert.ok(l.files.get(l.A).snapshot().requests.filter(row => !row.payload.clear).every(row => row.state === 'cancelled'),
      'EVALUATOR_CONSUMER_CURRENT_SNOOZE queued ALARM retry suppressed');
    l.configs.delete(l.B); await l.runtime.acquire(l.B); await l.consumers.retry(l.B);
    assert.equal(l.effects.length, effects + 1); assert.equal(l.consumers.health().tenants.find(row => row.tenant === l.B).clinicalEligible, false);
  });
  it('aborts owned delivery waits on close while clinical scheduling and results remain independent', async function () {
    let enter, complete, signal;
    const entered = new Promise(resolve => { enter = resolve; });
    const l = await open((request, callback) => { if (request.tenant === l.A) { signal = request.signal; complete = callback; enter(); } else callback(null, { accepted: true }); });
    l.consumers.start(); await entered;
    const cycles = () => l.runtime.health().tenants.find(row => row.tenant === l.A).cycles;
    const before = cycles(); await l.runtime.tick(l.A);
    assert.ok(cycles() > before, 'clinical cycle does not wait for delivery');
    const closing = l.consumers.close();
    try { assert.equal(signal.aborted, true, 'EVALUATOR_CONSUMER_ABORT_OWNED_WAIT'); }
    finally { complete(new Error('fixture release')); await closing; }
    const stored = l.files.get(l.A).snapshot(); complete(null, { accepted: true }); await Promise.resolve();
    assert.deepEqual(l.files.get(l.A).snapshot(), stored); assert.equal(l.cancelled.filter(timer => l.consumerTimers.includes(timer)).length, 2, "run and retry schedules cancelled");
  });
});

describe('selected evaluator role consumes notification composition', function () {
  async function criterion(change=source=>source) {
    const vm = require('node:vm'), { createRequire } = require('node:module');
    const filename = path.resolve(__dirname, '../lib/server/serve/evaluator-preview.js'), local = createRequire(filename);
    const calls = [],nativeEvents=[],nativePorts=nativeBoot.mocks({events:nativeEvents}); let release;
    const held = new Promise(resolve => { release = resolve; });
    const clinical = { end: async () => { calls.push('clinical-end'); } };
    const consumer = { start () { calls.push('consumer-start'); }, wake () { calls.push('consumer-wake'); return held; },
      retry () {}, flush () {}, health: () => ({ enabled: true }), async close () { calls.push('consumer-close'); release(); } };
    const runtime = { acquire: async () => { calls.push('clinical-acquire'); }, tick: async () => {},
      last: () => null, isCurrent: async () => true, health: () => ({ tenants: [] }), close: async () => { calls.push('clinical-close'); } };
    const sandbox = { module: { exports: {} }, structuredClone, setImmediate, console: { log () {} }, require (name) {
      if(Object.hasOwn(nativePorts,name))return nativePorts[name];
      if (name === '../../storage/postgres-durable-replay') return () => nativeBoot.replay({events:nativeEvents});
      if (name === '../../storage/postgres-connection') return Object.assign(async () => clinical,{readopt:async()=>{}});
      if (name === './registry-tenant-set') return {open:async()=>({tenants:new Map([[A,parse.registryEntry(A)]]),isActive:()=>true,revision:()=>1,stats:()=>({}),follow:async()=>{},close:async()=>{}})};
      if (name === '../../pool-membership') return {member:async()=>({configured:{mode:'standalone'},register:async()=>{},close:async()=>{}})};
      if (name === './evaluator-pool') return {create:()=>({partitioned:false,start(){},refresh:async()=>{},admits:()=>true,close(){}})};
      if (name === '../../trusted-worker/postgres') return {create:()=>({scan:async()=>new Map(),read:async()=>({version:1,effective:{},policyGeneration:1}),current:()=>null,state:()=>({available:true,generation:1}),health:()=>({available:true}),close:async()=>{}})};
      if (name === '../../trusted-worker/lifecycle') return async()=>({version:()=>1,activateRefresh(){},close:async()=>{}});
      if (name === '../../pgstream/evaluator') return {open:async()=>({store:{work:async()=>[],nextDue:async()=>null,deliveries:async()=>[]},ready:async()=>{},assertAvailable(){},health:()=>({}),close:async()=>{}})};
      if (name === '../../migrations/postgres') return {run:async()=>{}};
      if (name === './tenant-startup') return {create:()=>({warm:async()=>{},close:async()=>{},health:()=>({})})};
      // The role's one platform check is recorded as its startup readiness.
      if (name === './platform-verification') return require('./fixtures/platform-proof')(undefined, async () => { calls.push('clinical-readiness'); });
      if (name === './evaluator-readiness') return Object.assign(async () => { calls.push('clinical-readiness'); }, {provisionTenant: async () => {}});
      if (name === './evaluator-runtime') return async () => { calls.push('clinical-start'); return runtime; };
      if (name === './evaluator-consumers') return { async prepare (input) {
        assert.equal(input.clinicalConnection, clinical); calls.push('consumer-prepare'); return consumer;
      } };
      return local(name);
    } };
    vm.runInNewContext(change(fs.readFileSync(filename, 'utf8')), sandbox, { filename });
    const previous = scope.getTenancyMode();
    const d=document();d.consumers=selected();const parsed=parse.parse(d,source),cfg={...parsed,pgstream:nativeBoot.config(parsed.pgstream)};
    const window=require('./fixtures/operation-window-runtime-protocol')({trustedWorker:true}).window;await window.ready();
    let role;
    try {
      role = await sandbox.module.exports.boot(cfg,{operationWindow:window});
      assert.deepEqual(calls.slice(0,3),['clinical-readiness','clinical-start','consumer-prepare'],'EVALUATOR_CONSUMER_SELECTED_BOOT');
      assert(calls.indexOf('consumer-start')>calls.indexOf('consumer-prepare'),'CONSUMERS_START_AFTER_PREPARATION');
      // Clinical startup may proceed while the independent delivery roster prepares.
      await role.acquire(A); assert.equal(calls.at(-1), 'consumer-wake', 'clinical promise completed without awaiting held handoff');
      assert.equal(role.health().consumers.enabled, true);
      await role.close(); await role.close();
      assert.equal(calls.filter(name => name === 'consumer-close').length, 1);
      assert.equal(calls.filter(name => name === 'clinical-end').length, 1);
      assert.ok(calls.indexOf('consumer-close') < calls.indexOf('clinical-close'));
      for(const event of ['identify-created','identify-closed','native-recovery-created','native-recovery-closed','native-configured'])assert.equal(nativeEvents.filter(value=>value===event).length,1,'NATIVE_BOOT_OWNS_AND_CLOSES_EACH_PORT_ONCE:'+event);
    } finally { release(); if (role) await role.close(); await window.close();scope.setTenancyMode(previous); }
  }
  it('boots starts and wakes the actual selected composition without awaiting handoff latency and closes all owned resources',()=>criterion());
  it('control: dropping the owned native recovery close is red and restored composition drains it',async()=>{
    await assert.rejects(criterion(source=>{const needle='await snapshotRecovery?.close();';assert.equal(source.split(needle).length,2,'NATIVE_CLOSE_CONTROL_MUST_LAND');return source.replace(needle,'');}),/NATIVE_BOOT_OWNS_AND_CLOSES_EACH_PORT_ONCE:native-recovery-closed/);
    await criterion();
  });
});


// These expectations intentionally replace the retired per-pass catalogue proof:
// admission/schema boundaries own structure; delivery keeps current effect fences.
describe('event driven notification recovery without quiet discovery', function () {
  let previous;
  beforeEach(() => { previous = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(previous));

  function coordinate (mutate = value => value) {
    const filename = require.resolve('../lib/server/serve/evaluator-consumers');
    const module = {exports:{}};
    require('node:vm').runInThisContext('(function(require,module,exports){' + mutate(fs.readFileSync(filename,'utf8')) + '\n})', {filename})(require('node:module').createRequire(filename),module,module.exports);
    return module.exports.coordinate;
  }
  async function resumed (lab, {quiet = false, mutate, send} = {}) {
    const timers = [], effects = [];
    const quietOutputs = new Map([lab.A,lab.B].map(tenant => [tenant,{...lab.runtime.last(tenant),eligible:false,result:{emitted:[],requested:[]}}]));
    const store = Object.fromEntries(['enqueue','consume','due','begin','dispatch','finish','receipts'].map(method => [method,
      input => lab.files.get(input.tenant).store[method](input)]));
    const value = coordinate(mutate)({tenants:[lab.A,lab.B], route:'realtime-test', store, reader:lab.alarm.reader,
      current: quiet ? tenant => quietOutputs.get(tenant) : lab.runtime.last,
      currentConfig:async tenant=>lab.configs.get(tenant), isCurrent:lab.runtime.isCurrent,
      // A stale caller supplying the withdrawn option must cause no catalogue work.
      verifyPass:()=>{throw new Error('UNEXPECTED_DELIVERY_CATALOGUE_PROOF');},
      adapter:{id:'realtime-test',send(request,callback){effects.push(request);if(send)send(request,callback);else callback(null,{accepted:true});}},
      now:()=>lab.files.get(lab.A).now(), maxRows:10,maxBytes:100000,maxPayloadBytes:10000,
      maxInflight:2,attemptTimeoutMs:60000,retryDelayMs:1,pollIntervalMs:100,retryIntervalMs:200,
      schedule(fn,interval){const timer={fn,interval};timers.push(timer);return timer;},cancel(){} });
    value.start(); await Promise.all([value.flush(lab.A),value.flush(lab.B)]);
    return {value,timers,effects};
  }
  async function quiet (mutate) {
    const lab=await protocol();let second;
    try {
      second=await resumed(lab,{quiet:true,mutate});
      const calls=lab.files.get(lab.A).calls.length;
      assert.equal(second.timers.length,2,'ONLY_ACTIVE_RETRY_TIMERS');
      for(let i=0;i<3;i++)for(const timer of second.timers)await timer.fn();
      await second.value.flush(lab.A);
      assert.equal(lab.files.get(lab.A).calls.length,calls,'QUIET_TENANT_NO_SQL');
      assert.equal(second.value.health([lab.A]).tenants[0].selections,1,'STARTUP_ONLY_SELECTION');
      assert.equal(second.effects.length,0);
    } finally {await second?.value.close();await lab.close();}
  }
  it('healthy quiet tenants do no selection or SQL after startup and have no roster timer',async()=>{await quiet();});
  it('reintroducing quiet discovery is red; restored source leaves quiet tenants alone',async function(){
    await assert.rejects(quiet(source=>{
      const needle="      sweep('start', 'run', tenants);";
      assert.equal(source.split(needle).length,2);
      return source.replace(needle,needle+" timers.push(schedule(() => sweep('backstop','run',tenants),60000));");
    }),error=>error.code==='ERR_ASSERTION' && error.message.includes('ONLY_ACTIVE_RETRY_TIMERS'));
    await quiet();
  });
  async function recovery (mutate) {
    const lab=await protocol((request,callback)=>callback(new Error('lost-response')));let second;
    try {
      await lab.start();const id=lab.effects.find(row=>row.tenant===lab.A).id;
      await lab.consumers.close();lab.advance(1);
      // New coordinator has an empty RAM active set. Startup reads actual saved
      // producer + intent rows and retries the same durable identity.
      second=await resumed(lab,{mutate});
      assert.equal(second.effects.find(row=>row.tenant===lab.A)?.id,id,'RESTART_RECOVERS_DURABLE_ID');
      assert.ok(lab.files.get(lab.A).calls.some(row=>row.sql?.includes('tenant_notification_state')));
      assert.equal(second.value.health([lab.A]).tenants[0].repeatAt !== null,true,'RESTART_RESTORES_REPEAT');
      // Lose an ephemeral revision wake: no call to revised. Explicit transport
      // recovery must reconcile the current output against persisted state.
      lab.advance(60000);await lab.runtime.tick(lab.A);
      const before=second.effects.length;
      await second.value.recover();await second.value.flush(lab.A);
      assert.ok(second.effects.length>before,'RECONNECT_RECOVERS_LOST_WAKE');
    } finally {await second?.value.close();await lab.close();}
  }
  it('restart restores durable retry/repeat and explicit reconnect recovers a dropped output wake',async()=>{await recovery();});
  it('breaking startup reconciliation or reconnect reconciliation is red; restored paths pass',async function(){
    for(const needle of ["      sweep('start', 'run', tenants);", "          await sweep('recovery', 'run', [...tenants]);"]) {
      const source=fs.readFileSync(require.resolve('../lib/server/serve/evaluator-consumers'),'utf8');
      assert.equal(source.split(needle).length,2,'CONTROL_MUST_LAND');
      const symptom=needle.includes("'start'")?'RESTART_RECOVERS_DURABLE_ID':'RECONNECT_RECOVERS_LOST_WAKE';
      await assert.rejects(recovery(value=>value.replace(needle,'')),error=>error.code==='ERR_ASSERTION' && error.message.includes(symptom));
    }
    await recovery();
  });
  async function overlap (mutate) {
    const lab=await protocol();let value,release;
    try {
      const current=new Map([lab.A,lab.B].map(tenant=>[tenant,{...lab.runtime.last(tenant),eligible:false,result:{emitted:[],requested:[]}}]));
      let block=false,entered;const blocked=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;}),effects=[];
      const store=Object.fromEntries(['enqueue','consume','due','begin','dispatch','finish','receipts'].map(method=>[method,async input=>{
        if(method==='consume' && input.tenant===lab.B && block){entered();await gate;}
        return lab.files.get(input.tenant).store[method](input);
      }]));
      value=coordinate(mutate)({tenants:[lab.A,lab.B],route:'realtime-test',store,reader:lab.alarm.reader,current:tenant=>current.get(tenant),
        currentConfig:async tenant=>lab.configs.get(tenant),isCurrent:lab.runtime.isCurrent,
        adapter:{id:'realtime-test',send(request,callback){effects.push(request);callback(null,{accepted:true});}},
        now:()=>lab.files.get(lab.A).now(),maxRows:10,maxBytes:100000,maxPayloadBytes:10000,maxInflight:2,
        attemptTimeoutMs:1000,retryDelayMs:1,pollIntervalMs:100,retryIntervalMs:200,schedule:()=>({}),cancel(){}});
      value.start();await Promise.all([value.flush(lab.A),value.flush(lab.B)]);
      block=true;const first=value.recover();await blocked;await value.flush(lab.A);
      const before=value.health([lab.A]).tenants[0].selections;
      lab.advance(60000);await lab.runtime.tick(lab.A);current.set(lab.A,lab.runtime.last(lab.A));
      let completed=false;const second=value.recover().then(()=>{completed=true;});
      await Promise.resolve();await Promise.resolve();
      assert.equal(completed,false,'OVERLAPPING_RECOVERY_MUST_AWAIT_RECONCILIATION');
      release();await Promise.all([first,second]);
      assert.ok(value.health([lab.A]).tenants[0].selections>before,'OVERLAPPING_RECOVERY_MUST_REVISIT_ALREADY_SCANNED_TENANT');
      assert.equal(effects.length,1,'OVERLAPPING_RECOVERY_DELIVERS_LOST_WAKE');
    } finally {release?.();await value?.close();await lab.close();}
  }
  it('overlapping recovery awaits and reruns durable reconciliation after a lost wake',async()=>{await overlap();});
  it('dropping the recovery rerun is red; restored overlapping recovery delivers',async function(){
    const needle='} while (recoverAgain && !closed);';
    const source=fs.readFileSync(require.resolve('../lib/server/serve/evaluator-consumers'),'utf8');
    assert.equal(source.split(needle).length,2,'CONTROL_MUST_LAND');
    await assert.rejects(overlap(value=>value.replace(needle,'} while (false);')),
      error=>error.code==='ERR_ASSERTION' && error.message.includes('OVERLAPPING_RECOVERY_MUST_REVISIT'));
    await overlap();
  });
  async function revision (mutate) {
    const lab=await protocol();let second;
    try {
      second=await resumed(lab,{mutate});const before=second.effects.length;
      lab.advance(60000);await lab.runtime.tick(lab.A);
      second.value.revised(lab.A);await second.value.flush(lab.A);
      assert.equal(second.effects.length,before+1);
    } finally {await second?.value.close();await lab.close();}
  }
  it('output revision wakes delivery without waiting for a retry timer',async()=>{await revision();});
  it('reintroducing per-pass catalogue verification is red; restored delivery passes',async function(){
    await assert.rejects(revision(source=>{
      const needle='          const selected = await select(state.tenant);';
      assert.equal(source.split(needle).length,2);
      return source.replace('pool, schedule','pool, verifyPass, schedule').replace(needle,'          await verifyPass(state.tenant);\n'+needle);
    }),error=>error.code==='ERR_ASSERTION');
    await revision();
  });
});

async function staticReconstructionCriterion (change = text => text) {
  const slicePeers=require('../lib/realtime-ownership').peers({NS_REALTIME_SLICE_PEERS:JSON.stringify([{socket:'/synthetic/reconstructed-1.sock'},{socket:'/synthetic/reconstructed-2.sock'}])},undefined,{maxBytes:20000,timeoutMs:500});
  const filename = require.resolve('../lib/server/serve/evaluator-consumers'), local = require('node:module').createRequire(filename);
  const output = {exports: {}}, jobs = require('../lib/server/serve/evaluator-job-context').create('delivery');
  const window = require('./fixtures/operation-window-runtime-protocol')({trustedWorker: true}).window;
  let attempt = 0, closed = 0, ended = 0, value;
  const connection = {transaction: fn => fn(), end: async () => {ended++;}};
  const mocks = {
    '../../storage/postgres-connection': async () => connection,
    '../../tenant-notifications/readiness': async () => {},
    './evaluator-consumer-readiness': {suppression: async () => {}, sameDatastore: async () => {}, operational: async () => {}},
    '../../tenant-notifications/postgres': () => ({consume:async()=>{},enqueue:async()=>{},due:async()=>[],begin:async()=>{},dispatch:async()=>{},finish:async()=>{},receipts:async()=>[],own: async () => {}, close: async () => {closed++;}, async ready () {
      if (++attempt === 1) throw Object.assign(new Error('EVALUATOR_FEED_UNAVAILABLE'), {code: 'EVALUATOR_FEED_UNAVAILABLE'});
    }}),
    '../../tenant-alarms/postgres': {createReader: () => ({read: async () => [], allows: async () => true})}
  };
  require('node:vm').runInThisContext('(function(require,module,exports){' + change(fs.readFileSync(filename, 'utf8')) + '\n})', {filename})(id => Object.hasOwn(mocks, id) ? mocks[id] : local(id), output, output.exports);
  const d = document(); d.consumers = selected();
  const parsed = parse.parse(d, source);
  const config = {...parsed, pgstream: {}, tenants: new Map([[A, {}]]), consumers: {realtime: {...parsed.consumers.realtime, slicePeers}}, readCurrent: async () => null};
  const previous = scope.getTenancyMode(); scope.setTenancyMode('multi');
  try {
    await window.ready();
    const prepare = () => output.exports.prepare({config, clinicalConnection: {}, current: () => null, isCurrent: () => true,
      operationWindow: window, jobContext: jobs, assertOperational: () => {}});
    await assert.rejects(prepare(), {code: 'EVALUATOR_FEED_UNAVAILABLE'});
    value = await prepare();
    assert.equal(attempt, 2); assert.equal(closed, 1); assert.equal(ended, 2, 'partial construction closes both owned pools');
    const ordinal=require('../lib/pool-membership/slice').bucket(A,2);assert.equal(slicePeers.route(A).ordinal,ordinal,'RECONSTRUCTED_CONSUMER_RETAINS_STATIC_ROUTE');
    await value.close(); value = null;
    assert.equal(slicePeers.route(A).ordinal,ordinal,'immutable route survives constructor cleanup without a file reader');
  } finally {await value?.close();await window.close();jobs.close();scope.setTenancyMode(previous);}
}
describe('consumer reconstruction retains configuration-owned transport', () => {
  it('routes through parsed static peers after interrupted preparation and owned-pool cleanup', () => staticReconstructionCriterion());
  it('control: omitting owned-store cleanup is red; restored source closes the aborted construction',async()=>{
    const needle='      try { await store?.close(); } catch (error) { errors.push(error); }';
    await assert.rejects(staticReconstructionCriterion(text=>{assert.equal(text.split(needle).length,2,'cleanup mutation reaches actual source');return text.replace(needle,'');}),error=>error.code==='ERR_ASSERTION'&&error.actual===0&&error.expected===1);
    await staticReconstructionCriterion();
  });
});
