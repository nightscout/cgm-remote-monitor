'use strict';

// Source/lifecycle protocols only; no services or listeners.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const runtime = require('../lib/server/serve/evaluator-runtime');
const config = require('../lib/server/serve/evaluator-config');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const identity = n => String(n).repeat(64);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const plan=require('./fixtures/multitenant-plan'),layout=plan.layout('eval_cfg'),canonical=plan.documents({layout,urls:plan.syntheticUrls(layout)});
function document () {const value=structuredClone(canonical.configs.evaluator);delete value.consumers;return value;}
const source = canonical.environments.evaluator;
function effective(values,version=1){return {...require('../lib/tenant-settings/component').resolveEffectiveSettings({version,values},{generation:1,deployment:{},overrides:{}}),policyGeneration:1};}
function metadataAccess(doc,states=new Map([[A,effective({enable:['bgnow']})],[B,effective({})]])){const active=new Set([A,B]),expected=config.parse(doc,source).tenantSettings;return {active,states,reader:{matches:value=>require('node:util').isDeepStrictEqual(value,expected),read:async tenant=>states.get(tenant)},admission:{namespace:doc.registry.namespace,allows:async tenant=>active.has(tenant)}};}

describe('evaluator preview trusted configuration', function () {
  it('hashes committed effective content and plugins even when the settings version is reused', async function () {
    const parsed=config.parse(document(),source),selected=config.registryEntry(A),defaults=require('../lib/tenant-settings/catalogue').DEFAULTS;
    const first=await config.withSettings(parsed,selected,A,{matches:()=>true,read:async()=>effective({enable:['bgnow']})});
    const thresholds=Object.fromEntries(require('../lib/tenant-settings/catalogue').THRESHOLDS.map(name=>[name,defaults[name]]));thresholds.bgHigh=300;
    const second=await config.withSettings(parsed,selected,A,{matches:()=>true,read:async()=>effective({enable:['bgnow'],thresholds})});
    assert.notEqual(first.identity,second.identity,'M5_EVAL_CONFIG_CONTENT actual committed effective content changes identity');
    const third=await config.withSettings(parsed,selected,A,{matches:()=>true,read:async()=>effective({enable:['delta'],thresholds})});assert.notEqual(third.identity,second.identity);
    const reordered={thresholds,enable:['delta']};assert.equal(config.applySettings(selected,effective(reordered)).identity,third.identity,'canonical key order preserves the same committed settings identity');
  });
  it('refuses unbounded, unknown, unsafe or misspelled configuration without authority fallback', function () {
    for (const change of [d=>{delete d.maxBytes;},d=>{d.maxRows=0;},d=>{d.timeIntervalMs=2147483648;},d=>{d.consumer='realtime-shared';},d=>{d.postgres.namespaces.entries='public';}]){const d=document();change(d);assert.throws(()=>config.parse(d,source),/explicit evaluator/);}
    const overlap=document();overlap.tenants=[{id:A,revision:'same',settings:{}}];assert.throws(()=>config.parse(overlap,source),error=>error.message===require('../lib/server/serve/registry-config').REFUSAL);
    assert.throws(()=>effective({API_SECRET:'x'}),/SETTINGS_UNSUPPORTED/);assert.throws(()=>effective({enable:['INVALID!']}),/SETTINGS_VALUE/);assert.throws(()=>config.load({}),/explicit evaluator/);
  });
  it('reads current committed settings through admitted registry metadata, refuses infrastructure drift and removed tenants', async function () {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'evaluator-config-')),file=path.join(dir,'config.json');
    try{const d=document(),access=metadataAccess(d);fs.writeFileSync(file,JSON.stringify(d));const loaded=config.loadMetadata({...source,MULTITENANT_EVALUATOR_CONFIG:file});const read=tenant=>loaded.readCurrent(tenant,access.reader,access.admission);const first=await read(A);access.states.set(A,effective({enable:['delta']},2));assert.notEqual((await read(A)).identity,first.identity);access.active.delete(A);assert.equal(await read(A),null);d.maxRows++;fs.writeFileSync(file,JSON.stringify(d));await assert.rejects(read(B),/requires restart/);}finally{fs.rmSync(dir,{recursive:true,force:true});}
  });
  it('bounds explicit metadata reads and reuses parsed infrastructure until a same-size edit is refused', async function () {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'evaluator-config-')),file=path.join(dir,'config.json'),open=fs.openSync,parse=JSON.parse;let reads=0,parses=0,contents;
    fs.openSync=function(name,...rest){if(name===file)reads++;return open.call(this,name,...rest);};JSON.parse=function(text,...rest){if(text===contents)parses++;return parse.call(this,text,...rest);};
    try{const d=document(),access=metadataAccess(d);contents=JSON.stringify(d);fs.writeFileSync(file,contents);const loaded=config.loadMetadata({...source,MULTITENANT_EVALUATOR_CONFIG:file}),read=()=>loaded.readCurrent(A,access.reader,access.admission),before=reads;const first=await read();for(let i=0;i<20;i++)await read();assert.equal(reads-before,21,'EV_CONFIG_BOUNDED_READ_EACH_EXPLICIT_CALL');assert.equal(parses,1,'EV_CONFIG_PARSED_ONCE_WHILE_UNCHANGED');access.states.set(A,effective({enable:['delta']},2));assert.notEqual((await read()).identity,first.identity,'committed settings are independent of unchanged worker infrastructure bytes');const size=fs.statSync(file).size;d.pgstream.slot=d.pgstream.slot.slice(0,-1)+(d.pgstream.slot.endsWith('x')?'y':'x');contents=JSON.stringify(d);fs.writeFileSync(file,contents);assert.equal(fs.statSync(file).size,size);await assert.rejects(read(),/requires restart/);assert.equal(parses,2,'EV_CONFIG_CHANGED_BYTES_PARSED');}finally{fs.openSync=open;JSON.parse=parse;fs.rmSync(dir,{recursive:true,force:true});}
  });
});

describe('tenant-local evaluator statistics source protocol', function () {
  it('reuses logical tenant bytes and never assigns shared index bytes or foreign growth', async function () {
    const scope = require('../lib/storage/tenant-scope');
    const createStats = require('../lib/storage/postgres-tenant-stats');
    const previous = scope.getTenancyMode(); scope.setTenancyMode('multi');
    const bytes = new Map([[A, 1000], [B, 2000]]), calls = [];
    const stats = createStats({ tables: { entries: 'scope_entries.entries' }, connection: { async query (sql) {
      const tenant = scope.requireTenant('synthetic stats port'); calls.push({ tenant, sql });
      // Independent supplied-port oracle: logical query has tenant bytes; a
      // shared physical-size query would expose both. No actual PG/RLS claim.
      return { rows: [{ bytes: /pg_column_size\(doc\)/.test(sql) ? bytes.get(tenant) : [...bytes.values()].reduce((n, v) => n + v, 0) }] };
    } } });
    try {
      const first = await scope.withTenant(A, () => stats.read(A));
      bytes.set(B, 400 * 1024 * 1024);
      const afterForeign = await scope.withTenant(A, () => stats.read(A));
      assert.deepEqual(afterForeign, first, 'M5_EVAL_TENANT_STATS foreign logical growth cannot change A');
      assert.equal(first.dataSize, 1000); assert.equal(first.indexSize, undefined);
      assert.ok((await scope.withTenant(B, () => stats.read(B))).dataSize > first.dataSize);
      const before = calls.length;
      await assert.rejects(scope.withTenant(B, () => stats.read(A)), /scope mismatch/);
      assert.equal(calls.length, before);
      await assert.rejects(stats.read(A), /no tenant bound/);
    } finally { scope.setTenancyMode(previous); }
  });
});

describe('evaluator preview readiness protocol', function () {
  it('requires exact read-only/owned-bookkeeping scope and refuses every unsafe metadata class', async function () {
    const screen = require('../lib/server/serve/evaluator-readiness').screen;
    const cfg = config.parse(document(), source);
    async function check (kind) {
      let count = 0;
      const insertion = require('../lib/storage/postgres-insertion-readiness'), metadata = insertion.metadata;
      const sizes=require('../lib/storage/clinical-storage-size-readiness'),sizeAdmission=sizes.assertReady;
      // This recorder proves evaluator scope checks; insertion physical metadata
      // is independently exercised by its own protocol/native suites.
      insertion.metadata = async () => {};sizes.assertReady=async()=>{};
      try { await screen({ async query (sql,args) {
        count++;
        if (count === 1) return { rows: [{ rolsuper: false, rolbypassrls: false, rolcreaterole: false,
          rolcreatedb: false, rolreplication: false, operator: kind === 'operator' }] };
        if (count === 2) return { rows: [{ creates: kind === 'schema', unrelated: kind === 'unrelated' }] };
        const checkpoint = args?.[0] === cfg.namespaces.checkpoint+'.tenant_consumer_checkpoint';
        if(checkpoint)assert.deepEqual(args[1],['checkpoint','projection','contract_digest',...require('../lib/pgstream/checkpoint').WORK_COLUMNS],'exact typed bookkeeping grant set');
        return { rows: [{ secured: kind !== 'rls', reads: kind !== 'select', forbidden: kind === 'insert',
          updates: !checkpoint && kind === 'update', bookkeeping: checkpoint && kind !== 'missing-owned-update', extra: kind === 'extra-update' }] };
      } }, cfg); } finally { insertion.metadata = metadata;sizes.assertReady=sizeAdmission; }
    }
    await check(null);
    for (const kind of ['operator', 'schema', 'unrelated', 'rls', 'select', 'insert', 'update', 'missing-owned-update', 'extra-update']) {
      await assert.rejects(check(kind), /unsafe evaluator/, kind);
    }
  });
});

describe('evaluator preview owned jobs and lifecycle', function () {
  async function lab (extra = {}) {
    const callbacks = [], cancelled = [], configurations = new Map([A, B].map(tenant => [tenant, { tenant, identity: identity(1) }]));
    const calls = [], instances = [];
    const create = async current => {
      let last;
      const instance = { closed: false, async evaluate () { calls.push([current.tenant, 'acquire']);
        last = { checkpoint: calls.length, properties: { configured: current.identity } }; return last; },
      async evaluateTime () { calls.push([current.tenant, 'time']);
        if (!last) throw new Error('no retained frame'); return { ...last, time: true }; },
      close () { instance.closed = true; } };
      instances.push(instance); return instance;
    };
    const timers = new Map(); let timerId = 100;
    const ctx = await runtime({ tenants: [A, B], readCurrent: async tenant => configurations.get(tenant), create,
      recoveryIntervalMs: 100, timeIntervalMs: 200, schedule (fn, ms) { callbacks.push({ fn, ms }); return callbacks.length; },
      cancel: id => cancelled.push(id), now: () => 123,
      setTimer (fn, ms) { timers.set(++timerId, { fn, ms }); return timerId; }, clearTimer: id => timers.delete(id), ...extra });
    return { ctx, calls, instances, configurations, callbacks, cancelled, timers };
  }
  it('starts both tenants with full acquisition and separates the change backstop from per-tenant time timers', async function () {
    const l = await lab();
    try {
      assert.deepEqual(l.calls, [[A, 'acquire'], [B, 'acquire']]);
      // No per-tenant poll: one backstop schedule; time-only work is a per-tenant
      // timer (a component without due-time support keeps the slow timer).
      assert.deepEqual(l.callbacks.map(c => c.ms), [100, 10000], 'EV_NO_TENANT_POLL only the backstop and the evaluation-gap watchdog are scheduled');
      assert.deepEqual([...l.timers.values()].map(t => t.ms), [200, 200], 'EV_SLOW_TIMER at + timeIntervalMs from the cycle instant');
      for (const [id, timer] of [...l.timers]) { l.timers.delete(id); timer.fn(); }
      await l.ctx.tick(A); await l.ctx.tick(B);
      assert.equal(l.calls.filter(c => c[1] === 'acquire').length, 2, 'M5_EVAL_TIME retained timer cannot acquire');
      assert.ok(l.calls.filter(c => c[1] === 'time').length >= 2);
      const recovery = l.callbacks.find(c => c.ms === 100);
      assert.ok(recovery, 'M5_EVAL_BACKSTOP independent recovery schedule installed');
      // A component without a change signature is acquired by every backstop pass.
      await l.ctx.backstop();
      assert.ok(l.calls.filter(c => c[1] === 'acquire').length > 2, 'M5_EVAL_BACKSTOP independent recovery schedule consumes acquisition');
      await l.ctx.acquire(A); await l.ctx.acquire(B);
      assert.equal(l.ctx.last(A).eligible, true);
      assert.equal(l.ctx.last(A).runtimeId, l.ctx.last(B).runtimeId);
    } finally { await l.ctx.close(); }
    assert.deepEqual(l.cancelled, [1, 2]); assert.equal(l.timers.size, 0, 'close clears every due timer');
    assert.equal(l.ctx.health().closed, true); assert.equal(l.ctx.last(A).eligible, false);
  });
  it('discards restored A retained output and reacquires without changing B', async function () {
    const l = await lab();
    try {
      const b = l.ctx.last(B), aComponent = l.instances[0];
      await l.ctx.invalidateTenant(A);
      assert.equal(l.ctx.last(A),null); assert.equal(aComponent.closed,true);
      assert.deepEqual(l.ctx.last(B),b); assert.equal(l.instances[1].closed,false);
      const before=l.calls.filter(row => row[0]===A && row[1]==='acquire').length;
      await l.ctx.tick(A); assert.equal(l.ctx.last(A).trigger,'acquisition');
      assert.equal(l.calls.filter(row => row[0]===A && row[1]==='acquire').length,before+1);
      assert.equal(l.ctx.last(A).eligible,true); assert.deepEqual(l.ctx.last(B),b);
    } finally { await l.ctx.close(); }
  });
  it('coalesces concurrent work per tenant while another tenant progresses', async function () {
    let gate, entered, active = 0, maximum = 0, calls = 0;
    const l = await lab({ create: async current => ({ async evaluate () {
      if (current.tenant === A) { active++; maximum = Math.max(maximum, active); calls++;
        if (gate) { entered.resolve(); await gate.promise; gate = null; } active--; }
      return { checkpoint: calls };
    }, async evaluateTime () { return { checkpoint: calls }; }, close () {} }) });
    try {
      gate = deferred(); entered = deferred();
      const running = l.ctx.acquire(A); await entered.promise;
      const many = Array.from({ length: 10 }, () => l.ctx.acquire(A));
      await l.ctx.acquire(B); assert.equal(l.ctx.last(B).eligible, true);
      gate.resolve(); await Promise.all([running, ...many]);
      assert.equal(maximum, 1); assert.equal(calls, 3, 'M5_EVAL_COALESCE startup + held work + one coalesced recovery');
    } finally { await l.ctx.close(); }
  });
  it('completes one request without waiting for later work and alternates pending job kinds', async function () {
    const gates = [], entered = [];
    const order = [];
    const l = await lab({ create: async current => ({ async evaluate () {
      if (current.tenant === A) {
        order.push('acquire'); const gate = gates.shift(), signal = entered.shift();
        if (gate) { signal.resolve(); await gate.promise; }
      }
      return { checkpoint: 1 };
    }, async evaluateTime () { if (current.tenant === A) order.push('time'); return { checkpoint: 1 }; }, close () {} }) });
    const one = deferred(), two = deferred(), e1 = deferred(), e2 = deferred();
    try {
      gates.push(one, two); entered.push(e1, e2);
      let completed = false; const first = l.ctx.acquire(A).then(() => { completed = true; }); await e1.promise;
      const later = l.ctx.acquire(A), time = l.ctx.tick(A);
      one.resolve(); await e2.promise; await Promise.resolve();
      assert.equal(completed, true, 'M5_EVAL_TICKET completed request does not await future pending jobs');
      assert.deepEqual(order.slice(-3), ['acquire', 'time', 'acquire'], 'M5_EVAL_FAIR recovery and retained-time jobs both progress');
      two.resolve(); await Promise.all([first, later, time]);
    } finally { one.resolve(); two.resolve(); await l.ctx.close(); }
  });
  it('drops retained context on content identity change and checks current eligibility independently', async function () {
    const l = await lab();
    try {
      const previous = l.ctx.last(A); l.configurations.set(A, { tenant: A, identity: identity(2) });
      await l.ctx.tick(A);
      assert.equal(l.instances[0].closed, true, 'M5_EVAL_CONFIG_REBUILD old effective context retired');
      assert.equal(l.ctx.last(A).trigger, 'acquisition', 'M5_EVAL_CONFIG_REBUILD cold replacement acquires before computing');
      assert.equal(l.ctx.last(A).identity, identity(2));
      assert.equal(await l.ctx.isCurrent(A, previous.identity), false);
      assert.equal(l.ctx.last(A).identity, identity(2), 'old consumer gate cannot retire current newer output');
      await l.ctx.acquire(A); assert.equal(await l.ctx.isCurrent(A, identity(2)), true);
      l.configurations.delete(A); assert.equal(await l.ctx.isCurrent(A, identity(2)), false);
      assert.equal(l.ctx.last(A), null); assert.equal(l.ctx.last(B).eligible, true);
    } finally { await l.ctx.close(); }
  });
  it('fences stale in-flight results when current configuration changes or disables the tenant', async function () {
    for (const disable of [false, true]) {
      let gate, entered;
      const l = await lab({ create: async () => ({ async evaluate () {
        if (gate) { entered.resolve(); await gate.promise; } return { checkpoint: 1 };
      }, async evaluateTime () { return { checkpoint: 1 }; }, close () {} }) });
      try {
        gate = deferred(); entered = deferred();
        const work = l.ctx.acquire(A); await entered.promise;
        if (disable) l.configurations.delete(A); else l.configurations.set(A, { tenant: A, identity: identity(2) });
        assert.equal(await l.ctx.isCurrent(A, identity(1)), false);
        gate.resolve(); await work;
        assert.equal(l.ctx.last(A), null, 'M5_EVAL_CONFIG_GENERATION stale in-flight result cannot regain eligibility');
        assert.equal(l.ctx.health().tenants.find(t => t.tenant === A).ready, false);
      } finally { if (gate) gate.resolve(); await l.ctx.close(); }
    }
  });
  it('closes a late-created obsolete component without publishing it', async function () {
    let gate, entered, obsoleteClosed = false;
    const l = await lab({ create: async current => {
      if (current.identity === identity(2)) { entered.resolve(); await gate.promise; }
      return { async evaluate () { return { checkpoint: 1 }; }, async evaluateTime () { return { checkpoint: 1 }; },
        close () { if (current.identity === identity(2)) obsoleteClosed = true; } };
    } });
    try {
      gate = deferred(); entered = deferred(); l.configurations.set(A, { tenant: A, identity: identity(2) });
      const work = l.ctx.acquire(A); await entered.promise;
      l.configurations.set(A, { tenant: A, identity: identity(3) });
      assert.equal(await l.ctx.isCurrent(A, identity(2)), false);
      gate.resolve(); await work;
      assert.equal(obsoleteClosed, true);
      assert.equal(l.ctx.last(A), null, 'M5_EVAL_CONFIG_GENERATION late create cannot recover obsolete eligibility');
      await l.ctx.acquire(A); assert.equal(l.ctx.last(A).identity, identity(3));
    } finally { if (gate) gate.resolve(); await l.ctx.close(); }
  });
  it('does not cancel a current in-flight creation when an old consumer checks eligibility', async function () {
    let gate, entered;
    const l = await lab({ create: async current => {
      if (current.identity === identity(2)) { entered.resolve(); await gate.promise; }
      return { async evaluate () { return { checkpoint: 1 }; }, async evaluateTime () { return { checkpoint: 1 }; }, close () {} };
    } });
    try {
      gate = deferred(); entered = deferred(); l.configurations.set(A, { tenant: A, identity: identity(2) });
      const work = l.ctx.acquire(A); await entered.promise;
      assert.equal(await l.ctx.isCurrent(A, identity(1)), false);
      gate.resolve(); await work;
      assert.equal(l.ctx.last(A).identity, identity(2));
      assert.equal(l.ctx.last(A).eligible, true);
    } finally { if (gate) gate.resolve(); await l.ctx.close(); }
  });
  it('retains last successful output on acquisition refusal while B continues and retries unchanged input', async function () {
    let refuse = false;
    const l = await lab({ create: async current => ({ async evaluate () {
      if (current.tenant === A && refuse) throw new Error('REPLAY_SNAPSHOT_ROW_BOUND');
      return { checkpoint: 1 };
    }, async evaluateTime () { return { checkpoint: 1 }; }, close () {} }) });
    try {
      const first = l.ctx.last(A); refuse = true; await l.ctx.acquire(A); await l.ctx.acquire(B);
      assert.equal(l.ctx.last(A).outputRevision, first.outputRevision);
      assert.equal(l.ctx.last(A).eligible, false); assert.equal(l.ctx.last(B).eligible, true);
      const cycles = () => l.ctx.health().tenants.find(row => row.tenant === A).cycles, attempted = cycles();
      refuse = false; await l.ctx.acquire(A); assert.equal(l.ctx.last(A).eligible, true);
      assert.ok(cycles() > attempted, 'the unchanged input was acquired again');
      assert.equal(l.ctx.last(A).outputRevision, first.outputRevision, 'identical content keeps its revision');
    } finally { await l.ctx.close(); }
  });
  it('fences late computation and drains running jobs before close resolves', async function () {
    let gate, entered;
    const l = await lab({ create: async () => ({ async evaluate () {
      if (gate) { entered.resolve(); await gate.promise; } return { checkpoint: 1 };
    }, async evaluateTime () { return { checkpoint: 1 }; }, close () {} }) });
    const old = l.ctx.last(A); gate = deferred(); entered = deferred();
    const work = l.ctx.acquire(A); await entered.promise;
    let stopped = false; const closing = l.ctx.close().then(() => { stopped = true; });
    await Promise.resolve(); assert.equal(stopped, false);
    gate.resolve(); await Promise.all([work, closing]);
    assert.equal(l.ctx.last(A).outputRevision, old.outputRevision, 'M5_EVAL_CLOSE_FENCE no late successful result');
    await assert.rejects(l.ctx.acquire(A), /closed/);
  });
  it('boots a selected evaluator context even though listener resolution returns none', async function () {
    const serve = require('../lib/server/serve'), role = require('../lib/server/serve/evaluator-preview');
    const original = role.boot; let boots = 0, closes = 0;
    role.boot = async () => { boots++; return { close: async () => { closes++; } }; };
    try {
      const run = await serve.start(['evaluator'], { PORT: 1337, HOSTNAME: '127.0.0.1' }, null, {}, { evaluatorPreview: {} });
      assert.equal(boots, 1, 'M5_EVAL_LISTENERLESS_BOOT selected role must boot');
      assert.equal(run.servers.length, 0); assert.ok(run.contexts.evaluator);
      await run.stop(); await run.stop(); assert.equal(closes, 1);
    } finally { role.boot = original; }
  });
});

describe('serve boot with retained durable overdue work', function () {
  it('acquires cold projection input before overdue TIME, coalesces direct input, and reuses warm retained input', async function () {
    const scope=require('../lib/storage/tenant-scope'),window=require('./fixtures/operation-window-runtime-protocol')({trustedWorker:true});
    const jobs=require('../lib/server/serve/evaluator-job-context').create('clinical');
    const projection=require('../lib/data/tenant-projection-evaluator');
    const env=require('../lib/server/tenant-app/environment')({settings:{enable:['bgnow']}}),language=require('../lib/language')();
    const at=Date.UTC(2026,10,14,12),gate=deferred(),started=deferred();
    const acquisitions=new Map([[A,0],[B,0]]),completions=[];let revision=1,epoch=1;
    await window.window.ready();
    const service=await runtime({tenants:[A,B],operationWindow:window.window,jobContext:jobs,boot:'serve',bootConcurrency:1,
      workerState:()=>({available:true,generation:epoch}),externalRecovery:true,
      readCurrent:async tenant=>({tenant,identity:identity(revision)}),now:()=>at,
      create:async current=>projection({tenant:current.tenant,env,language,maxRows:10,maxBytes:100000,includeFrame:true,
        connection:{query:async()=>{throw new Error('UNEXPECTED_CLINICAL_SQL');}},dbstats:async()=>({dataSize:0,indexSize:0}),
        replay:{async reconcile(){acquisitions.set(current.tenant,acquisitions.get(current.tenant)+1);if(current.tenant===A){started.resolve();await gate.promise;}return {checkpoint:7,progress:'retained-db',signature:{stamp:7,deleted:0},rows:[]};}}}),
      durable:{begin:async()=>({clock:'7'}),complete:async(tenant,value)=>{completions.push({tenant,...value});return {changed:false,output:{tenant,identity:value.identity,outputRevision:9,contentDigest:'same',inputCheckpoint:7,result:value.result}};}},
      recoveryIntervalMs:1000,timeIntervalMs:60000,schedule:()=>1,cancel(){},setTimer:()=>1,clearTimer(){}});
    const previous=scope.getTenancyMode();scope.setTenancyMode('multi');let startup;
    try {
      // The shared scheduler starts A; the runtime has no independent boot queue.
      startup=service.acquire(A);await started.promise;
      // The shipped workDrain dispatches overdue rows with pendingAt=null as
      // tick(), while the retained-state serve boot is still acquiring A.
      await service.tick(B);
      let row=service.health([B]).tenants[0];
      assert.equal(row.progress.failedCompletions,0,'COLD_DUE_MUST_ACQUIRE_RETAINED_INPUT');
      assert.equal(row.progress.completedAcquisitions,1);assert.equal(row.progress.completedTimeCycles,0);
      assert.equal(acquisitions.get(B),1);assert.equal(completions.at(-1).result.trigger,'acquisition');
      await service.tick(B);row=service.health([B]).tenants[0];
      assert.equal(row.progress.completedTimeCycles,1);assert.equal(acquisitions.get(B),1,'WARM_TIME_MUST_REUSE_INPUT');
      gate.resolve();for(let i=0;i<20&&service.health().tenants.some(x=>x.jobs.booting);i++)await new Promise(resolve=>setImmediate(resolve));
      assert.equal(acquisitions.get(B),1,'BOOT_MUST_REUSE_ALREADY_ACQUIRED_COLD_WORK');
      await service.invalidateTenant(B);
      await Promise.all([service.tick(B),service.acquire(B)]);
      assert.equal(acquisitions.get(B),2,'COLD_DUE_AND_DIRECT_INPUT_SHARE_ACQUISITION');
      assert.equal(service.health([B]).tenants[0].progress.failedCompletions,0);
      revision=2;await service.tick(B);
      assert.equal(acquisitions.get(B),3,'CONFIG_REPLACEMENT_MUST_ACQUIRE_NEW_COMPONENT');
      assert.equal(completions.at(-1).result.trigger,'acquisition');
      const generation=service.health([B]).tenants[0].progress.generation;
      epoch=2;await service.tick(B);
      assert.equal(acquisitions.get(B),4,'NEW_EPOCH_MUST_ACQUIRE_CURRENT_INPUT');
      assert.equal(service.health([B]).tenants[0].progress.generation,generation);
      assert.equal(service.health([B]).tenants[0].progress.failedCompletions,0);
    }finally{gate.resolve();await startup;await service.close();await window.window.close();scope.setTenancyMode(previous);}
  });
});
