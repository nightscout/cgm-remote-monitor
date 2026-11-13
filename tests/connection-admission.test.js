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
function actualDriver(instances){
  return class RecordingClient extends require('pg').Client {
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
function fixture ({ onState, onQuiescent, poolMax = 2, requestedMaximum = 2, clientKind = 'client', transform, driver = false, directConcurrency = 2 } = {}) {
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
  if(driver)Client=actualDriver(instances);
  const plan = { version: 1, processInstanceId: 'synthetic-api', incarnation: 'a'.repeat(32), nonce: 'b'.repeat(32), planSha256: 'c'.repeat(64), pgResourceId: 'synthetic-pg', resourceAliases: ['synthetic-pg:5432'],
    source: { coreCommit: 'd'.repeat(40), deployCommit: 'e'.repeat(40) },
    capabilities: { 'synthetic-pool': { kind: 'pool', poolMax, maxInstances: 1, metadata: { requestedMaximum, source: 'synthetic:1', configurationSource: 'explicit-profile' } },
      'settings-readiness': { kind: clientKind, directGroup: 'settings', metadata: { source: 'synthetic:2' } },
      'migration-direct': { kind: clientKind, directGroup: 'settings', metadata: { source: 'synthetic:3' } } }, directGroups: { settings: directConcurrency }, cold:{activeLimit:1,pendingLimit:2,minDelayMs:0,maxDelayMs:0} };
  api.install(plan, { onState: value => { states.push(value); if (onState) onState(value); }, onQuiescent: async value => { if (onQuiescent) await onQuiescent(value); acknowledgements.push(value); } });
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
