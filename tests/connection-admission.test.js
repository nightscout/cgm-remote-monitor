'use strict';
const assert = require('node:assert/strict'), { EventEmitter } = require('node:events');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const PgPool = require('pg').Pool;
class RecordingStream extends EventEmitter {
  constructor(){super();this.writable=true;this.destroyed=false;this.terminateWrites=0;}
  write(bytes,callback){if(bytes[0]===88)this.terminateWrites++;if(callback)queueMicrotask(callback);return true;}
  end(){this.localEnded=true;this.writable=false;}
  destroy(error){this.destroyed=true;this.writable=false;queueMicrotask(()=>{if(error)this.emit('error',error);this.emit('close',!!error);});return this;}
  peerClose(){this.emit('end');this.emit('close',false);}
}
function actualDriver(instances,Base=require('pg').Client){
  return class RecordingClient extends Base {
    constructor(options){
      super(options);const connection=this.connection,stream=new RecordingStream();connection.stream=stream;
      connection.connect=function(){this._connecting=true;stream.on('error',error=>this.emit('error',error));stream.once('close',()=>this.emit('end'));};
      instances.push(this);
    }
    finishConnect(error){if(error)this.connection.emit('error',error);else this.connection.emit('readyForQuery',{status:'I'});}
    finishEnd(){this.connection.stream.peerClose();}
  };
}
const turn = () => new Promise(resolve => setImmediate(resolve));
function admission (transform = source => source) {
  const filename = path.resolve(__dirname, '../lib/storage/connection-admission.js'), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(transform(fs.readFileSync(filename, 'utf8')), filename); return loaded.exports;
}
function fixture ({ onState, onQuiescent, poolMax = 2, requestedMaximum = 2, clientKind = 'client', transform, driver = false, directConcurrency = 2, planVersion = 1, workerDatabase = { database: 'synthetic', databaseOid: '16384' }, alterPlan, serialized = false, settingsDriver = false } = {}) {
  const api = admission(transform), instances = [], states = [], acknowledgements = [];
  class Client extends EventEmitter {
    constructor (options) { super(); this.connection = new EventEmitter();this.connection.stream=new RecordingStream();this.connection.end=()=>this.connection.stream.end();this.connectionParameters = { application_name: options.application_name,ssl:false };this._queryable=true;this._connectionError=false;this._queryQueue=[];this._sentQueryQueue=[];this._getActiveQuery=()=>null;this.options = options; instances.push(this); }
    connect (callback) {
      this.connectWasStarted = true;
      if (typeof callback === 'function') { this.connected = callback; return; }
      return new Promise((resolve, reject) => { this.connected = error => error ? reject(error) : resolve(); });
    }
    finishConnect (error) { const fn = this.connected; this.connected = null; fn(error); }
    end (callback) { if (!this.connectWasStarted) { callback(); return; } this.ended = callback;this.connection.end(); }
    finishEnd (error) { this.connection.stream.peerClose();this.connection.emit('end'); this.emit('end'); const fn = this.ended; this.ended = null; if (fn) fn(error); }
  }
  if(driver)Client=actualDriver(instances,settingsDriver?require('../lib/storage/postgres-settings-protocol').Client:undefined);
  const plan = { version: 1, processInstanceId: 'synthetic-api', incarnation: 'a'.repeat(32), nonce: 'b'.repeat(32), planSha256: 'c'.repeat(64), pgResourceId: 'synthetic-pg', resourceAliases: ['synthetic-pg:5432'],
    source: { coreCommit: 'd'.repeat(40), deployCommit: 'e'.repeat(40) },
    capabilities: { 'synthetic-pool': { kind: 'pool', poolMax, maxInstances: 1, metadata: { requestedMaximum, source: 'synthetic:1', configurationSource: 'explicit-profile' } },
      'settings-readiness': { kind: clientKind, directGroup: 'settings', metadata: { source: 'synthetic:2' } },
      'migration-direct': { kind: clientKind, directGroup: 'settings', metadata: { source: 'synthetic:3' } } }, directGroups: { settings: directConcurrency }, cold:{activeLimit:1,pendingLimit:2,minDelayMs:0,maxDelayMs:0} };
  plan.version = planVersion; if (planVersion === 2) plan.workerDatabase = workerDatabase;
  alterPlan?.(plan);
  api.install(serialized ? JSON.parse(JSON.stringify(plan)) : plan, { onState: value => { states.push(value); if (onState) onState(value); }, onQuiescent: async value => { if (onQuiescent) await onQuiescent(value); acknowledgements.push(value); } });
  const options = () => api.poolOptions('synthetic-pool', { host: 'synthetic-pg', max: requestedMaximum, application_name: 'synthetic-pool', idleTimeoutMillis: 0 });
  return { api, Client, plan, instances, states, acknowledgements, options };
}

describe('opt-in process-local constructor and physical retirement admission', function () {
  it('leaves constructors/options exact originals when not installed', function () {
    const api = admission(), original = { max: 2 };
    function Pool () {} function Client () {}
    assert.equal(api.wrapPool(Pool, undefined, 'unknown'), Pool); assert.equal(api.wrapClient(Client, 'unknown'), Client);
    assert.equal(api.poolOptions('unknown', original), original); assert.equal(api.health(), null);
  });
  it('carries real lifetime cold observations through the existing clean quiescent ACK callback', async function () {
    const f=fixture(),gate=f.api.coldAdmission();let release,started;const held=new Promise(resolve=>{release=resolve;}),begun=new Promise(resolve=>{started=resolve;});
    const running=gate.run({},async()=>{started();await held;});await begun;const key={};const queued=gate.run(key,async()=>assert.fail('cancelled cold work must not run')),cancelled=assert.rejects(queued,{code:'COLD_START_CANCELLED'});const closing=gate.run({},async()=>assert.fail('closed cold work must not run')),closed=assert.rejects(closing,{code:'COLD_START_CLOSED'});
    assert.equal(gate.health().observed.peakQueued,2);assert.equal(gate.cancel(key),true);await cancelled;f.api.beginQuiesce();const proof=f.api.finalizeQuiescence(true);await closed;assert.equal(f.acknowledgements.length,0);release();await running;await proof;
    assert.equal(f.acknowledgements.length,1);const ack=f.acknowledgements[0];assert.equal(ack.cleanShutdown,true);assert.equal(ack.pendingConnects+ack.liveConnections,0);assert.equal(ack.cold.closed,true);assert.equal(ack.cold.queued+ack.cold.delaying+ack.cold.running,0);assert.equal(ack.cold.observed.peakActive,1);assert.equal(ack.cold.observed.peakQueued,2);assert.equal(ack.cold.observed.accepted,3);assert.equal(ack.cold.observed.started,1);assert.equal(ack.cold.observed.completed,1);assert.equal(ack.cold.observed.cancelled,1);assert.equal(ack.cold.observed.closeCancelled,1);assert.deepEqual(ack.cold.observed,gate.health().observed);
  });
  it('preserves actual pg credential descriptors and lazy password functions through selected pool and direct constructors', async function () {
    const pg=require('pg'),sasl=require('pg/lib/crypto/sasl'),secret='synthetic-local-only';
    for(const pooled of [false,true]) for(const mode of ['literal','hidden-literal','function','hidden-function','getter-function','url']) {
      const observations=[];
      for(const selected of [false,true]) {
        const f=fixture({driver:true}),name=pooled?'synthetic-pool':'settings-readiness';let calls=0,getterReads=0,argument;
        const password=mode.includes('function')?async parameters=>{calls++;argument=parameters;return secret;}:secret;
        const options=mode==='url'?{connectionString:'postgres://synthetic:synthetic-local-only@synthetic-pg/synthetic?sslmode=disable'}:{host:'synthetic-pg',user:'synthetic',database:'synthetic',ssl:false};
        if(mode==='getter-function')Object.defineProperty(options,'password',{get(){getterReads++;return password;},enumerable:false});
        else if(mode!=='url')Object.defineProperty(options,'password',{value:password,enumerable:!mode.startsWith('hidden'),writable:false,configurable:false});
        Object.defineProperty(options,'query_timeout',{value:3791,enumerable:false,writable:false,configurable:false});
        if(pooled)Object.assign(options,{max:2,application_name:name,idleTimeoutMillis:0});
        const before=Object.getOwnPropertyDescriptors(options);let client,pool;
        if(pooled){const Pool=selected?f.api.wrapPool(pg.Pool,f.Client,name):pg.Pool;pool=selected?new Pool(f.api.poolOptions(name,options)):new Pool(options,f.Client);client=new pool.Client(pool.options);}
        else {const Client=selected?f.api.wrapClient(f.Client,name):f.Client;client=new Client(options);}
        assert.deepStrictEqual(Object.getOwnPropertyDescriptors(options),before,'ordinary caller options remain unchanged');
        assert.equal(calls,0,'constructors do not eagerly call credential functions');
        if(mode!=='url')assert.strictEqual(client.password,password,'literal or credential function survives non-enumerable pool custody');
        if(typeof password==='function') {await new Promise(resolve=>client._getPassword(resolve));assert.equal(calls,1);assert.strictEqual(argument,client.connectionParameters);}
        assert.equal(client.password,secret);assert.equal(Object.getOwnPropertyDescriptor(client,'password').enumerable,false);
        if(pooled&&mode!=='url')assert.equal(Object.getOwnPropertyDescriptor(pool.options,'password').enumerable,false);
        if(selected)assert.match(client.connectionParameters.application_name,/^nscb:/);
        client.saslSession=sasl.startSession(['SCRAM-SHA-256']);let final=0,failure;client.connection.sendSCRAMClientFinalMessage=()=>{final++;};client.connection.on('error',error=>{failure=error;});
        await client._handleAuthSASLContinue({data:'r='+client.saslSession.clientNonce+'server,s=c3ludGhldGlj,i=4096'});
        assert.equal(failure,undefined,'actual pg SCRAM continuation accepts the synthetic credential');assert.equal(final,1);
        observations.push({queryTimeout:client.connectionParameters.query_timeout,credentialCalls:calls,getterReads});
        await client.end();client.connection.stream.destroy();if(pool)await pool.end();
      }
      assert.deepStrictEqual(observations[1],observations[0],'selected constructor preserves actual driver semantics');
    }
  });
  it('keeps actual pg lazy credential resolution, rejection and invalid-result behavior identical to unselected pools', async function () {
    const pg=require('pg');
    for(const mode of ['sync','async','rejected','invalid','undefined']) {
      const observations=[];
      for(const selected of [false,true]) {
        const f=fixture({driver:true});let calls=0,argument;const denied=Object.assign(Error('synthetic credential refusal'),{code:'SYNTHETIC_CREDENTIAL_REFUSED'});
        const credential=parameters=>{calls++;argument=parameters;if(mode==='rejected')return Promise.reject(denied);if(mode==='invalid')return 17;if(mode==='undefined')return undefined;return mode==='async'?Promise.resolve('synthetic-local-only'):'synthetic-local-only';};
        const options={host:'synthetic-pg',ssl:false,max:2,application_name:'synthetic-pool',idleTimeoutMillis:0};Object.defineProperty(options,'password',{value:credential,enumerable:false});const before=Object.getOwnPropertyDescriptors(options);
        const Pool=selected?f.api.wrapPool(pg.Pool,f.Client,'synthetic-pool'):pg.Pool,pool=selected?new Pool(f.api.poolOptions('synthetic-pool',options)):new Pool(options,f.Client),client=new pool.Client(pool.options);
        assert.strictEqual(client.password,credential);assert.equal(calls,0);let callbacks=0,failure;client.connection.on('error',error=>{failure=error;});client._getPassword(()=>{callbacks++;});await turn();
        assert.equal(calls,1);assert.strictEqual(argument,client.connectionParameters);assert.deepStrictEqual(Object.getOwnPropertyDescriptors(options),before);
        if(mode==='rejected'){assert.strictEqual(failure,denied);assert.equal(callbacks,0);}else if(mode==='invalid'){assert(failure instanceof TypeError);assert.equal(callbacks,0);}else{assert.equal(failure,undefined);assert.equal(callbacks,1);assert.equal(client.password,mode==='undefined'?null:'synthetic-local-only');}
        observations.push({callbacks,errorType:failure?.constructor.name||null,passwordType:typeof client.password,credentialRetained:client.password===credential});await client.end();await pool.end();
      }
      assert.deepStrictEqual(observations[1],observations[0]);
    }
  });
  it('preserves lazy getters, hidden fields and the input prototype while overriding only admitted options', async function () {
    const f=fixture(),prototype={syntheticInherited:true};let reads=0;
    const options=Object.create(prototype,{host:{value:'synthetic-pg',enumerable:true},max:{value:2,enumerable:true},password:{get(){reads++;return 'synthetic-local-only';},enumerable:false},syntheticHidden:{value:'synthetic-metadata',enumerable:false}});
    const before=Object.getOwnPropertyDescriptors(options),selected=f.api.poolOptions('synthetic-pool',options);
    assert.strictEqual(Object.getPrototypeOf(selected),prototype);assert.equal(reads,0);assert.equal(Object.getOwnPropertyDescriptor(selected,'password').get,before.password.get);assert.equal(selected.syntheticHidden,'synthetic-metadata');assert.equal(Object.keys(selected).includes('syntheticHidden'),false);
    const Client=f.api.wrapClient(f.Client,'settings-readiness'),client=new Client(selected);assert.equal(reads,0);assert.equal(client.options.syntheticHidden,'synthetic-metadata');assert.strictEqual(Object.getPrototypeOf(client.options),prototype);assert.equal(Object.getOwnPropertyDescriptor(client.options,'password').get,before.password.get);assert.match(client.options.application_name,/^nscb:/);assert.deepStrictEqual(Object.getOwnPropertyDescriptors(options),before);await client.end();
  });
  it('requires exact source options then applies only the explicit selected configuration and caps constructors', function () {
    const f = fixture({ poolMax: 1, requestedMaximum: 2 }), Selected = f.api.wrapPool(PgPool, f.Client, 'synthetic-pool');
    assert.throws(() => new Selected({ max: 2 }), { code: 'CONNECTION_ADMISSION_POOL_MAX_MISMATCH' });
    assert.throws(() => f.api.poolOptions('synthetic-pool', { host: 'synthetic-pg', max: 3 }), { code: 'CONNECTION_ADMISSION_SOURCE_OPTIONS_CHANGED' });
    const pool = new Selected(f.options()); assert.equal(pool.options.max, 1);
    assert.throws(() => new Selected(f.options()), { code: 'CONNECTION_ADMISSION_CAPABILITY_EXHAUSTED' });
    assert.throws(() => new (f.api.wrapClient(f.Client, 'unlisted'))({host:'synthetic-pg'}), { code: 'CONNECTION_ADMISSION_CAPABILITY_UNKNOWN' });
    assert.deepEqual(f.api.health().configurations['synthetic-pool'], { requestedMaximum: 2, selectedMaximum: 1, configurationSource: 'explicit-profile', source: 'synthetic:1' });
  });
  it('shares direct concurrency across capability aliases and never double counts held pool clients', async function () {
    const f = fixture(), A = f.api.wrapClient(f.Client, 'settings-readiness'), B = f.api.wrapClient(f.Client, 'migration-direct');
    const a = new A({ host: 'synthetic-pg' }), b = new B({ host: 'synthetic-pg' });
    assert.throws(() => new A({ host: 'synthetic-pg' }), { code: 'CONNECTION_ADMISSION_DIRECT_EXHAUSTED' });
    const Pool = f.api.wrapPool(PgPool, f.Client, 'synthetic-pool'), pool = new Pool(f.options());
    const connect = pool.connect(); f.instances.at(-1).finishConnect(); const client = await connect;
    assert.equal(f.api.health().capabilityReservations['synthetic-pool'], 1); assert.equal(f.api.health().directReservations.settings, 2);
    client.release(); const ending = pool.end(); f.instances.at(-1).finishEnd(); await ending;
    await a.end(); await b.end();
    assert.equal(f.api.health().directReservations.settings, 0);
  });
  it('base Pool.end empty-list completion cannot refund or acknowledge before underlying end', async function () {
    const f = fixture(), Pool = f.api.wrapPool(PgPool, f.Client, 'synthetic-pool'), pool = new Pool(f.options());
    const connecting = pool.connect(); const client = f.instances[0]; client.finishConnect(); (await connecting).release();
    f.api.beginQuiesce(); let ended = false, acked = false;
    const closing = pool.end().then(() => { ended = true; }); const finalizing = f.api.finalizeQuiescence(true).then(() => { acked = true; });
    await turn(); assert.equal(pool.ended, true, 'actual pg-pool has already resolved its empty-list end callback');
    assert.equal(ended, false); assert.equal(acked, false); assert.equal(f.api.health().capabilityReservations['synthetic-pool'], 1);
    client.finishEnd(); await closing; await finalizing;
    assert.equal(f.api.health().capabilityReservations['synthetic-pool'], 0); assert.equal(f.acknowledgements.length, 1);
    assert.equal(f.acknowledgements[0].pendingConnects, 0); assert.equal(f.acknowledgements[0].liveConnections, 0); assert.equal(f.acknowledgements[0].constructorsFrozen, true);
  });
  it('pending authentication cannot disappear from quiescence even if a close event precedes its callback', async function () {
    const f = fixture(), Client = f.api.wrapClient(f.Client, 'settings-readiness'), client = new Client({ host: 'synthetic-pg' });
    const connected = assert.rejects(client.connect(), /synthetic authentication/); const ending = assert.rejects(client.end(),{code:'CONNECTION_ADMISSION_CLEANUP_UNCONFIRMED'});
    f.api.beginQuiesce(); const proof = assert.rejects(f.api.finalizeQuiescence(true),{code:'CONNECTION_ADMISSION_CLEANUP_UNCONFIRMED'});
    client.finishEnd(); await turn(); assert.equal(f.acknowledgements.length,0); assert.equal(f.api.health().pendingConnects, 1);
    client.finishConnect(Error('synthetic authentication')); await connected; await ending; await proof;
    assert.equal(f.api.health().pendingConnects,0);assert.equal(f.api.health().liveConnections,0);assert.equal(f.api.health().unconfirmedCleanup,true);assert.equal(f.api.health().directReservations.settings,1);
  });
  it('actual pg idle Terminate requires peer EOF and close; a local Connection end alone cannot refund', async function () {
    const f=fixture({driver:true,directConcurrency:1}),Client=f.api.wrapClient(f.Client,'settings-readiness'),client=new Client({host:'synthetic-pg',ssl:false});
    const connecting=client.connect();client.finishConnect();await connecting;
    const ending=client.end();await turn();assert.equal(client.connection.stream.terminateWrites,1);assert.equal(client.connection.stream.localEnded,true);
    f.api.beginQuiesce();let acknowledged=false;const proof=f.api.finalizeQuiescence(true).then(()=>{acknowledged=true;});
    client.connection.emit('end');await turn();assert.equal(acknowledged,false);assert.equal(f.api.health().directReservations.settings,1);
    client.finishEnd();await ending;await proof;assert.equal(f.api.health().directReservations.settings,0);assert.equal(f.acknowledgements.length,1);
  });
  it('actual pg failed/aborted preauthentication retains credit despite local end, settled callback and a zero census', async function () {
    const f=fixture({driver:true,directConcurrency:1}),Client=f.api.wrapClient(f.Client,'settings-readiness'),client=new Client({host:'synthetic-pg',ssl:false});
    const connecting=assert.rejects(client.connect(),/synthetic authentication abort/),ending=assert.rejects(client.end(),{code:'CONNECTION_ADMISSION_CLEANUP_UNCONFIRMED'});
    client.connection.stream.destroy(Error('synthetic authentication abort'));await connecting;await ending;await turn();
    const zeroCensus=[];assert.deepEqual(zeroCensus,[]);assert.equal(f.api.health().pendingConnects,0);assert.equal(f.api.health().liveConnections,0);
    assert.equal(f.api.health().clients[0].authenticated,false);assert.equal(f.api.health().unconfirmedCleanup,true);assert.equal(f.api.health().directReservations.settings,1);
    assert.throws(()=>new Client({host:'synthetic-pg'}),{code:'CONNECTION_ADMISSION_CAPABILITY_EXHAUSTED'});
    f.api.beginQuiesce();await assert.rejects(f.api.finalizeQuiescence(true),{code:'CONNECTION_ADMISSION_CLEANUP_UNCONFIRMED'});assert.equal(f.acknowledgements.length,0);
  });
  it('actual pg active/unqueryable/destroy/error/raw-end paths retain credit and never substitute local close for peer proof', async function () {
    for(const mode of ['active','unqueryable','destroy','error','raw-end']) {
      const f=fixture({driver:true,directConcurrency:1}),Client=f.api.wrapClient(f.Client,'settings-readiness'),client=new Client({host:'synthetic-pg',ssl:false});
      client.on('error',()=>{});const connecting=client.connect();client.finishConnect();await connecting;
      if(mode==='active')client._activeQuery={handleError(){}};
      if(mode==='unqueryable')client._queryable=false;
      if(mode==='destroy')client.connection.stream.destroy();
      if(mode==='error')client.connection.stream.emit('error',Error('synthetic transport error'));
      if(mode==='raw-end')client.connection.stream.end();
      const ending=assert.rejects(client.end(),{code:'CONNECTION_ADMISSION_CLEANUP_UNCONFIRMED'});await turn();
      if(mode==='active'||mode==='unqueryable')assert.equal(client.connection.stream.destroyed,true,'actual pg.Client.end force-destroys this path');
      client.finishEnd();await ending;assert.equal(f.api.health().unconfirmedCleanup,true);assert.equal(f.api.health().directReservations.settings,1);
      assert.throws(()=>new Client({host:'synthetic-pg'}),{code:'CONNECTION_ADMISSION_CAPABILITY_EXHAUSTED'});
      f.api.beginQuiesce();await assert.rejects(f.api.finalizeQuiescence(true));assert.equal(f.acknowledgements.length,0);
    }
  });
  it('actual pg-pool failed authentication poisons its physical reservation and refuses replacement through the pending callback', async function () {
    const f=fixture({driver:true,poolMax:1,requestedMaximum:1}),Pool=f.api.wrapPool(PgPool,f.Client,'synthetic-pool'),pool=new Pool(f.options());
    const failed=assert.rejects(pool.connect(),/synthetic pool authentication/),client=f.instances[0];
    client.connection.stream.destroy(Error('synthetic pool authentication'));await failed;await turn();
    await assert.rejects(pool.connect(),{code:'CONNECTION_ADMISSION_CLEANUP_UNCONFIRMED'});assert.equal(f.instances.length,1);
    await assert.rejects(pool.end(),{code:'CONNECTION_ADMISSION_CLEANUP_UNCONFIRMED'});assert.equal(f.api.health().capabilityReservations['synthetic-pool'],1);
    f.api.beginQuiesce();await assert.rejects(f.api.finalizeQuiescence(true));assert.equal(f.acknowledgements.length,0);
  });
  it('actual pg-pool queued replacement gets typed refusal while the logically removed old socket awaits peer EOF', async function () {
    const f=fixture({driver:true,poolMax:1,requestedMaximum:1}),Pool=f.api.wrapPool(PgPool,f.Client,'synthetic-pool'),pool=new Pool(f.options());
    const connecting=pool.connect(),client=f.instances[0];client.finishConnect();(await connecting).release();
    const refused=assert.rejects(pool.connect(),{code:'CONNECTION_ADMISSION_POOL_CLIENT_EXHAUSTED'});
    pool._remove(client);await refused;assert.equal(pool.totalCount,0);assert.equal(f.instances.length,1);
    assert.equal(f.api.health().capabilityReservations['synthetic-pool'],1);client.finishEnd();await turn();
    const next=pool.connect(),replacement=f.instances[1];replacement.finishConnect();(await next).release();
    const ending=pool.end();replacement.finishEnd();await ending;f.api.beginQuiesce();await f.api.finalizeQuiescence(true);
  });
  it('selected TLS is explicitly unsupported before a PG constructor; plaintext is never substituted', function () {
    for(const options of [{host:'synthetic-pg',ssl:true},{connectionString:'postgres://synthetic-pg/db?sslmode=require'}]) {
      const f=fixture({driver:true}),Client=f.api.wrapClient(f.Client,'settings-readiness');assert.throws(()=>new Client(options),{code:'CONNECTION_ADMISSION_TLS_UNSUPPORTED'});assert.equal(f.instances.length,0);
    }
  });
  it('freeze denies later constructors and handshakes, including client creation through an existing pool', async function () {
    const f = fixture(), Pool = f.api.wrapPool(PgPool, f.Client, 'synthetic-pool'), pool = new Pool(f.options());
    const Client = f.api.wrapClient(f.Client, 'settings-readiness'), client = new Client({ host: 'synthetic-pg' });
    f.api.beginQuiesce(); const before = f.instances.length;
    assert.throws(() => new Client({ host: 'synthetic-pg' }), { code: 'CONNECTION_ADMISSION_FROZEN' });
    await assert.rejects(client.connect(), { code: 'CONNECTION_ADMISSION_HANDSHAKE_REFUSED' });
    await assert.rejects(pool.connect(), { code: 'CONNECTION_ADMISSION_HANDSHAKE_REFUSED' }); assert.equal(f.instances.length, before);
    await client.end(); await pool.end(); await f.api.finalizeQuiescence(true); assert.equal(f.acknowledgements.length, 1);
  });
  it('unconfirmed end retains credit and forbids any graceful acknowledgement', async function () {
    const f = fixture(), Client = f.api.wrapClient(f.Client, 'settings-readiness'), client = new Client({ host: 'synthetic-pg' });
    client.ended = null; const failure = Error('synthetic end failure'); f.Client.prototype.end = () => Promise.reject(failure);
    await assert.rejects(client.end(), { code: 'CONNECTION_ADMISSION_CLEANUP_UNCONFIRMED' });
    assert.equal(f.api.health().directReservations.settings, 1);
    f.api.beginQuiesce(); await assert.rejects(f.api.finalizeQuiescence(true), { code: 'CONNECTION_ADMISSION_CLEANUP_UNCONFIRMED' }); assert.equal(f.acknowledgements.length, 0);
  });
  it('callback and promise end forms both await actual socket closure and preserve the lossless name map', async function () {
    const f = fixture(), Client = f.api.wrapClient(f.Client, 'settings-readiness'), client = new Client({ host: 'synthetic-pg', application_name: 'complete original synthetic application name' });
    const connecting = client.connect(); client.finishConnect(); await connecting;
    let ended = false; const promise = new Promise((resolve, reject) => client.end(error => { if (error) reject(error); else { ended = true; resolve(); } }));
    await turn(); assert.equal(ended, false); client.finishEnd(); await promise;
    const mapping = f.api.health().applicationNames, tags = Object.keys(mapping); assert.equal(tags.length, 1); assert(Buffer.byteLength(tags[0]) <= 63);
    assert.equal(mapping[tags[0]].originalApplicationName, 'complete original synthetic application name');
    assert.equal(new Set(f.api.health().tags).size, f.api.health().tags.length);
    f.api.beginQuiesce(); await f.api.finalizeQuiescence(true);
  });
  it('records the lossless pre-tag pg application-name precedence including environment and fallback', async function () {
    const parameters=require('pg/lib/connection-parameters'),defaults=require('pg').defaults;
    const env=process.env.PGAPPNAME,oldDefault=defaults.application_name,oldFallback=defaults.fallback_application_name;
    try {
      for (const row of [
        {options:{application_name:'explicit-original'},env:'environment-original',fallback:'fallback-original'},
        {options:{application_name:''},env:'environment-original',fallback:'fallback-original'},
        {options:{},fallback:'fallback-original'},
        {options:{},defaultName:'default-original',fallback:'fallback-original'},
        {options:{},defaultFallback:'default-fallback-original'}
      ]) {
        if(row.env===undefined)delete process.env.PGAPPNAME;else process.env.PGAPPNAME=row.env;
        defaults.application_name=row.defaultName;defaults.fallback_application_name=row.defaultFallback;
        const options={host:'synthetic-pg',ssl:false,...row.options,...(row.fallback?{fallback_application_name:row.fallback}:{})};
        const expected=new parameters(options),original=expected.application_name||expected.fallback_application_name||null;
        const f=fixture(),Client=f.api.wrapClient(f.Client,'settings-readiness'),client=new Client(options);
        assert.equal(Object.values(f.api.health().applicationNames)[0].originalApplicationName,original);
        await client.end();
        if (row.env && row.options.application_name === '') {
          const g=fixture({transform:source=>source.replace(/const original = options.application_name \|\|[\s\S]*?\|\| null;/,"const original = options.application_name === undefined ? null : options.application_name;")});
          const Old=g.api.wrapClient(g.Client,'settings-readiness'),old=new Old(options);
          assert.notEqual(Object.values(g.api.health().applicationNames)[0].originalApplicationName,original,'old direct-options mapping loses the effective PGAPPNAME');
          await old.end();
        }
      }
    } finally {if(env===undefined)delete process.env.PGAPPNAME;else process.env.PGAPPNAME=env;defaults.application_name=oldDefault;defaults.fallback_application_name=oldFallback;}
  });
  it('observes Promise-only cleanup and refuses conflicting callback/Promise cleanup outcomes', async function () {
    const f = fixture(), Client = f.api.wrapClient(f.Client, 'settings-readiness'), a = new Client({host:'synthetic-pg'});
    f.Client.prototype.end = () => Promise.resolve(); await a.end();
    const b = new Client({host:'synthetic-pg'});
    f.Client.prototype.end = callback => { callback(); return Promise.reject(Error('synthetic late cleanup failure')); };
    await assert.rejects(b.end(), {code:'CONNECTION_ADMISSION_CLEANUP_UNCONFIRMED'});
    assert.equal(f.api.health().directReservations.settings, 1);
    f.api.beginQuiesce(); await assert.rejects(f.api.finalizeQuiescence(true)); assert.equal(f.acknowledgements.length,0);
  });
  it('refuses alternate physical resources and URI setting overrides before a PG constructor', function () {
    for (const options of [{host:'other-pg'}, {host:'synthetic-pg', options:'-c application_name=other'}, {connectionString:'postgresql://synthetic-pg/db?host=other-pg'}, {connectionString:'postgresql://synthetic-pg/db?application_name=other'}]) {
      const f = fixture(), Client = f.api.wrapClient(f.Client, 'settings-readiness');
      assert.throws(() => new Client(options), error => /^CONNECTION_ADMISSION_(RESOURCE_|STARTUP_OPTIONS_)/.test(error.code));
      assert.equal(f.instances.length, 0);
    }
    const f = fixture(), tag = f.api.applicationTag(f.plan, 'settings-readiness');
    assert(f.api.health().tags.includes(tag)); assert(Buffer.byteLength(tag) <= 63);
  });
  it('the actual pg-pool early-retirement mutant falsely acknowledges and the restored physical condition refuses', async function () {
    for (const mutant of [true, false]) {
      const transform = mutant ? source => source.replace('[...row.clients].every(client => !client.uncertain && physicalClosed(client) && (!client.endRequested || client.endSettled))', 'true') : undefined;
      const f = fixture({transform}), Pool = f.api.wrapPool(PgPool, f.Client, 'synthetic-pool'), pool = new Pool(f.options());
      const connecting = pool.connect(), client = f.instances[0]; client.finishConnect(); (await connecting).release();
      f.api.beginQuiesce(); const closing = pool.end(), proof = f.api.finalizeQuiescence(true);
      await turn(); assert.equal(f.acknowledgements.length, mutant ? 1 : 0);
      client.finishEnd(); await closing; await proof;
    }
  });
  it('actual dedicated feed-reader serve.stop freezes, physically drains, and only acknowledges successful role close', async function () {
    for (const failed of [false,true]) {
      const f=fixture(), Client=f.api.wrapClient(f.Client,'settings-readiness'), client=new Client({host:'synthetic-pg'});
      const connected=client.connect();client.finishConnect();await connected;
      const filename=path.resolve(__dirname,'../lib/server/serve/index.js'), loaded=new Module(filename,module), actual=Module.createRequire(filename);
      loaded.filename=filename;loaded.paths=Module._nodeModulePaths(path.dirname(filename));
      loaded.require=name=>({
        './listeners':{resolve:()=>[],close:async()=>{}}, './internal-listener':{plan:()=>[]},
        '../../diagnostics/m7':{configureRoles:()=>{},close:()=>{}}, '../../storage/connection-admission':f.api,
        '../../change-feed/reader':{boot:async()=>({close:async()=>{await client.end();if(failed)throw Error('synthetic role close failure');}})}
      }[name]||actual(name));
      loaded._compile(fs.readFileSync(filename,'utf8'),filename);
      const running=await loaded.exports.start(['feed-reader'],{}, {}, {}, {feedReader:{}});
      const stopped=running.stop();const observation=failed?assert.rejects(stopped,/Role shutdown failed/):stopped;
      await turn();assert.equal(f.api.health().constructorsFrozen,true);assert.equal(f.acknowledgements.length,0);
      client.finishEnd();await observation;assert.equal(f.acknowledgements.length,failed?0:1);
    }
  });
  it('durable state failure and forced shutdown cannot publish a graceful acknowledgement', async function () {
    let snapshots = 0; const f = fixture({ onState: () => { if (++snapshots > 1) throw Error('synthetic durable write failure'); } });
    assert.throws(() => new (f.api.wrapClient(f.Client, 'settings-readiness'))({ host: 'synthetic-pg' }), { code: 'CONNECTION_ADMISSION_STATE_UNCONFIRMED' });
    assert.equal(f.instances.length, 0); await assert.rejects(f.api.finalizeQuiescence(false)); assert.equal(f.acknowledgements.length, 0);
    const g = fixture(); g.api.beginQuiesce(); await assert.rejects(g.api.finalizeQuiescence(false), { code: 'CONNECTION_ADMISSION_SHUTDOWN_UNCONFIRMED' }); assert.equal(g.acknowledgements.length, 0);
  });
});


describe('physical plan 2 fixed backend database verification', function () {
  function selected(extra={}) {
    const f=fixture({driver:true,planVersion:2,...extra});
    const Client=f.api.wrapClient(f.Client,'settings-readiness');
    const client=new Client({host:'synthetic-pg',ssl:false});
    const sql=[], original=client.connection.query;
    client.connection.query=function(text){sql.push(text);return original.apply(this,arguments);};
    client.on('error',()=>{});
    return {...f,client,sql};
  }
  function result(client, rows=[['synthetic','16384']]) {
    client.connection.emit('rowDescription',{fields:['database','databaseOid'].map(name=>({name,dataTypeID:25,format:'text'}))});
    for(const row of rows) client.connection.emit('dataRow',{fields:row.map(v=>Buffer.from(v))});
    client.connection.emit('commandComplete',{text:'SELECT '+rows.length});
    client.connection.emit('readyForQuery',{status:'I'});
  }
  it('requires a sealed exact canonical expected identity, never infers it from caller options',function(){
    for(const workerDatabase of [null,{}, {database:'synthetic',databaseOid:16384},{database:'synthetic',databaseOid:'016384'},{database:'synthetic',databaseOid:'4294967296'},{database:'bad-name',databaseOid:'1'},{database:'synthetic',databaseOid:'1',sql:'anything'}]) {
      assert.throws(()=>fixture({planVersion:2,workerDatabase}),{code:'CONNECTION_ADMISSION_PLAN_INVALID'});
    }
  });
  it('holds Promise/connect-event and rejects all public query forms until one same-backend read succeeds',async function(){
    const f=selected(),{client}=f;let connected=false,events=0;client.on('connect',()=>{events++;assert.equal(f.sql.length,1);});
    const refused=client.query('SELECT forbidden').catch(error=>error);assert.equal(client._queryQueue.length,0,'public work must not enter the pg queue');assert.equal((await refused).code,'CONNECTION_ADMISSION_DATABASE_NOT_VERIFIED');
    const pending=client.connect().then(()=>{connected=true;});client.finishConnect();
    assert.equal(events,0);assert.equal(connected,false);assert.equal(f.api.health().pendingConnects,1);
    assert.equal(f.sql.length,1);assert.match(f.sql[0],/^SELECT pg_catalog\.current_database\(\)/);
    await assert.rejects(client.query('SELECT forbidden'),{code:'CONNECTION_ADMISSION_DATABASE_NOT_VERIFIED'});
    await new Promise(resolve=>client.query('SELECT forbidden',error=>{assert.equal(error.code,'CONNECTION_ADMISSION_DATABASE_NOT_VERIFIED');resolve();}));
    const query=new (require('pg').Query)('SELECT forbidden');query.on('error',()=>{});
    await new Promise(resolve=>{query.callback=error=>{assert.equal(error.code,'CONNECTION_ADMISSION_DATABASE_NOT_VERIFIED');resolve();};assert.equal(client.query(query),query);});
    assert.equal(f.sql.length,1);result(client);await pending;assert.equal(events,1);assert.equal(connected,true);assert.equal(f.api.health().pendingConnects,0);
    const publicQuery=client.query('SELECT permitted');assert.equal(f.sql[1],'SELECT permitted');result(client);await publicQuery;
  });
  it('preserves callback completion before the delayed public event and pool onConnect/acquire exposure',async function(){
    const f=selected(),order=[];f.client.on('connect',()=>order.push('event'));
    const pending=new Promise((resolve,reject)=>f.client.connect(error=>{if(error)reject(error);else{order.push('callback');resolve();}}));
    f.client.finishConnect();assert.deepEqual(order,[]);result(f.client);await pending;assert.deepEqual(order,['callback','event']);
    const g=fixture({driver:true,planVersion:2}),Pool=g.api.wrapPool(PgPool,g.Client,'synthetic-pool');
    let exposed=0;const pool=new Pool({...g.options(),onConnect:()=>{exposed++;}});pool.on('connect',()=>exposed++);pool.on('acquire',()=>exposed++);
    const acquiring=pool.connect();const client=g.instances[0];client.finishConnect();await turn();assert.equal(exposed,0);result(client);const acquired=await acquiring;assert.equal(exposed,3);acquired.release();
    const ending=pool.end();client.finishEnd();await ending;
  });
  it('refuses name/OID/shape mismatches and actual driver query errors without refund or clean ACK',async function(){
    for(const mode of ['database','oid','empty','extra','error']) {
      const f=selected(),pending=assert.rejects(f.client.connect(),{code:mode==='error'?'CONNECTION_ADMISSION_DATABASE_UNCONFIRMED':'CONNECTION_ADMISSION_DATABASE_MISMATCH'});
      f.client.finishConnect();
      if(mode==='error') {f.client.connection.emit('errorMessage',Object.assign(Error('DO_NOT_DISCLOSE'),{code:'42501'}));f.client.connection.emit('readyForQuery',{status:'I'});}
      else result(f.client,mode==='empty'?[]:mode==='extra'?[['synthetic','16384'],['synthetic','16384']]:[[mode==='database'?'foreign':'synthetic',mode==='oid'?'999':'16384']]);
      await pending;assert.equal(f.api.health().clients[0].uncertain,true);assert.equal(f.api.health().directReservations.settings,1);f.api.beginQuiesce();await assert.rejects(f.api.finalizeQuiescence(true),{code:'CONNECTION_ADMISSION_CLEANUP_UNCONFIRMED'});assert.equal(f.acknowledgements.length,0);
    }
  });
  it('keeps timed-out outcomes charged and ignores a late successful identity result',async function(){
    const f=selected();let events=0;f.client.on('connect',()=>events++);const pending=assert.rejects(f.client.connect(),{code:'CONNECTION_ADMISSION_DATABASE_UNCONFIRMED'});f.client.finishConnect();await pending;result(f.client);await turn();assert.equal(events,0);assert.equal(f.api.health().clients[0].uncertain,true);assert.equal(f.api.health().directReservations.settings,1);
  });
  it('never publishes success after end/freeze, including verification-to-delivery microtask races',async function(){
    for(const phase of ['end','freeze','delivery-freeze']) {
      const f=selected();let events=0;f.client.on('connect',()=>events++);const pending=assert.rejects(f.client.connect(),{code:phase==='end'?'CONNECTION_ADMISSION_DATABASE_UNCONFIRMED':'CONNECTION_ADMISSION_HANDSHAKE_REFUSED'});f.client.finishConnect();
      if(phase==='end') {const ending=assert.rejects(f.client.end(),{code:'CONNECTION_ADMISSION_CLEANUP_UNCONFIRMED'});f.client.finishEnd();await ending;}
      if(phase==='freeze') f.api.beginQuiesce();
      if(phase!=='end')result(f.client);if(phase==='delivery-freeze')f.api.beginQuiesce();await pending;assert.equal(events,0);assert.equal(f.api.health().clients[0].uncertain,true);
    }
  });
  it('handles synchronous verifier completion and raw connect reentrancy without duplicate success',async function(){
    const f=selected();let checks=0,events=0,callbacks=0;
    f.Client.prototype.query=function(config,callback){checks++;callback(null,{rows:[{database:'synthetic',databaseOid:'16384'}]});};
    f.client.on('connect',()=>events++);
    const pending=new Promise((resolve,reject)=>f.client.connect(error=>{callbacks++;if(error)reject(error);else resolve();}));
    f.client.finishConnect();await pending;assert.equal(checks,1);assert.equal(events,1);assert.equal(callbacks,1);
    assert.equal(f.api.health().clients[0].authenticated,true);
  });

  it('keeps legacy plan1 free of identity queries and demonstrates its unverified database boundary',async function(){
    const f=selected({planVersion:1});let events=0;f.client.on('connect',()=>events++);
    const connected=f.client.connect();f.client.finishConnect();await connected;
    assert.equal(events,1);assert.equal(f.sql.length,0,'legacy plan1 cannot establish actual backend database identity');
  });
  it('retains physical EOF retirement after successful verification and refuses pooled mismatch before onConnect',async function(){
    const f=selected(),connected=f.client.connect();f.client.finishConnect();result(f.client);await connected;
    f.api.beginQuiesce();let ended=false;const ending=f.client.end().then(()=>{ended=true;});const final=f.api.finalizeQuiescence(true);
    await turn();assert.equal(ended,false);assert.equal(f.acknowledgements.length,0);f.client.finishEnd();await ending;await final;assert.equal(f.acknowledgements.length,1);
    const g=fixture({driver:true,planVersion:2}),Pool=g.api.wrapPool(PgPool,g.Client,'synthetic-pool');let exposed=0;
    const pool=new Pool({...g.options(),onConnect:()=>{exposed++;}}),refused=assert.rejects(pool.connect(),{code:'CONNECTION_ADMISSION_DATABASE_MISMATCH'});
    const client=g.instances[0];client.finishConnect();result(client,[['foreign','16384']]);await refused;assert.equal(exposed,0);assert.equal(g.api.health().pools[0].uncertain,true);
    await assert.rejects(pool.connect(),{code:'CONNECTION_ADMISSION_CLEANUP_UNCONFIRMED'});
  });

  it('uses fixed text decoding instead of caller-provided parsers for the identity proof',async function(){
    const f=fixture({driver:true,planVersion:2}),Client=f.api.wrapClient(f.Client,'settings-readiness');
    let parserReads=0;const types={getTypeParser:()=>{const index=++parserReads;return ()=> index===1?'synthetic':'16384';}};
    const options={host:'synthetic-pg',ssl:false,types},client=new Client(options);
    const connected=assert.rejects(client.connect(),{code:'CONNECTION_ADMISSION_DATABASE_MISMATCH'});client.finishConnect();result(client,[['foreign','999']]);await connected;
    assert.equal(parserReads,0,'identity decoding cannot consult caller type hooks');assert.equal(options.types,types);
  });

  it('copies the sealed expectation and refuses conflicting synchronous connect outcomes',async function(){
    const f=selected();f.plan.workerDatabase.database='foreign';const pending=f.client.connect();f.client.finishConnect();result(f.client);await pending;
    const g=selected();g.Client.prototype.query=function(config,callback){callback(null,{rows:[{database:'synthetic',databaseOid:'16384'}]});};
    const raw=g.Client.prototype.connect;g.Client.prototype.connect=function(callback){raw.call(this,callback);this.finishConnect();throw Error('PRIVATE');};
    let events=0;g.client.on('connect',()=>events++);await assert.rejects(g.client.connect(),{code:'CONNECTION_ADMISSION_HANDSHAKE_REFUSED'});assert.equal(events,0);assert.equal(g.api.health().clients[0].uncertain,true);
  });

});


describe('plan2 primitive authority boundary',function(){
  const arrays=[['processInstanceId'],['incarnation'],['nonce'],['planSha256'],['pgResourceId'],['source','coreCommit'],['source','deployCommit']];
  it('refuses serialized equal-content arrays and nonstring identities before state publication or actual pg construction',function(){
    const cases=arrays.map(keys=>({keys,change:value=>[value]}));
    cases.push({keys:['processInstanceId'],change:()=>true},{keys:['pgResourceId'],change:()=>true},{keys:['pgResourceId'],change:()=>123.5});
    for(const {keys,change} of cases)for(const kind of ['client','pool']){
      let states=0,constructors=0,refusal=null;
      try {
        const f=fixture({driver:true,planVersion:2,serialized:true,onState:()=>{states++;},alterPlan:plan=>{const parent=keys.slice(0,-1).reduce((value,key)=>value[key],plan),key=keys.at(-1);parent[key]=change(parent[key]);}});
        if(kind==='client'){const Client=f.api.wrapClient(f.Client,'settings-readiness');new Client({host:'synthetic-pg',ssl:false});constructors=f.instances.length;}
        else {class Pool extends PgPool {constructor(options){super(options);constructors++;}}const Selected=f.api.wrapPool(Pool,f.Client,'synthetic-pool');new Selected(f.options());}
      }catch(error){refusal=error.code;}
      assert.deepEqual({refusal,states,constructors},{refusal:'CONNECTION_ADMISSION_PLAN_INVALID',states:0,constructors:0},'primitive boundary '+keys.join('.')+' '+kind);
    }
  });
  it('rejects malformed consumed containers and extra source keys but permits opaque fixed control metadata',function(){
    for(const alterPlan of [p=>{p.source=[p.source];},p=>{p.source.extra='not-admitted';},p=>{p.workerDatabase=[p.workerDatabase];},p=>{p.workerDatabase.extra='not-admitted';},p=>{p.resourceAliases=[['synthetic-pg:5432']];},p=>{p.capabilities=[];},p=>{p.directGroups=[];}]) {
      let states=0;assert.throws(()=>fixture({planVersion:2,serialized:true,onState:()=>{states++;},alterPlan}),{code:'CONNECTION_ADMISSION_PLAN_INVALID'});assert.equal(states,0);
    }
    const f=fixture({planVersion:2,serialized:true,alterPlan:p=>{p.control={fixed:'opaque-controller-metadata'};}});
    assert.equal(f.api.health().processInstanceId,'synthetic-api');
  });
  it('refuses nonprimitive plan2 tag incarnations before any coercion while valid legacy tags stay identical',function(){
    const api=admission(),incarnation='a'.repeat(32),legacy=api.applicationTag({version:1,incarnation},'settings-readiness');
    assert.equal(api.applicationTag({version:2,incarnation},'settings-readiness'),legacy);
    for(const bad of [[incarnation],true,1.5,null,{}])assert.throws(()=>api.applicationTag(JSON.parse(JSON.stringify({version:2,incarnation:bad})),'settings-readiness'),{code:'CONNECTION_ADMISSION_PLAN_INVALID'});
  });
});

describe('source-owned settings pool construction',function(){
  it('lets selected admission supply the tracked fixed driver without a caller Client option',async function(){
    const protocol=require('../lib/storage/postgres-settings-protocol'),sentinel=Error('synthetic constructor stop');let reached=false;
    const f=fixture({driver:true,planVersion:2,alterPlan:plan=>{
      plan.capabilities={'nightscout-display-settings':{kind:'pool',poolMax:1,maxInstances:1,metadata:{requestedMaximum:1}}};plan.directGroups={};
    }});
    class Pool{constructor(options){reached=true;assert(options.Client.prototype instanceof protocol.Client);throw sentinel;}}
    const filename=path.resolve(__dirname,'../lib/storage/postgres-connection.js'),loaded=new Module(filename,module);
    loaded.filename=filename;loaded.paths=Module._nodeModulePaths(path.dirname(filename));const original=loaded.require.bind(loaded);
    loaded.require=name=>name==='./connection-admission'?f.api:name==='pg'?{Pool,Client:require('pg').Client}:original(name);
    loaded._compile(fs.readFileSync(filename,'utf8'),filename);
    await assert.rejects(loaded.exports({connectionString:'postgres://synthetic:synthetic@synthetic-pg/synthetic',direct:true,displaySettings:true,
      application_name:'nightscout-display-settings',max:1}),error=>error===sentinel);
    assert.equal(reached,true);assert.equal(f.instances.length,0);
  });
});

describe('assertion-only actual admitted recovery transaction',function(){
  async function selected({planVersion=2,className='realtime-recovery',name='realtime-recovery',settingsDriver=false,extraCapabilities=false}={}){
    const f=fixture({driver:true,settingsDriver,planVersion,poolMax:1,requestedMaximum:1,alterPlan:plan=>{
      plan.processInstanceId='realtime-recovery';
      plan.capabilities={[name]:{kind:'pool',poolMax:1,maxInstances:1,metadata:{requestedMaximum:1}}};if(extraCapabilities)plan.capabilities['another-bounded-pool']={kind:'pool',poolMax:1,maxInstances:1,metadata:{requestedMaximum:1}};plan.directGroups={};
      plan.control={version:2,class:className,resourceEpoch:['123','synthetic-epoch'],principal:{role:'synthetic_reader',roleOid:'123',database:'synthetic',databaseOid:'16384'}};
    }});
    const Pool=f.api.wrapPool(PgPool,f.Client,name),pool=new Pool(f.api.poolOptions(name,{host:'synthetic-pg',ssl:false,max:1,idleTimeoutMillis:0}));
    const pending=pool.connect(),client=f.instances[0];client.on('error',()=>{});client.finishConnect();
    if(planVersion===2){client.connection.emit('rowDescription',{fields:['database','databaseOid'].map(name=>({name,dataTypeID:25,format:'text'}))});client.connection.emit('dataRow',{fields:['synthetic','16384'].map(v=>Buffer.from(v))});client.connection.emit('commandComplete',{text:'SELECT 1'});client.connection.emit('readyForQuery',{status:'I'});}
    assert.strictEqual(await pending,client);
    const finish=(status='T')=>{client.connection.emit('commandComplete',{text:'SELECT 1'});client.connection.emit('readyForQuery',{status});};
    const begin=async()=>{const q=client.query('BEGIN READ ONLY');finish();await q;};
    const close=async()=>{client.release();const ended=pool.end();client.finishEnd();await ended;};
    return{...f,pool,client,finish,begin,close};
  }
  it('accepts only completed actual protocol T with same admitted plan2 backend and never changes ACK/health',async function(){
    const f=await selected();assert.throws(()=>f.api.assertRecoveryTransaction(f.client),{code:'CONNECTION_ADMISSION_RECOVERY_TRANSACTION_REQUIRED'});
    await f.begin();const before=f.api.health(),proof=f.api.assertRecoveryTransaction(f.client);assert.deepEqual(f.api.health(),before);assert.deepEqual(proof.database,{database:'synthetic',databaseOid:'16384'});assert(Object.isFrozen(proof));assert.equal(f.acknowledgements.length,0);
    const q=f.client.query('SELECT 1');assert.throws(()=>f.api.assertRecoveryTransaction(f.client));f.finish();await q;assert.doesNotThrow(()=>f.api.assertRecoveryTransaction(f.client));
    for(const status of ['E','I','unknown']){f.client.connection.emit('readyForQuery',{status});f.client.readyStatus='T';assert.throws(()=>f.api.assertRecoveryTransaction(f.client));}
    f.client.connection.emit('readyForQuery',{status:'T'});assert.doesNotThrow(()=>f.api.assertRecoveryTransaction(f.client));await f.close();assert.throws(()=>f.api.assertRecoveryTransaction(f.client));
  });
  it('refuses foreign/manual clients, wrong capability/class, legacy plan and frozen admitted constructors',async function(){
    for(const options of [{planVersion:1},{className:'lifecycle-operator'},{name:'synthetic-pool'},{}]){
      const f=await selected(options);await f.begin();assert.throws(()=>f.api.assertRecoveryTransaction(new f.Client({host:'synthetic-pg',ssl:false})));
      if(!Object.keys(options).length){assert.doesNotThrow(()=>f.api.assertRecoveryTransaction(f.client));f.api.beginQuiesce();}
      assert.throws(()=>f.api.assertRecoveryTransaction(f.client));await f.close();
    }
  });
  it('checks exact selected display pool and actual-driver T without the recovery single-capability restriction',async function(){
    const protocol=require('../lib/storage/postgres-settings-protocol');
    for(const planVersion of [1,2]){
      const f=await selected({name:'nightscout-display-settings',settingsDriver:true,extraCapabilities:true,planVersion});
      try{
        assert.throws(()=>f.api.assertDisplaySettingsTransaction(f.client));await f.begin();protocol.assertTransaction(f.client);
        const before=f.api.health(),proof=f.api.assertDisplaySettingsTransaction(f.client);assert.deepEqual(f.api.health(),before);
        assert.equal(proof.version,planVersion);assert.deepEqual(proof.database,planVersion===2?{database:'synthetic',databaseOid:'16384'}:null);
        assert.throws(()=>f.api.assertDisplaySettingsTransaction(new f.Client({host:'synthetic-pg',ssl:false})));
        assert.throws(()=>f.api.assertRecoveryTransaction(f.client));
        const q=f.client.query('SELECT display_error'),failed=assert.rejects(q);f.client.connection.emit('errorMessage',Object.assign(Error('synthetic'),{code:'40001'}));await failed;
        f.client.readyForQuery=true;assert.throws(()=>f.api.assertDisplaySettingsTransaction(f.client));assert.throws(()=>protocol.assertTransaction(f.client));f.client.readyForQuery=false;
        f.client.connection.emit('readyForQuery',{status:'E'});assert.throws(()=>f.api.assertDisplaySettingsTransaction(f.client));
        const rollback=f.client.query('ROLLBACK');f.finish('I');await rollback;await f.begin();f.api.assertDisplaySettingsTransaction(f.client);
        f.api.beginQuiesce();assert.throws(()=>f.api.assertDisplaySettingsTransaction(f.client));
      }finally{await f.close();}
      assert.throws(()=>f.api.assertDisplaySettingsTransaction(f.client));
    }
    const wrong=await selected();try{await wrong.begin();assert.throws(()=>wrong.api.assertDisplaySettingsTransaction(wrong.client));wrong.api.assertRecoveryTransaction(wrong.client);}finally{await wrong.close();}
  });
  function activity(f,options={}){
    const tenantScope=require('../lib/storage/tenant-scope'),filename=path.resolve(__dirname,'../lib/realtime-placement/activity.js'),loaded=new Module(filename,module);
    loaded.filename=filename;loaded.paths=Module._nodeModulePaths(path.dirname(filename));loaded.require=function(name){return name==='../storage/connection-admission'?f.api:Module.prototype.require.call(this,name);};loaded._compile(fs.readFileSync(filename,'utf8'),filename);
    const A='11111111-1111-4111-8111-111111111111',META='00000000-0000-0000-0000-000000000000',calls=[];let parsed,values,release,sessionIsolation=options.sessionIsolation||'read committed';
    function reply(rows){
      const names=Object.keys(rows[0]||{});if(names.length){f.client.connection.emit('rowDescription',{fields:names.map(name=>({name,dataTypeID:typeof rows[0][name]==='boolean'?16:typeof rows[0][name]==='number'?23:typeof rows[0][name]==='object'&&rows[0][name]!==null?114:25,format:'text'}))});for(const row of rows)f.client.connection.emit('dataRow',{fields:names.map(name=>row[name]===null?null:typeof row[name]==='object'?JSON.stringify(row[name]):typeof row[name]==='boolean'?(row[name]?'t':'f'):String(row[name]))});}
      f.client.connection.emit('commandComplete',{text:'SELECT '+rows.length});f.client.connection.emit('readyForQuery',{status:'T'});
    }
    function respond(text,args){
      calls.push({text,values:args,tenant:tenantScope.currentTenant()});
      if(text==='BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY')sessionIsolation='read committed';
      if(options.cleanupFail&&text.startsWith("SELECT set_config('app.current_tenant_id'")&&args?.[0]===META&&calls.filter(c=>c.values?.[0]===META).length>1){queueMicrotask(()=>f.client.connection.emit('error',Object.assign(Error('synthetic cleanup transport'),{code:'SYNTHETIC_CLEANUP'})));return;}
      const send=()=>{
        const custom=options.handler?.(text,args);if(custom)return reply(custom.rows);
        if(text.startsWith('SELECT p.proname AS name')){const functions=require('../lib/tenant-registry/postgres').FUNCTIONS;return reply(Object.entries(functions).map(([name,fn])=>({name,prosecdef:true,proconfig:[...(fn.binds?['app.current_tenant_id=']:[]),'search_path=synthetic_registry, pg_catalog'],lanname:'plpgsql',result:fn.result,prosrc:fn.body,rolcanlogin:false,rolsuper:false,rolbypassrls:false,nspname:'synthetic_registry',owns_tables:true,public_execute:false,...options.registryDrift})));}
        if(text.startsWith('SELECT f.version')){const version=options.registryVersion||'1',admitted=args?.[3]===version,page=text.includes('LEFT JOIN LATERAL');return reply(page?(admitted?[{version,revision:version,tenant:A}]:[{version,revision:null,tenant:null}]):[{version,revision:admitted?version:null}]);}
        if(text.includes('current_user AS role')){const row={role:'synthetic_reader',roleOid:'123',database:'synthetic',databaseOid:'16384',epoch:'synthetic-epoch',pid:f.client.processID,birth:'synthetic-backend-birth',readOnly:'on',rolsuper:false,rolbypassrls:false,...options.identity};if(text.includes("current_setting('transaction_isolation')"))row.isolation=options.identity&&Object.hasOwn(options.identity,'isolation')?options.identity.isolation:sessionIsolation;else delete row.isolation;return reply([row]);}
        if(text.includes('FROM pg_class'))return reply(options.screen||[{current_state:true,secured:true,owns:false,reads:true,inserts:false,destroys:false,updates:[]},{current_state:false,secured:true,owns:false,reads:false,inserts:false,destroys:false,updates:[]}]);
        if(text.startsWith('SELECT version::text')){if(options.failQuery){f.client.connection.emit('errorMessage',Object.assign(Error('synthetic source SQL failure'),{code:'SYNTHETIC_QUERY'}));if(!options.delayReady)f.client.connection.emit('readyForQuery',{status:'E'});return;}return reply(options.rows||[{version:'1',paused:false,suspended:false}]);}
        return reply([]);
      };
      if(options.hold&&text.startsWith('SELECT version::text')||options.holdRegistry&&text.startsWith('SELECT f.version')||options.holdExternal&&text==='SELECT untracked')release=send;else queueMicrotask(send);
    }
    f.client.connection.query=text=>respond(text);f.client.connection.parse=config=>{parsed=config.text;};f.client.connection.bind=config=>{values=config.values;};f.client.connection.execute=()=>respond(parsed,values);
    // Exact actual-driver backend identity is supplied by pg BackendKeyData.
    f.client.processID=123;
    return{A,META,calls,scope:tenantScope,module:loaded.exports,open:()=>loaded.exports.create({client:f.client,namespace:'synthetic_lifecycle',registryNamespace:'synthetic_registry',tenants:[A]}),release:()=>{assert(release);release();}};
  }
  it('fixed activity screen and canonical tenant GUC share the actual admitted transaction; active/pause/suspend stay distinct',async function(){
    const tenantScope=require('../lib/storage/tenant-scope');tenantScope.setTenancyMode('multi');
    try{for(const flags of [{paused:false,suspended:false,state:'active'},{paused:true,suspended:false,state:'paused'},{paused:false,suspended:true,state:'suspended'}]){
      const f=await selected();await f.begin();const a=activity(f,{rows:[{version:'2',paused:flags.paused,suspended:flags.suspended}]}),r=await a.open();
      const row=await r.readActivity(a.A);assert.equal(row.state,flags.state);assert.equal(a.calls.find(c=>c.text.startsWith('SELECT version')).tenant,a.A);assert.deepEqual(a.calls.at(-1).values,[a.META]);assert.equal(a.scope.currentTenant(),undefined);
      assert.equal(a.calls.filter(c=>/BEGIN|COMMIT/.test(c.text)).length,0);assert.equal(f.instances.length,1);await r.finish();const n=a.calls.length;await assert.rejects(r.readActivity(a.A),{code:'REALTIME_RECOVERY_ACTIVITY_CLOSED'});assert.equal(a.calls.length,n);await f.close();
    }}finally{tenantScope.setTenancyMode('single');}
  });
  it('fresh fixed identity and capability screens reject elevated/wrong-epoch/read-write/RLS/grant/owner drift',async function(){
    const tenantScope=require('../lib/storage/tenant-scope');tenantScope.setTenancyMode('multi');
    try{for(const options of [{identity:{rolsuper:true}},{identity:{rolbypassrls:true}},{identity:{epoch:'foreign'}},{identity:{databaseOid:'999'}},{identity:{readOnly:'off'}},...[{secured:false},{owns:true},{inserts:true},{updates:['paused']}].map(change=>({screen:[{current_state:true,secured:true,owns:false,reads:true,inserts:false,destroys:false,updates:[],...change},{current_state:false,secured:true,owns:false,reads:false,inserts:false,destroys:false,updates:[]}]}))]){
      const f=await selected();await f.begin();const a=activity(f,options);await assert.rejects(a.open());await f.close();
    }}finally{tenantScope.setTenancyMode('single');}
  });
  it('unawaited/concurrent reads drain before rollback eligibility and cannot dispatch a late GUC after scope closure',async function(){
    const tenantScope=require('../lib/storage/tenant-scope');tenantScope.setTenancyMode('multi');
    try{for(const concurrent of [false,true]){
      const f=await selected();await f.begin();const a=activity(f,{hold:true}),r=await a.open(),p=r.readActivity(a.A),rejected=assert.rejects(p);
      await turn();assert(a.calls.at(-1).text.startsWith('SELECT version'));if(concurrent)await assert.rejects(r.readActivity(a.A),{code:'REALTIME_RECOVERY_ACTIVITY_CONCURRENT'});
      const finish=r.finish(),refusal=assert.rejects(finish,{code:concurrent?'REALTIME_RECOVERY_ACTIVITY_CONCURRENT':'REALTIME_RECOVERY_ACTIVITY_UNAWAITED'});assert.equal(r.rollbackSafe(),false);a.release();await rejected;await refusal;
      assert.equal(r.rollbackSafe(),true);assert.deepEqual(a.calls.at(-1).values,[a.META]);const before=a.calls.length;await assert.rejects(r.readActivity(a.A));assert.equal(a.calls.length,before);await f.close();
    }}finally{tenantScope.setTenancyMode('single');}
  });
  it('foreign/ambient tenant and unavailable activity poison the scope rather than fabricate a deferred state',async function(){
    const tenantScope=require('../lib/storage/tenant-scope');tenantScope.setTenancyMode('multi');
    try{for(const mode of ['foreign','ambient','missing','unknown']){
      const f=await selected();await f.begin();const a=activity(f,mode==='missing'?{rows:[]}:mode==='unknown'?{rows:[{version:'1',paused:'unknown',suspended:false}]}:{}),r=await a.open();
      const p=mode==='ambient'?tenantScope.withTenant(a.A,()=>r.readActivity(a.A)):r.readActivity(mode==='foreign'?'22222222-2222-4222-8222-222222222222':a.A);await assert.rejects(p);await assert.rejects(r.finish());await f.close();
    }}finally{tenantScope.setTenancyMode('single');}
  });

  it('actual publisher prevents COMMIT on unawaited/concurrent work, drains GUC before rollback and preserves callback primary error',async function(){
    const tenantScope=require('../lib/storage/tenant-scope'),fsp=require('node:fs/promises'),os=require('node:os'),protocol=require('./fixtures/operation-window-admission-protocol'),maps=require('./fixtures/realtime-placement-map');
    const directory=await fsp.mkdtemp(path.join(os.tmpdir(),'rt-activity-publication-'));tenantScope.setTenancyMode('multi');
    try{for(const mode of ['ready','unawaited','concurrent','primary','late','registry','external']){
      const f=await selected(),metadata=protocol(),file=path.join(directory,'map.json'),original={...maps.config(),version:2},candidate={...maps.move(original,'a'),version:2};await fsp.writeFile(file,JSON.stringify(original));
      let lateReader,late,external;const activityOptions={sessionIsolation:'repeatable read',hold:!['ready','late','registry','external'].includes(mode),holdExternal:mode==='external',handler:(text,args)=>{
        if(text==='COMMIT'&&mode==='late'){late=lateReader.readActivity(a.A);late.catch(()=>{});}
        if(text.includes('operation-window-'))return metadata(text,args);
        if(text.startsWith('SELECT pg_try_advisory'))return{rows:[{held:true}]};
        if(text.startsWith('SELECT phase,lock_key'))return{rows:[{phase:'active',lock_key:require('../lib/tenant-registry/rules').lockKey(args[0])}]};
      }};const a=activity(f,activityOptions);
      const filename=path.resolve(__dirname,'../lib/realtime-placement/publish.js'),loaded=new Module(filename,module);loaded.filename=filename;loaded.paths=Module._nodeModulePaths(path.dirname(filename));loaded.require=function(name){return name==='./activity'?a.module:name==='../storage/connection-admission'?f.api:Module.prototype.require.call(this,name);};loaded._compile(fs.readFileSync(filename,'utf8'),filename);
      const primary=Error('synthetic callback primary');let child,externalStarted;const externalBegun=new Promise(resolve=>{externalStarted=resolve;});
      const options={file,candidate,internal:maps.internal,client:f.client,consumer:'realtime-stable',source:{NS_REALTIME_OWNERSHIP_CONTRACT:'assignment-v2'},controlNamespace:'synthetic_window',registryNamespace:'synthetic_registry',confirmStopped:async()=>true,recoveryLimits:{maxLogicalMoves:1,maxAssignmentChanges:8,maxAffectedTenants:1},afterAssignment:async(result,reader)=>{
        if(mode==='registry'){activityOptions.holdRegistry=true;activityOptions.registryVersion='2';child=reader.registry.revision();child.catch(()=>{});await turn();setImmediate(()=>a.release());return;}
        child=reader.readActivity(a.A);child.catch(()=>{});
        if(['ready','late','external'].includes(mode)){assert.equal((await child).state,'active');lateReader=reader;if(mode==='external'){external=f.client.query('SELECT untracked');external.catch(()=>{});externalStarted();}return;}
        await turn();if(mode==='concurrent')await assert.rejects(reader.readActivity(a.A),{code:'REALTIME_RECOVERY_ACTIVITY_CONCURRENT'});
        setImmediate(()=>a.release());if(mode==='primary')throw primary;
      }};
      const published=loaded.exports.publishRecoveryActivity(options);published.catch(()=>{});
      if(mode==='external'){await externalBegun;await turn();assert(!f.client._queryQueue.some(q=>q.text==='COMMIT'),'NO_COMMIT_QUEUED_BEHIND_UNTRACKED_QUERY');}
      if(mode==='ready')await published;else await assert.rejects(published,error=>mode==='primary'?error===primary:error.code===(mode==='external'?'CONNECTION_ADMISSION_RECOVERY_TRANSACTION_REQUIRED':mode==='late'?'REALTIME_RECOVERY_ACTIVITY_CLOSED':mode==='concurrent'?'REALTIME_RECOVERY_ACTIVITY_CONCURRENT':'REALTIME_RECOVERY_ACTIVITY_UNAWAITED'));
      const sql=a.calls.map(c=>c.text);assert.equal(sql[0],'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY','SELECTED_PUBLICATION_MUST_OVERRIDE_SESSION_SNAPSHOT');assert.equal(sql.includes('COMMIT'),['ready','late'].includes(mode));assert.equal(sql.includes('ROLLBACK'),!['ready','late','external'].includes(mode));assert.equal(f.instances.length,1);
      if(mode==='late'){await assert.rejects(late);assert.equal(sql.at(-1),'COMMIT','late callback emits no GUC after COMMIT');}
      if(mode==='external'){a.release();await external;assert(!sql.includes('COMMIT')&&!sql.includes('ROLLBACK'));}
      if(!['ready','late','external'].includes(mode)){await assert.rejects(child);const rollback=sql.indexOf('ROLLBACK');assert.deepEqual(a.calls[rollback-1].values,[a.META]);}
      await f.close();
    }}finally{tenantScope.setTenancyMode('single');await fsp.rm(directory,{recursive:true});}
  });

  it('failed physical GUC cleanup retains primary error, refuses rollback dispatch and cannot produce a clean ACK',async function(){
    const tenantScope=require('../lib/storage/tenant-scope');tenantScope.setTenancyMode('multi');
    try{const f=await selected();await f.begin();const a=activity(f,{cleanupFail:true,rows:[]}),r=await a.open();let primary;
      await assert.rejects(r.readActivity(a.A),error=>{primary=error;return error.code==='ACTIVITY_NOT_PROVISIONED'&&error.cleanupError?.code==='SYNTHETIC_CLEANUP';});
      await assert.rejects(r.finish(),error=>error===primary);assert.equal(r.rollbackSafe(),false);assert.equal(r.cleanupError.code,'SYNTHETIC_CLEANUP');assert(!a.calls.some(c=>c.text==='ROLLBACK'||c.text==='COMMIT'));assert(f.api.health().unconfirmedCleanup);assert.equal(f.acknowledgements.length,0);await assert.rejects(f.close());
    }finally{tenantScope.setTenancyMode('single');}
  });

  it('unawaited source-query failure is retained alongside the closure error without a late rollback',async function(){
    const tenantScope=require('../lib/storage/tenant-scope');tenantScope.setTenancyMode('multi');
    try{const f=await selected();await f.begin();const a=activity(f,{hold:true,failQuery:true}),r=await a.open(),work=r.readActivity(a.A),failed=assert.rejects(work,{code:'SYNTHETIC_QUERY'});await turn();
      const ended=r.finish(),proof=assert.rejects(ended,error=>error.code==='REALTIME_RECOVERY_ACTIVITY_UNAWAITED'&&error.activityWorkError?.code==='SYNTHETIC_QUERY'&&error.activityWorkError.cleanupError?.code==='CONNECTION_ADMISSION_RECOVERY_TRANSACTION_REQUIRED');a.release();await failed;await proof;assert.equal(r.rollbackSafe(),false);assert(!a.calls.some(c=>c.text==='ROLLBACK'||c.text==='COMMIT'));await f.close();
    }finally{tenantScope.setTenancyMode('single');}
  });

  it('packet-split ErrorResponse cannot reuse last T while actual ReadyForQuery is still outstanding',async function(){
    const f=await selected();await f.begin();const q=f.client.query('SELECT controlled_failure'),failed=assert.rejects(q,{code:'40001'});f.client.connection.emit('errorMessage',Object.assign(Error('controlled'),{code:'40001'}));await failed;
    assert.equal(f.client.readyForQuery,false);assert.equal(f.client._getActiveQuery(),null);assert.equal(f.client._queryQueue.length,0);assert.throws(()=>f.api.assertRecoveryTransaction(f.client));
    f.client.readyForQuery=true;assert.throws(()=>f.api.assertRecoveryTransaction(f.client),'caller mutation of driver flag cannot manufacture a private Ready packet');f.client.readyForQuery=false;
    await turn();assert.throws(()=>f.api.assertRecoveryTransaction(f.client));f.client.connection.emit('readyForQuery',{status:'E'});assert.throws(()=>f.api.assertRecoveryTransaction(f.client));
    const rollback=f.client.query('ROLLBACK');f.finish('I');await rollback;assert.throws(()=>f.api.assertRecoveryTransaction(f.client));await f.begin();assert.doesNotThrow(()=>f.api.assertRecoveryTransaction(f.client));await f.close();
  });
  it('queued and pipelined protocol work cannot pass the fixed scalar transaction assertion',async function(){
    const f=await selected();await f.begin();const first=f.client.query('SELECT first'),second=f.client.query('SELECT second');f.finish();await first;assert.throws(()=>f.api.assertRecoveryTransaction(f.client));f.finish();await second;assert.doesNotThrow(()=>f.api.assertRecoveryTransaction(f.client));
    f.client.pipeline=true;assert.throws(()=>f.api.assertRecoveryTransaction(f.client));f.client.pipeline=false;await f.close();
  });
  it('delayed Ready after an activity ErrorResponse admits neither cleanup GUC nor rollback into the protocol gap',async function(){
    const tenantScope=require('../lib/storage/tenant-scope');tenantScope.setTenancyMode('multi');
    try{const f=await selected();await f.begin();const a=activity(f,{hold:true,failQuery:true,delayReady:true}),r=await a.open(),q=r.readActivity(a.A),failed=assert.rejects(q,{code:'SYNTHETIC_QUERY'});await turn();a.release();await failed;await assert.rejects(r.finish());
      assert.equal(f.client.readyForQuery,false);assert.equal(r.rollbackSafe(),false);assert.equal(f.client._queryQueue.length,0);assert.equal(a.calls.filter(c=>c.values?.[0]===a.META).length,1,'only the initial metadata binding was sent');assert(!a.calls.some(c=>c.text==='ROLLBACK'||c.text==='COMMIT'));
      f.client.connection.emit('readyForQuery',{status:'E'});assert.equal(r.rollbackSafe(),false);await f.close();
    }finally{tenantScope.setTenancyMode('single');}
  });

  it('plan2 started termination before actual Ready stays uncertain despite later peer EOF, with no clean ACK',async function(){
    const f=await selected();await f.begin();const q=f.client.query('SELECT controlled_failure'),failed=assert.rejects(q);f.client.connection.emit('errorMessage',Object.assign(Error('controlled'),{code:'40001'}));await failed;assert.equal(f.client.readyForQuery,false);assert.equal(f.client._getActiveQuery(),null);
    await assert.rejects(f.close(),{code:'CONNECTION_ADMISSION_CLEANUP_UNCONFIRMED'});assert.equal(f.client.connection.stream.terminateWrites,1,'actual driver still sent Terminate but it is not qualified as clean');f.api.beginQuiesce();await assert.rejects(f.api.finalizeQuiescence(true));assert.equal(f.acknowledgements.length,0);assert(f.api.health().unconfirmedCleanup);
  });
  it('plan2 actual Ready I/T/E and never-connected clients retain normal physical closure',async function(){
    for(const status of ['I','T','E']){const f=await selected();if(status!=='I')await f.begin();if(status==='E'){const q=f.client.query('SELECT controlled_failure'),failed=assert.rejects(q);f.client.connection.emit('errorMessage',Object.assign(Error('controlled'),{code:'40001'}));await failed;f.client.connection.emit('readyForQuery',{status:'E'});}await f.close();f.api.beginQuiesce();await f.api.finalizeQuiescence(true);assert.equal(f.acknowledgements.length,1);}
    const f=fixture({driver:true,planVersion:2}),Client=f.api.wrapClient(f.Client,'settings-readiness'),client=new Client({host:'synthetic-pg',ssl:false});await client.end();f.api.beginQuiesce();await f.api.finalizeQuiescence(true);assert.equal(client.connection.stream.terminateWrites,0);assert.equal(f.acknowledgements.length,1);
  });

  it('legacy plan1 retains its measured packet-gap retirement behavior without adopting plan2 proof',async function(){
    const f=await selected({planVersion:1});await f.begin();const q=f.client.query('SELECT controlled_failure'),failed=assert.rejects(q);f.client.connection.emit('errorMessage',Object.assign(Error('controlled'),{code:'40001'}));await failed;assert.equal(f.client.readyForQuery,false);await f.close();f.api.beginQuiesce();await f.api.finalizeQuiescence(true);assert.equal(f.acknowledgements.length,1,'legacy behavior retained, not relabeled plan2 evidence');
  });

  it('same-client registry revision/page retain actual fresh function-version screens and metadata ALS/GUC',async function(){
    const tenantScope=require('../lib/storage/tenant-scope');tenantScope.setTenancyMode('multi');
    try{const f=await selected();await f.begin();const options={},a=activity(f,options),r=await a.open();assert.equal(await r.registry.revision(),'1');assert.deepEqual(await r.registry.page(null,2),{revision:'1',tenants:[a.A]});
      assert.equal(a.calls.filter(c=>c.text.startsWith('SELECT p.proname AS name')).length,1);assert(a.calls.filter(c=>c.text.startsWith('SELECT f.version')).every(c=>c.tenant===a.META));
      options.registryVersion='2';assert.equal(await r.registry.revision(),'2');assert.equal(a.calls.filter(c=>c.text.startsWith('SELECT p.proname AS name')).length,2);
      options.registryVersion='3';options.registryDrift={public_execute:true};await assert.rejects(r.registry.revision(),{code:'TENANT_REGISTRY_FUNCTION_UNSAFE'});await assert.rejects(r.finish());assert.equal(f.instances.length,1);await f.close();
    }finally{tenantScope.setTenancyMode('single');}
  });
  it('malformed/unsupported registry methods refuse before SQL and closed metadata callbacks cannot dispatch',async function(){
    const tenantScope=require('../lib/storage/tenant-scope');tenantScope.setTenancyMode('multi');
    try{for(const mode of ['alias','lookup','attributes','enumerate','scanTenants','page','revision','closed']){const f=await selected();await f.begin();const a=activity(f),r=await a.open(),before=a.calls.length;
      if(mode==='closed'){await r.finish();await assert.rejects(r.registry.revision(),{code:'REALTIME_RECOVERY_ACTIVITY_CLOSED'});}else if(mode==='page')await assert.rejects(r.registry.page('bad',2));else if(mode==='revision')await assert.rejects(r.registry.revision('ignored'));else assert.throws(()=>r.registry[mode](),{code:'REALTIME_RECOVERY_REGISTRY_METHOD'});
      assert.equal(a.calls.length,before);if(mode!=='closed')await assert.rejects(r.finish());await f.close();
    }}finally{tenantScope.setTenancyMode('single');}
  });
  it('detached registry multi-await work shares the activity drain and cannot dispatch its later catalogue check',async function(){
    const tenantScope=require('../lib/storage/tenant-scope');tenantScope.setTenancyMode('multi');
    try{for(const concurrent of [false,true]){const f=await selected();await f.begin();const a=activity(f,{holdRegistry:true}),r=await a.open(),q=r.registry.revision(),failed=assert.rejects(q);await turn();
      if(concurrent)await assert.rejects(r.readActivity(a.A),{code:'REALTIME_RECOVERY_ACTIVITY_CONCURRENT'});const end=r.finish(),refused=assert.rejects(end,{code:concurrent?'REALTIME_RECOVERY_ACTIVITY_CONCURRENT':'REALTIME_RECOVERY_ACTIVITY_UNAWAITED'});assert.equal(r.rollbackSafe(),false);a.release();await failed;await refused;
      assert.equal(a.calls.filter(c=>c.text.startsWith('SELECT p.proname AS name')).length,0,'no second registry await dispatched after closure');assert.deepEqual(a.calls.at(-1).values,[a.META]);assert.equal(r.rollbackSafe(),true);await f.close();
    }}finally{tenantScope.setTenancyMode('single');}
  });

  it('actual registry function-body/owner/search-path/public-grant drift refuses through the same-client adapter',async function(){
    const tenantScope=require('../lib/storage/tenant-scope');tenantScope.setTenancyMode('multi');
    try{for(const drift of [{prosrc:'unsafe-body'},{prosecdef:false},{rolcanlogin:true},{rolbypassrls:true},{owns_tables:false},{nspname:'other_namespace'},{proconfig:['search_path=public']},{public_execute:true}]){const f=await selected();await f.begin();const a=activity(f,{registryDrift:drift}),r=await a.open();await assert.rejects(r.registry.revision(),{code:'TENANT_REGISTRY_FUNCTION_UNSAFE'});await assert.rejects(r.finish());await f.close();}}
    finally{tenantScope.setTenancyMode('single');}
  });

  it('same-backend scope refuses non-READ-COMMITTED or missing actual isolation observation',async function(){
    const tenantScope=require('../lib/storage/tenant-scope');tenantScope.setTenancyMode('multi');
    try{for(const options of [{sessionIsolation:'repeatable read'},{sessionIsolation:'serializable'},{identity:{isolation:null}}]){const f=await selected();await f.begin();const a=activity(f,options);await assert.rejects(a.open(),{code:'REALTIME_RECOVERY_ACTIVITY_IDENTITY'});await f.close();}}
    finally{tenantScope.setTenancyMode('single');}
  });

});
