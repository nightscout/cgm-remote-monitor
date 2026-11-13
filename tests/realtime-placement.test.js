'use strict';
const assert = require('node:assert/strict');
const { A, B, I, placement, config, parse, move } = require('./fixtures/realtime-placement-map');
describe('registry placement subset selection', function () {
  it('SHARD_ROSTER: warms only assigned tenants, changes subset without a data/registry write, and leaves unchanged polling constant', async function () {
    const C = '33333333-3333-4333-8333-333333333333';
    let revision = '1', selected = new Set([A]), generation = 1, enumerations = 0, predicates = 0;
    const ids = [A, B], built = [], activated = [], removed = [];
    const registry = require('../lib/server/serve/registry-tenant-set').create({
      store: { revision: async () => revision, enumerate: async () => { enumerations++; return { revision, tenants: [...ids] }; },
        page: async (after, limit) => ({ tenants: ids.filter(id => after === null || id > after).slice(0, limit) }) },
      first: { revision, tenants: [...ids] }, settings: { namespace: 'synthetic_registry', refreshMs: 100 }, maxTenants: 10,
      build: tenant => { built.push(tenant); return { tenant }; }, accept: tenant => { predicates++; return selected.has(tenant); },
      selectionKey: () => generation, schedule: () => null, cancel () {}, alert () {} });
    try {
      assert.deepEqual(built, [A], 'SHARD_ROSTER unowned B has no initial build');
      await registry.follow({ prepare: async () => () => {}, activate: tenant => activated.push(tenant), remove: async tenant => removed.push(tenant) });
      const before = { enumerations, predicates };
      await registry.poll(); await registry.poll();
      assert.deepEqual({ enumerations, predicates }, before, 'SHARD_ROSTER unchanged ticks do not expand/select roster');
      selected = new Set([B]); generation++;
      await registry.poll(); await registry.drained();
      assert.equal(registry.isActive(A), false); assert.equal(registry.isActive(B), true);
      assert.deepEqual(activated, [B]); assert.deepEqual(removed, [A]); assert.equal(enumerations, before.enumerations, 'placement-only revision reuses bounded known roster');
      ids.push(C); revision = '2'; await registry.poll(); await registry.drained();
      assert.equal(registry.isActive(C), false); assert.ok(!built.includes(C), 'SHARD_ROSTER unowned live-add never builds');
    } finally { await registry.close(); }
  });
});

describe('alarm routing across controlled placement', function () {
  it('SHARD_ALARM: same epoch routes to current owner, stale routing refuses before effect, and uncertainty retains request/attempt without transparent retry', async function () {
    const alarms = require('../lib/server/realtime/alarm-transport'), token = Symbol('transport');
    let map = parse(config()), effects = 0;
    const reader = placement.create({ read: () => map, self: { worker: 'a', incarnation: I } });
    const sink = alarms.operations({ token, placement: reader, deliver: async () => { effects++; } });
    const routes = [], bodies = []; let lost = false;
    const adapter = alarms.createPlacementAdapter({ placement: reader, clientFor: endpoint => ({ deliverAlarm: async body => {
      routes.push(endpoint); bodies.push(body);
      if (lost) throw new Error('response lost');
      return sink.deliverAlarm({ transport: token }, body);
    } }) });
    const input = { tenant: A, id: B, attempt: 3, notification: { title: 'synthetic' }, receipts: [] };
    const send = () => new Promise((resolve, reject) => adapter.send(input, (error, value) => error ? reject(error) : resolve(value)));
    assert.deepEqual(await send(), { accepted: true, receipt: null, clearedRequestIds: [] }); assert.equal(effects, 1);
    const old = structuredClone(bodies[0]);
    map = parse(move(config(), 'b'));
    await assert.rejects(sink.deliverAlarm({ transport: token }, old), { code: 'REALTIME_PLACEMENT_WRONG_OWNER' }); assert.equal(effects, 1);
    lost = true; await assert.rejects(send(), /REALTIME_HANDOFF_UNAVAILABLE/);
    assert.equal(bodies.length, 2, 'SHARD_ALARM no transparent retry on uncertainty');
    assert.equal(bodies[1].id, input.id); assert.equal(bodies[1].attempt, input.attempt); assert.deepEqual(bodies[1].notification, input.notification);
    assert.equal(routes[1].socketPath, '/tmp/shard-b.sock'); assert.equal(bodies[1].placement.generation, 2);
  });
});

describe('quiet target startup admission', function () {
  it('SHARD_PAUSED_WARM: skips protected initialization for paused/suspended targets, inspects idle state and returns to eligible without a fake successful warm', async function () {
    const initialized = [], alerts = [], eligible = new Set([B]); let at = 0;
    const startup = require('../lib/server/serve/tenant-startup').create([A, B], undefined, async tenant => initialized.push(tenant),
      { readiness: 'all', eligible: async tenant => eligible.has(tenant), now: () => at, coldAlertMs: 100, alert: (...args) => alerts.push(args) });
    try {
      assert.deepEqual(await startup.warm(), [false, true]); assert.deepEqual(initialized, [B], 'SHARD_PAUSED_WARM no paused initialization');
      assert.equal(startup.isReady(A), false); assert.equal(startup.health().deferred, 1); assert.equal(startup.isReady(B), true);
      at = 1000; await new Promise(resolve => setTimeout(resolve, 300)); assert.deepEqual(alerts, []);
      eligible.add(A); await startup.ensure(A); assert.equal(startup.isReady(A), true); assert.deepEqual(initialized, [B, A]);
    } finally { startup.close(); }
  });
  it('SHARD_DEFER_BRAND: application errors with a matching code still fail initialization', async function () {
    const startup = require('../lib/server/serve/tenant-startup').create([A], undefined,
      async () => { throw Object.assign(new Error('synthetic application failure'), { code: 'TENANT_ACTIVITY_DEFERRED' }); }, { eligible: async () => true });
    try { await assert.rejects(startup.warm(), /synthetic application failure/); } finally { startup.close(); }
  });
});

describe('sharded alarm envelope bound', function () {
  it('reserves the maximum placement tuple only for the selected sharded transport', function () {
    const metadata = require('../lib/server/serve/evaluator-consumer-config').metadata;
    const value = { realtime: { outbox: { connectionEnv: 'OUTBOX', namespace: 'synthetic_outbox', maxRows: 1, maxBytes: 10000, maxConnections: 1 }, suppression: { connectionEnv: 'ALARM', namespace: 'synthetic_alarm', maxRows: 1, maxBytes: 10000, maxConnections: 1 }, route: { id: 'synthetic', maxMessageBytes: 1200, operationTimeoutMs: 100 }, maxPayloadBytes: 1000, maxInflight: 1, attemptTimeoutMs: 100, retryDelayMs: 100, pollIntervalMs: 100, retryIntervalMs: 100 } };
    assert.doesNotThrow(() => metadata(value, {}));
    assert.throws(() => metadata(value, {}, { placement: true }), /invalid/);
    value.realtime.route.maxMessageBytes = 1500;
    assert.doesNotThrow(() => metadata(value, {}, { placement: true }));
  });
});

describe('bounded recovery source primitives', function () {
  it('uses exactly the existing owner key and keeps cached health independent of filesystem and tenant work', async function () {
    const owner = require('../lib/realtime-placement/owner'); let key;
    await owner.acquire({worker: 'a', consumer: 'realtime-stable', connection: {holdAdvisoryLock: async value => {key=value;}}});
    assert.equal(key, owner.key({worker:'a',consumer:'realtime-stable'}));
    assert.notEqual(key, owner.key({worker:'b',consumer:'realtime-stable'}));
    assert.notEqual(key, owner.key({worker:'a',consumer:'realtime-other'}));
    let reads=0, current=parse(config());
    const reader=placement.create({read:()=>{reads++;return current;},self:{worker:'a',incarnation:I}});
    assert.equal(reader.cached(),null);reader.current();const before=reads;
    assert.deepEqual(reader.cached().shards,[0,1,2,3,4,5,6,7]);
    current=parse(move(config(),'b'));
    assert.equal(reader.cached().assignmentIncarnation,I,'cached metadata does not invent a current map read');
    assert.equal(reads,before);reader.current();assert.deepEqual(reader.cached().shards,[]);
    reader.close();
  });
  it('private cached health preserves process versus assignment identity, unknown fields and transport trust', async function () {
    const contracts=require('../lib/server/internal-api/contracts'),{validate}=require('../lib/server/internal-api/schema');
    const module=require('../lib/server/serve/realtime-inspection');let reads=0,quiescing=false;
    const reader=placement.create({read:()=>{reads++;return parse(config());},self:{worker:'a',incarnation:I}});reader.current();
    const token={},create=module({processIncarnation:B,placement:reader,owner:()=>!quiescing,quiescing:()=>quiescing}),api=create(token);
    await assert.rejects(api.inspectRealtime({transport:{}}),{code:'REALTIME_INSPECTION_REFUSED'});
    const before=reads,value=await api.inspectRealtime({transport:token});validate(contracts.realtimeInspection.operations.inspectRealtime.response,value);
    assert.equal(value.processIncarnation,B);assert.equal(value.placement.assignmentIncarnation,I);assert.equal(value.observation,'cached-not-lock-proof');assert.equal(reads,before);
    quiescing=true;assert.equal((await api.inspectRealtime({transport:token})).ownerAvailable,false);
    assert.throws(()=>validate(contracts.realtimeInspection.operations.inspectRealtime.request,{tenant:A}),{code:'INTERNAL_API_SCHEMA_REFUSED'});
    assert.throws(()=>validate(contracts.realtimeInspection.operations.inspectRealtime.response,{...value,secret:'forbidden'}),{code:'INTERNAL_API_SCHEMA_REFUSED'});
  });
  it('recovery publication requires exact old process exclusion AND the old owner lock on the publication client', async function () {
    const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
    const {publishRecovery}=require('../lib/realtime-placement/publish'),owner=require('../lib/realtime-placement/owner');
    const {internal}=require('./fixtures/realtime-placement-map'),protocol=require('./fixtures/operation-window-admission-protocol');
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),'rt-recovery-publication-')),file=path.join(directory,'map.json');
    try {
      for (const mode of ['alive','locked','ready']) {
        const original=config(),candidate=move(original,'b'),trace=[],metadata=protocol();let locks=0;
        await fs.writeFile(file,JSON.stringify(original));
        const client={async query(sql,values){trace.push(sql);if(sql==='BEGIN READ ONLY'||sql==='COMMIT'||sql==='ROLLBACK')return {rows:[]};
          if(sql==='SELECT pg_try_advisory_xact_lock($1::bigint) AS held'){locks++;if(locks===2){assert.equal(values[0],owner.key({worker:'a',consumer:'realtime-stable'}));return {rows:[{held:mode!=='locked'}]};}return {rows:[{held:true}]};}
          const response=metadata(sql,values);if(response)return response;throw Error('unexpected SQL '+sql);}};
        const options={file,candidate,internal,client,consumer:'realtime-stable',controlNamespace:'synthetic_window',registry:{revision:async()=> '1',page:async()=>({revision:'1',tenants:[]})},confirmStopped:async()=>mode!=='alive',
          afterAssignment:async()=>{assert.equal(locks,2,'actual old owner lock acquired before warming/routes');assert(!trace.includes('COMMIT'));assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),candidate);trace.push('routes-ready');}};
        if(mode==='ready'){await publishRecovery(options);assert(trace.indexOf('routes-ready')<trace.indexOf('COMMIT'));}
        else {await assert.rejects(publishRecovery(options),{code:mode==='alive'?'REALTIME_PLACEMENT_OLD_OWNER_UNCONFIRMED':'REALTIME_RECOVERY_OWNER_LOCK_HELD'});assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),original);assert(!trace.includes('routes-ready'));}
      }
    }finally{await fs.rm(directory,{recursive:true});}
  });
});

describe('actual realtime boot observation wiring', function () {
  it('binds private cached health without touching full runtime health and uses a fresh process identity per restart', async function () {
    const fs=require('node:fs'),vm=require('node:vm'),Module=require('node:module');
    const filename=require.resolve('../lib/server/serve/preview-realtime'),local=Module.createRequire(filename),source=fs.readFileSync(filename,'utf8');
    async function boot(transform=s=>s){
      const selected=placement.create({read:()=>parse(config()),self:{worker:'a',incarnation:I}});selected.current();
      const noop=async()=>{},overrides={
        '../../storage/connection-admission':{coldAdmission:()=>null},'./evaluator-readiness':noop,
        '../../storage/postgres-connection':async()=>({end:noop,holdAdvisoryLock:async()=>({available:true,check:noop,close:noop})}),
        '../internal-api/clients':{socketAuthority:()=>({})},'../realtime/api-client':{create:()=>({})},
        './tenant-startup':{notReadyRetry:()=>({}),create:()=>({warm:noop,close:noop})},
        '../realtime/protocol':{create:()=>({close(){},stats:()=>({}),fanout(){}})},
        '../realtime/change-detector':{stampReader:()=>noop,create:()=>({poll:noop})},
        '../realtime/runtime':async()=>({health(){throw Error('WHOLE_TENANT_HEALTH_SCAN');},close:noop})};
      const sandbox={module:{exports:{}},process,console,setInterval:()=>({unref(){}}),clearInterval(){},require:name=>Object.hasOwn(overrides,name)?overrides[name]:local(name)};
      vm.runInNewContext(transform(source),sandbox,{filename});
      return sandbox.module.exports.boot({tenants:new Map(),operationTimeoutMs:100,recoveryIntervalMs:1000,placement:selected,consumer:'realtime-stable',api:{},admission:{},namespaces:{}});
    }
    const one=await boot(),two=await boot();
    try {
      const token={},a=await one.internal['realtime-inspection'].create(token).inspectRealtime({transport:token}),b=await two.internal['realtime-inspection'].create(token).inspectRealtime({transport:token});
      assert.notEqual(a.processIncarnation,b.processIncarnation);assert.equal(a.placement.assignmentIncarnation,I);assert.equal(b.placement.assignmentIncarnation,I);assert.equal(a.ownerAvailable,true);
      await one.quiesce();assert.equal((await one.internal['realtime-inspection'].create(token).inspectRealtime({transport:token})).ownerAvailable,false);
      const needle="'realtime-inspection': Object.freeze({create: require('./realtime-inspection')";assert(source.includes(needle));
      const mutant=await boot(s=>s.replace(needle,"'omitted-realtime-inspection': Object.freeze({create: require('./realtime-inspection')"));
      try{assert.throws(()=>assert(mutant.internal['realtime-inspection'],'REALTIME_BOOT_INSPECTION_MISSING'),/REALTIME_BOOT_INSPECTION_MISSING/);}finally{await mutant.close();}
    }finally{await one.close();await two.close();}
  });
});
