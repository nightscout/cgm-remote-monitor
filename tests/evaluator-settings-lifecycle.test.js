'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const scope = require('../lib/storage/tenant-scope');
const evaluator = require('../lib/server/serve/evaluator-config');
const A = '00000000-0000-0000-0000-000000000001', B = '00000000-0000-0000-0000-000000000002';
const baseConfiguration = { connectionString: 'postgres://synthetic:synthetic@127.0.0.1/synthetic_test', namespaces: { settings: 'synthetic_settings', operatorPolicy: 'synthetic_policy' } };
function isolated (file, mocks, mutate = source => source) {
  const filename = path.resolve(__dirname, '../lib/' + file), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = loaded.require.bind(loaded);
  loaded.require = name => Object.hasOwn(mocks, name) ? mocks[name] : original(name);
  loaded._compile(mutate(fs.readFileSync(filename, 'utf8')), filename); return loaded.exports;
}
// Admission and retirement tests gate on the value read: the screen runs only
// when the capability opens and when its owner calls check().
function fixture ({ skipCheck = false, skipDrain = false, unbounded = false, overlap = false, unsafeReplacement = false, data = false } = {}) {
  const configuration = { ...baseConfiguration };
  const calls = { factory: 0, readiness: 0, catalogue: 0, pool: 0, screen: 0, read: 0, close: 0 };
  const state = { unsafe: false, readinessFails: false, catalogueFails: false, queryFails: false };
  const rows = new Map([[A, { version: 1, values: { SHOW_SECONDS: true }, generation: 1, policy: { deployment: {}, overrides: {} } }],
    [B, { version: 1, values: { SHOW_SECONDS: false }, generation: 1, policy: { deployment: {}, overrides: {} } }]]);
  const factory = isolated('tenant-settings/effective-postgres.js', {
    './readiness-check': async () => { calls.readiness++; if (state.readinessFails) throw Error('synthetic readiness'); },
    '../migrations/postgres-check': { ...require('../lib/migrations/postgres-check'), inspect: async () => { calls.catalogue++; if (state.catalogueFails) throw Error('synthetic catalogue'); return { current: true }; } },
    '../storage/postgres-connection': async () => { calls.pool++; return {
      readOnly (sql, args) { assert.equal(scope.currentTenant(), undefined, 'the screen runs outside any tenant'); return this.query(sql, args); },
      readOnlySnapshot (tenant, fn) { return scope.withTenant(tenant, () => fn({ query: this.query.bind(this) })); },
      async query (sql, args) {
        if (sql.includes('pg_class')) { calls.screen++; return { rows: [0, 1].map(() => ({ secured: !state.unsafe, owns: false, reads: true, writes: false })) }; }
        if (state.beforeRead) await state.beforeRead(args[0]);
        calls.read++; assert.equal(scope.currentTenant(), args[0]);
        if (state.queryFails) throw Error('synthetic query');
        return { rows: rows.has(args[0]) ? [structuredClone(rows.get(args[0]))] : [] };
      }, async end () { calls.close++; if (state.beforeClose) await state.beforeClose(); }
    }; }
  }, source => skipCheck ? source.replace('    check,\n', '    check: async () => {},\n') : source);
  const open = async options => { calls.factory++; return factory(options); };
  const presentation = isolated('tenant-settings/presentation-reader.js', { './effective-postgres': open }, source => {
    if (unsafeReplacement) source = source.replaceAll('if (revalidate && cleanupErrors.length) throw unavailable();', '');
    if (overlap) source = source.replace('if (revalidate && retiring.size)', 'if (false && retiring.size)');
    if (unbounded) source = source.replace('revalidate ? admittedRead(tenant) : read(tenant)', 'read(tenant)');
    if (skipDrain) source = source.replace('await Promise.allSettled([...reads]);', '');
    return source;
  });
  const reader = { ...presentation(configuration, data ? {} : { revalidate: true, preserveErrors: true, concurrency: 4, maxPending: 2 }), matches: current => require('node:util').isDeepStrictEqual(current, configuration) };
  const finite = isolated('server/serve/evaluator-config.js', { '../../tenant-settings/effective-postgres': open });
  return { calls, state, rows, reader, configuration, async readFinite (tenant) { return finite.withSettings({ tenantSettings: configuration }, finite.registryEntry(tenant), tenant); }, async read (tenant) { return evaluator.withSettings({ tenantSettings: configuration }, evaluator.registryEntry(tenant), tenant, reader); } };
}

describe('evaluator retained settings capability', function () {
  let previous;
  beforeEach(() => { previous = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(previous));
  it('reuses one max4 pool, screening once at open and reading fresh owner and policy state for each tenant', async function () {
    const f = fixture();
    try {
      const first = await f.read(A); assert.equal(first.env.settings.units, 'mg/dl'); assert.equal(first.env.settings.showSeconds, true);
      f.rows.get(A).version++; f.rows.get(A).values.SHOW_SECONDS = false;
      const owner = await f.read(A); assert.notEqual(owner.identity, first.identity); assert.equal(owner.env.settings.showSeconds, false);
      f.rows.get(A).generation++; f.rows.get(A).policy.overrides.DISPLAY_UNITS = { mode: 'pinned', pin: 'mmol' };
      assert.equal((await f.read(A)).env.settings.units, 'mmol');
      assert.equal((await f.read(B)).env.settings.units, 'mg/dl');
      assert.deepEqual(f.calls, { factory: 1, readiness: 1, catalogue: 2, pool: 1, screen: 1, read: 4, close: 0 });
    } finally { await f.reader.close(); }
    assert.equal(f.calls.close, 1); await f.reader.close(); await assert.rejects(f.read(A), { code: 'SETTINGS_POLICY_UNAVAILABLE' }); assert.equal(f.calls.pool, 1);
  });
  it('makes the prior finite lifecycle red on pool construction count; the retained pool screens once at open', async function () {
    for (const finite of [true, false]) {
      const f = fixture(), screens = finite ? 3 : 1; try {
        for (const tenant of [A, B, A]) await (finite ? f.readFinite(tenant) : f.read(tenant));
        assert.equal(f.calls.readiness, screens); assert.equal(f.calls.catalogue, 2 * screens); assert.equal(f.calls.screen, screens); assert.equal(f.calls.read, 3);
        if (finite) { assert.equal(f.calls.pool, 3); assert.throws(() => assert.equal(f.calls.pool, 1), { code: 'ERR_ASSERTION' }); }
        else assert.equal(f.calls.pool, 1);
      } finally { await f.reader.close(); }
      assert.equal(f.calls.close, finite ? 3 : 1);
    }
  });
  it('refuses an unsafe-object, readiness or catalogue failure at check() and reopen, and a transport failure at read; recovers with a new capability', async function () {
    for (const [key, pattern] of [['unsafe', /SETTINGS_STORE_UNSAFE/], ['readinessFails', /synthetic readiness/], ['catalogueFails', /synthetic catalogue/], ['queryFails', /synthetic query/]]) {
      const f = fixture(); try {
        await f.read(A); assert.equal(f.reader.health().ready, true); f.state[key] = true;
        if (key === 'queryFails') await assert.rejects(f.read(A), pattern);
        else {
          const reads = f.calls.read;
          await f.read(A); assert.equal(f.calls.read, reads + 1, 'a read does not screen');
          await assert.rejects(f.reader.check(), pattern);
          // The reopen after an eviction is the recovery screen; it refuses too.
          await assert.rejects(f.read(A), pattern); assert.equal(f.calls.read, reads + 1, 'no value read while refused');
        }
        // check() retires the held pool; a refused reopen closes its own pool too.
        const transport = key === 'queryFails';
        assert.equal(f.calls.close, transport ? 1 : 2); assert.equal(f.reader.health().ready, false); assert.equal(f.reader.health().state, 'unavailable');
        f.state[key] = false; await f.read(B); assert.equal(f.calls.pool, transport ? 2 : 3); assert.equal(f.reader.health().ready, true);
        assert.equal(f.calls.readiness, transport ? 2 : 4, 'only open, check() and the reopen after an eviction screen');
      } finally { await f.reader.close(); }
    }
  });
  it('a missing tenant row neither evicts nor reopens the capability', async function () {
    const f = fixture(); try {
      await f.read(A); f.rows.delete(A);
      for (let i = 0; i < 3; i++) await assert.rejects(f.read(A), { code: 'SETTINGS_POLICY_UNAVAILABLE' });
      await f.read(B);
      assert.deepEqual([f.calls.pool, f.calls.close, f.calls.readiness], [1, 0, 1]); assert.equal(f.reader.health().ready, true);
    } finally { await f.reader.close(); }
  });
  it('requires restart when the resolved hotfile credential or namespace binding changes', async function () {
    const f = fixture(); try {
      await f.read(A);
      for (const changed of [{ ...f.configuration, connectionString: 'synthetic-rotated' }, { ...f.configuration, namespaces: { settings: 'other', operatorPolicy: 'synthetic_policy' } }]) {
        await assert.rejects(evaluator.withSettings({ tenantSettings: changed }, evaluator.registryEntry(A), A, f.reader), /require restart/);
      }
      assert.equal(f.calls.read, 1);
    } finally { await f.reader.close(); }
  });
  it('detects a removed health check against the changed authority guard and restores green', async function () {
    async function observe (skipCheck) {
      const f = fixture({ skipCheck }); try { await f.read(A); f.state.unsafe = true; await assert.rejects(f.reader.check(), /SETTINGS_STORE_UNSAFE/); assert.equal(f.reader.health().ready, false); } finally { await f.reader.close(); }
    }
    await assert.rejects(observe(true), { code: 'ERR_ASSERTION' }); await observe(false);
  });
  it('drains in-flight revalidation before close, and removing the drain is red', async function () {
    async function observe (skipDrain) {
      const f = fixture({ skipDrain }); await f.read(A); let release;
      const held = new Promise(resolve => { release = resolve; }); f.state.beforeRead = () => held;
      const reading = assert.rejects(f.read(A), { code: 'SETTINGS_POLICY_UNAVAILABLE' });
      await new Promise(resolve => setImmediate(resolve));
      let stopped = false; const closing = f.reader.close().then(() => { stopped = true; });
      await new Promise(resolve => setImmediate(resolve)); const premature = stopped;
      release(); await reading; await closing; assert.equal(f.calls.close, 1);
      return premature;
    }
    assert.equal(await observe(true), true, 'mutant returns before its in-flight read drains');
    assert.equal(await observe(false), false, 'restored shutdown waits');
  });
});

describe('evaluator settings ownership at maintained role boot', function () {
  async function exercise(outcome,{staleCache=false}={}){
    const plan=require('./fixtures/multitenant-plan'),layout=plan.layout('settings_boot'),docs=plan.documents({layout,urls:plan.syntheticUrls(layout)}),document=structuredClone(docs.configs.evaluator);delete document.consumers;
    const config=evaluator.parse(document,docs.environments.evaluator),calls={settingsClose:0,clinicalClose:0,settingsRead:0,runtimeClose:0},closed=[];let prepared,active=true;
    const rows=new Map([[A,{version:1,values:{SHOW_SECONDS:true},generation:1,policy:{deployment:{},overrides:{}}}],[B,{version:1,values:{SHOW_SECONDS:false},generation:1,policy:{deployment:{},overrides:{}}}]]);
    const connection={async readOnly(sql,args){
      if(sql.includes('FROM pg_class'))return {rows:[0,1,2,3].map(()=>({secured:true,owns:false,writes:false}))};
      if(sql.includes('WHERE false'))return {rows:[]};
      if(sql.includes('activity_version'))return {rows:args[0].map(tenant=>({tenant,activity_version:'1',paused:false,suspended:false,settings:rows.get(tenant).version,policy:rows.get(tenant).generation,stamp:'1',deleted:'0'}))};
      assert(sql.includes('SELECT s.version'),'only the selected trusted settings projection may read settings');calls.settingsRead++;return {rows:[structuredClone(rows.get(args[0]))]};
    },async end(){calls.clinicalClose++;closed.push('clinical');}};
    const trusted=isolated('trusted-worker/postgres.js',{},source=>{if(!staleCache)return source;const check='hit.settings === row.settings && hit.policy === row.policy',retire='settingsCache.delete(row.tenant);';assert(source.includes(check)&&source.includes(retire));return source.replace(check,'true').replace(retire,'void 0;');});
    const runtime={acquire:async()=>{},tick:async()=>{},health:()=>({tenants:[]}),last:()=>null,isCurrent:async()=>true,close:async()=>{calls.runtimeClose++;if(outcome==='both-close-fail')throw Error('synthetic runtime close failure');}};
    const boot=isolated('server/serve/evaluator-preview.js',{
      '../../tenant-settings/presentation-reader':()=>{throw Error('retired product settings reader must not be constructed');},
      '../../storage/postgres-durable-replay':()=>({invalidateStream:async()=>{},acceptClinical:async()=>{throw Error('CLINICAL_INPUT_OUTSIDE_SETTINGS_FIXTURE');}}),
      '../../storage/postgres-connection':Object.assign(async()=>connection,{readopt:async()=>{}}),
      './evaluator-readiness':Object.assign(async()=>{}, {provisionTenant:async()=>{}}),
      './evaluator-consumers':{prepare:async()=>null},
      './registry-tenant-set':{open:async()=>({tenants:new Map([[A,evaluator.registryEntry(A)],[B,evaluator.registryEntry(B)]]),isActive:tenant=>tenant===B||active,revision:()=>1,stats:()=>({}),close:async()=>{},follow:async handlers=>{prepared=handlers;}})},
      '../../trusted-worker/postgres':{create:options=>{const reader=trusted.create(options);return {...reader,async close(){calls.settingsClose++;await reader.close();closed.push('settings');if(outcome.includes('close-fail'))throw Error('synthetic close failure');}};}},
      // Stream recovery owns the first metadata snapshot; emulate its real
      // ready callback instead of relying on the removed duplicate boot scan.
      '../../pgstream/evaluator':{open:async options=>{const store={observeMany:async()=>{},work:async()=>[],nextDue:async()=>null,deliveries:async()=>[]};return {store,ready:()=>options.onRecovered(store),assertAvailable(){},health:()=>({}),close:async()=>{}};}},
      '../internal-api/clients':{completedOutput:()=>({hintCompletedOutput:async()=>{}})},
      '../../migrations/postgres':{run:async()=>{}},
      './tenant-startup':{create:()=>({warm:async()=>{},isReady:()=>true,close:async()=>{},health:()=>({})})},
      './evaluator-runtime':async options=>{
        const first=await options.readCurrent(A),other=await options.readCurrent(B);assert.equal(first.env.settings.units,'mg/dl');assert.equal(first.env.settings.showSeconds,true);assert.equal(other.env.settings.showSeconds,false);assert.equal(calls.settingsRead,2);
        active=false;assert.equal(await options.readCurrent(A),null);assert.equal(calls.settingsRead,2,'registry withdrawal precedes settings access');active=true;assert.equal((await options.readCurrent(A)).identity,first.identity);assert.equal(calls.settingsRead,2,'unchanged streamed settings reuse the trusted cache');
        rows.get(A).version++;rows.get(A).values.SHOW_SECONDS=false;await options.readMetadata([A]);const changed=await options.readCurrent(A);assert.notEqual(changed.identity,first.identity,'CURRENT_SETTINGS_VERSION_MUST_REFRESH');assert.equal(changed.env.settings.showSeconds,false);
        rows.get(A).generation++;rows.get(A).policy.overrides.DISPLAY_UNITS={mode:'pinned',pin:'mmol'};await options.readMetadata([A]);assert.equal((await options.readCurrent(A)).env.settings.units,'mmol');assert.equal((await options.readCurrent(B)).identity,other.identity,'A owner/policy changes must not invalidate or alter B');assert.equal(calls.settingsRead,4);
        if(outcome==='startup-failure')throw Error('synthetic startup');return runtime;
      }
    });
    const window=require('./fixtures/operation-window-runtime-protocol')({trustedWorker:true}).window;await window.ready();let role;
    try{
      if(outcome==='startup-failure')await assert.rejects(boot.boot(config,{operationWindow:window}),/initialization refused/);
      else{role=await boot.boot(config,{operationWindow:window});assert.equal(typeof prepared.prepare,'function');if(outcome.includes('close-fail')){await assert.rejects(role.close(),error=>error.errors.length===(outcome==='both-close-fail'?2:1)&&error.errors.some(cause=>/synthetic close failure/.test(cause.message)));await assert.rejects(role.close(),/shutdown refused/);}else{await role.close();await role.close();}}
      assert.equal(calls.settingsClose,1);assert.equal(calls.clinicalClose,1);assert.equal(calls.runtimeClose,outcome==='startup-failure'?0:1);assert(closed.indexOf('settings')<closed.indexOf('clinical'),'owned settings capability must close before clinical connection teardown');
    }finally{await role?.close().catch(()=>{});await window.close();}
  }
  it('uses trusted registry scans and retains startup failure, idempotent close and independent cleanup failures',async()=>{const previous=scope.getTenancyMode();try{for(const outcome of ['normal','startup-failure','close-failure','both-close-fail'])await exercise(outcome);}finally{scope.setTenancyMode(previous);}});
  it('control: retaining an obsolete trusted settings cache across changed version is red, then current scanning restores it',async()=>{const previous=scope.getTenancyMode();try{await assert.rejects(exercise('normal',{staleCache:true}),/initialization refused/);await exercise('normal');}finally{scope.setTenancyMode(previous);}});
});

function deferred () { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const turn = () => new Promise(resolve => setImmediate(resolve));
describe('bounded evaluator settings admission', function () {
  let previous;
  beforeEach(() => { previous = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(previous));
  it('bounds the whole refresh/read, refuses overflow and admits FIFO with fresh A/B settings and original job/tenant scope', async function () {
    const { AsyncLocalStorage } = require('node:async_hooks'), jobs = new AsyncLocalStorage();
    const f = fixture(), reading = [], gates = Array.from({ length: 8 }, () => deferred());
    const promises = [];
    try {
      await f.read(A);
      f.state.beforeRead = async tenant => { const job = jobs.getStore(); assert.equal(tenant, job.tenant); assert.equal(scope.currentTenant(), tenant); reading.push(job.id); await gates[job.id].promise; };
      function submit (id) { const tenant = id % 2 ? B : A; return scope.withTenant(tenant, () => jobs.run({ id, tenant }, () => f.read(tenant))); }
      for (let id = 0; id < 6; id++) promises.push(submit(id));
      await turn(); assert.deepEqual(reading, [0, 1, 2, 3]);
      await assert.rejects(submit(6), { code: 'SETTINGS_POLICY_UNAVAILABLE' }); assert.equal(f.calls.close, 0, 'overflow does not retire current pool');
      gates[0].resolve(); await promises[0]; await turn(); assert.deepEqual(reading, [0, 1, 2, 3, 4], 'a completed SQL read releases one admission');
      promises.push(submit(7));
      f.rows.get(B).version++; f.rows.get(B).values.SHOW_SECONDS = true;
      for (const gate of gates) gate.resolve();
      const values = await Promise.all(promises); assert.equal(values.at(-1).env.settings.showSeconds, true);
      assert.deepEqual(reading, [0, 1, 2, 3, 4, 5, 7]); assert.equal(f.calls.pool, 1);
    } finally { for (const gate of gates) gate.resolve(); await Promise.allSettled(promises); await f.reader.close(); }
  });
  it('the old unbounded path is red on concurrent direct read overlap and restoration is bounded', async function () {
    async function peak (unbounded) {
      const f = fixture({ unbounded }), gate = deferred(); let active = 0, peak = 0;
      await f.read(A); f.state.beforeRead = async () => { active++; peak = Math.max(peak, active); await gate.promise; active--; };
      const calls = Array.from({ length: 6 }, (_, index) => f.read(index % 2 ? B : A));
      await turn(); gate.resolve(); await Promise.all(calls); await f.reader.close(); return peak;
    }
    const old = await peak(true); assert.equal(old, 6); assert.throws(() => assert.ok(old <= 4), { code: 'ERR_ASSERTION' });
    assert.equal(await peak(false), 4);
  });
  it('close cancels queued work, drains active reads and prevents reopening', async function () {
    const f = fixture(), gate = deferred(); await f.read(A);
    f.state.beforeRead = () => gate.promise;
    let refused = 0;
    const calls = Array.from({ length: 6 }, (_, index) => assert.rejects(f.read(index % 2 ? B : A), { code: 'SETTINGS_POLICY_UNAVAILABLE' }).then(() => { refused++; }));
    await turn(); let stopped = false; const closing = f.reader.close().then(() => { stopped = true; });
    await turn(); assert.equal(refused, 2, 'only queued operations cancelled immediately'); assert.equal(stopped, false);
    gate.resolve(); await Promise.all(calls); await closing;
    assert.equal(f.calls.close, 1); assert.equal(f.calls.pool, 1); assert.equal(f.calls.read, 5, 'only the drained active reads; none after close');
    await assert.rejects(f.read(A), { code: 'SETTINGS_POLICY_UNAVAILABLE' }); assert.equal(f.calls.pool, 1);
  });
  it('does not construct a replacement until failed pool retirement drains concurrent read; missing barrier is red', async function () {
    const { AsyncLocalStorage } = require('node:async_hooks'), jobs = new AsyncLocalStorage();
    async function observe (overlap) {
      const f = fixture({ overlap }), readGate = deferred(), closeGate = deferred(); await f.read(A);
      f.state.beforeRead = async () => { if (jobs.getStore() === 'failure') throw Error('synthetic concurrent failure'); if (jobs.getStore() === 'held') await readGate.promise; };
      f.state.beforeClose = () => closeGate.promise;
      const held = jobs.run('held', () => f.read(A)); await turn();
      const failed = assert.rejects(jobs.run('failure', () => f.read(B)), /synthetic concurrent failure/); await turn();
      const replacement = jobs.run('replacement', () => f.read(B)); await turn(); const poolsBeforeDrain = f.calls.pool;
      readGate.resolve(); await held; closeGate.resolve(); await failed; await replacement; await f.reader.close();
      return poolsBeforeDrain;
    }
    assert.equal(await observe(true), 2, 'mutant overlaps replacement with draining old pool');
    assert.equal(await observe(false), 1, 'restoration waits for retirement before new constructor');
  });
  it('a failed retirement permanently refuses evaluator replacement; removing the guard is red', async function () {
    async function observe (unsafeReplacement) {
      const f = fixture({ unsafeReplacement }); await f.read(A);
      f.state.beforeRead = async () => { throw Error('synthetic dependency'); };
      f.state.beforeClose = async () => { throw Error('synthetic unconfirmed close'); };
      await assert.rejects(f.read(B), error => error.code === 'POSTGRES_CLEANUP_UNCONFIRMED' && /synthetic dependency/.test(error.cause.message) && /synthetic unconfirmed close/.test(error.cleanupError.message));
      f.state.beforeRead = undefined; f.state.beforeClose = undefined;
      if (unsafeReplacement) await f.read(B);
      else await assert.rejects(f.read(B), { code: 'SETTINGS_POLICY_UNAVAILABLE' });
      const constructors = f.calls.pool; await assert.rejects(f.reader.close(), /shutdown failed/); return constructors;
    }
    assert.equal(await observe(true), 2); assert.equal(await observe(false), 1);
  });
  it('leaves DATA default concurrency unchanged', async function () {
    const f = fixture({ data: true }), gate = deferred(); let active = 0, peak = 0; await f.read(A);
    f.state.beforeRead = async () => { active++; peak = Math.max(peak, active); await gate.promise; active--; };
    const reads = Array.from({ length: 7 }, (_, index) => f.read(index % 2 ? B : A));
    await turn(); assert.equal(peak, 7); gate.resolve(); await Promise.all(reads); await f.reader.close();
  });

});
