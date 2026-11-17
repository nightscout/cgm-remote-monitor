'use strict';

// Concrete maintained-pgstream setup for owned native fixtures. No import-time
// IO or Docker. The caller owns the database and closes role children first.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const {execFileSync,spawn}=require('node:child_process');
const http=require('node:http');
const assert=require('node:assert/strict');
const ENV = Object.freeze({ binary: 'NS_RT_BOOTSTRAP_PGSTREAM_BINARY', sha256: 'NS_RT_BOOTSTRAP_PGSTREAM_SHA256',
  receiverPort: 'NS_RT_BOOTSTRAP_PGSTREAM_RECEIVER_PORT', subscriptionsPort: 'NS_RT_BOOTSTRAP_PGSTREAM_SUBSCRIPTIONS_PORT', config: 'NS_RT_BOOTSTRAP_PGSTREAM_CONFIG', binding: 'NS_RT_BOOTSTRAP_PGSTREAM_BINDING_JSON' });
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const q = value => { if (!NAME.test(value) || value.startsWith('pg_')) fail('PGSTREAM_NATIVE_IDENTIFIER'); return '"' + value + '"'; };
function binary(file, declared, expected) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !/^[a-f0-9]{64}$/.test(declared || '') || declared !== expected) fail('PGSTREAM_NATIVE_BINARY_PIN');
  let stat, real, digest;
  try { stat = fs.lstatSync(file); real = fs.realpathSync(file); digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { fail('PGSTREAM_NATIVE_BINARY_MISSING'); }
  if (!stat.isFile() || stat.isSymbolicLink() || real !== file || !(stat.mode & 0o111) || digest !== expected) fail('PGSTREAM_NATIVE_BINARY_PIN');
  return file;
}
function capability(source = process.env) {
  const expected = require('../../lib/pgstream/evaluator').BINARY_SHA256;
  const selected = binary(source[ENV.binary], source[ENV.sha256], expected);
  return Object.freeze({binary:selected,sha256:expected,...ports(source)});
}
function ports(source){
  const values=[ENV.receiverPort,ENV.subscriptionsPort].map(key=>{
    if(typeof source[key]!=='string'||! /^[1-9][0-9]{3,4}$/.test(source[key]))fail('PGSTREAM_NATIVE_PORT_REQUIRED');
    const value=Number(source[key]);if(value<1024||value>65535)fail('PGSTREAM_NATIVE_PORT_REQUIRED');return value;
  });
  if(values[0]===values[1])fail('PGSTREAM_NATIVE_PORT_COLLISION');
  return {receiverPort:values[0],subscriptionsPort:values[1]};
}
function configuration({ prefix, capability: selected }) {
  const slot = prefix + '_pgstream', streamRole = prefix + '_pgstream'; q(slot); q(streamRole);
  if (!selected || !Number.isSafeInteger(selected.receiverPort)) fail('PGSTREAM_NATIVE_CAPABILITY_REQUIRED');
  return { receiver:{url:'http://127.0.0.1:'+selected.receiverPort+'/',trust:'network',bindHost:'127.0.0.1',maxBytes:8388608,timeoutMs:5000}, slot, streamRole,
    bounds: { stepMs: 5000, recoveryMs: 30000, pendingMs: 30000 },
    generation:crypto.randomBytes(16).toString('hex'),transactionRows:10000,recovery:{connectionEnv:'NS_STREAM_RECOVERY_PG',timeoutMs:5000,maxQueued:32} };
}
function binding(source){
  let selected;try{selected=JSON.parse(source[ENV.binding]);}catch{fail('PGSTREAM_NATIVE_BINDING_REQUIRED');}
  if(!selected||Object.keys(selected).sort().join(',')!=='commit,configSha256,file,repository,sha256'||
      !path.isAbsolute(selected.file||'')||path.basename(selected.file)!=='pgstream.js'||!path.isAbsolute(selected.repository||'')||
      !/^[a-f0-9]{40}$/.test(selected.commit||'')||![selected.sha256,selected.configSha256].every(value=>/^[a-f0-9]{64}$/.test(value||'')))fail('PGSTREAM_NATIVE_BINDING_REQUIRED');
  const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
  for(const [name,expected]of [['pgstream.js',selected.sha256],['config.js',selected.configSha256]]){
    const file=path.join(path.dirname(selected.file),name);let actual,committed;
    try{const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())fail('PGSTREAM_NATIVE_BINDING_PIN');actual=fs.readFileSync(file);
      committed=execFileSync('git',['-C',selected.repository,'show',selected.commit+':bindings/compose/multitenant/'+name],{stdio:['ignore','pipe','pipe'],timeout:5000});
    }catch{fail('PGSTREAM_NATIVE_BINDING_PIN');}
    if(digest(actual)!==expected||digest(committed)!==expected)fail('PGSTREAM_NATIVE_BINDING_PIN');
  }
  const canonical=require(selected.file);
  if(typeof canonical.init!=='function'||typeof canonical.wire!=='function')fail('PGSTREAM_NATIVE_BINDING_API');
  return canonical;
}
function wire(config,runtimeURL,subscriptionsPort,canonical){
  if(typeof canonical?.wire!=='function')fail('PGSTREAM_NATIVE_BINDING_REQUIRED');
  return canonical.wire(config,runtimeURL,{subscriptionsPort,routes:require('../../lib/pgstream/evaluator').routes(config)});
}
function processIdentity(pid){
  const raw=fs.readFileSync('/proc/'+pid+'/stat','utf8'),fields=raw.slice(raw.lastIndexOf(')')+2).trim().split(/\s+/);
  return {pid,birth:fields[19],group:Number(fields[2]),uid:fs.statSync('/proc/'+pid).uid};
}
async function waitReceiver(url,timeoutMs,signal){
  const end=Date.now()+timeoutMs;
  while(Date.now()<end){
    if(signal?.aborted)fail('PGSTREAM_NATIVE_PRODUCER_START_CANCELLED');
    const ready=await new Promise(resolve=>{const request=http.get(new URL('pgstream/ready',url),response=>{response.resume();resolve(response.statusCode===204);});request.setTimeout(Math.min(200,Math.max(1,end-Date.now())),()=>request.destroy());request.on('error',()=>resolve(false));});
    if(ready)return;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  fail('PGSTREAM_NATIVE_RECEIVER_NOT_READY');
}
// Independently owned fixture actor. It inherits the driver finite process
// group, never the detached evaluator group. Each explicit start launches at
// most one producer; no restart loop or platform HA claim is added here.
function createProducer({binary:executable,configFile,receiverURL,timeoutMs,directory},io={spawn,waitReceiver,identity:processIdentity,signal:(pid,signal)=>process.kill(pid,signal)}){
  let child,birth,starting,stopping,startAbort,closed=false,count=0,lastExit=null,failed=false;
  const files=[];
  const alive=()=>child&&!failed&&child.exitCode===null&&child.signalCode===null;
  function same(){const current=io.identity(birth.pid);return ['pid','birth','group','uid'].every(key=>current[key]===birth[key]);}
  async function start(){
    if(closed)fail('PGSTREAM_NATIVE_PRODUCER_CLOSED');
    if(stopping)await stopping;
    if(alive())return birth;
    if(starting)return starting;
    startAbort=new AbortController();
    starting=(async()=>{
      await io.waitReceiver(receiverURL,timeoutMs,startAbort.signal);
      if(startAbort.signal.aborted)fail('PGSTREAM_NATIVE_PRODUCER_START_CANCELLED');
      if(closed)fail('PGSTREAM_NATIVE_PRODUCER_CLOSED');
      const file=path.join(directory,'producer-'+(++count)+'.log'),fd=fs.openSync(file,'wx',0o600);files.push(file);
      failed=false;
      try{child=io.spawn(executable,['run','-c',configFile,'--log-level','info'],{detached:false,stdio:['ignore',fd,fd]});}finally{fs.closeSync(fd);}
      const owned=child;owned.once('error',()=>{failed=true;lastExit={pid:owned.pid||null,code:null,signal:null,spawnFailed:true};});
      if(!Number.isSafeInteger(child.pid)){failed=true;fail('PGSTREAM_NATIVE_PRODUCER_START_FAILED');}
      birth=io.identity(child.pid);assert.equal(birth.pid,child.pid,'EXTERNAL_PRODUCER_BIRTH_REQUIRED');
      owned.once('exit',(code,signal)=>{lastExit={pid:owned.pid,code,signal};});
      return {...birth};
    })().finally(()=>{starting=null;});return starting;
  }
  async function stop(){
    if(stopping)return stopping;
    stopping=(async()=>{
      startAbort?.abort();
      try{await starting;}catch(error){if(error.code!=='PGSTREAM_NATIVE_PRODUCER_START_CANCELLED')throw error;}
      if(!alive())return;
      assert(same(),'EXTERNAL_PRODUCER_BIRTH_CHANGED');
      const owned=child,ended=new Promise(resolve=>owned.once('exit',resolve));let timer;
      io.signal(birth.pid,'SIGTERM');
      await Promise.race([ended,new Promise(resolve=>{timer=setTimeout(resolve,2000);})]);clearTimeout(timer);
      if(alive()){
        assert(same(),'EXTERNAL_PRODUCER_BIRTH_CHANGED');io.signal(birth.pid,'SIGKILL');
        await Promise.race([ended,new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('EXTERNAL_PRODUCER_STOP_UNCONFIRMED')),2000);})]);clearTimeout(timer);
        fail('EXTERNAL_PRODUCER_FORCED_CLEANUP');
      }
    })().finally(()=>{stopping=null;});return stopping;
  }
  return Object.freeze({start,stop,descriptor:()=>({binary:executable,configFile,receiverURL}),identity:()=>alive()?{...birth}:null,state:()=>({running:!!alive(),starts:count,lastExit,files:[...files]}),async close(){await stop();closed=true;}});
}
async function setup({ admin, adminURI, directory, config, evaluatorRole, realtimeRole, realtimeConfig, source = process.env }) {
  const selected = capability(source), canonical=binding(source), pgstream = config.pgstream;
  if (!admin || typeof admin.query !== 'function' || typeof adminURI !== 'string' || !path.isAbsolute(directory || '') ||
      !pgstream || pgstream.receiver?.url !== 'http://127.0.0.1:'+selected.receiverPort+'/' || pgstream.receiver.bindHost !== '127.0.0.1') fail('PGSTREAM_NATIVE_SETUP_REQUIRED');
  q(evaluatorRole); q(pgstream.streamRole); q(pgstream.slot);
  const ns=config.namespaces;
  if (!/^evaluator-[A-Za-z0-9_-]{1,100}$/.test(config.consumer)) fail('PGSTREAM_NATIVE_CONSUMER');
  const objects = (await admin.query("SELECT to_regnamespace('pgstream') IS NOT NULL AS schema_exists,EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$1) AS role_exists,EXISTS(SELECT 1 FROM pg_replication_slots WHERE slot_name=$2) AS slot_exists,current_setting('wal_level') AS wal_level", [pgstream.streamRole, pgstream.slot])).rows[0];
  if (!objects || objects.schema_exists || objects.role_exists || objects.slot_exists || objects.wal_level !== 'logical') fail('PGSTREAM_NATIVE_OWNED_EMPTY_DATABASE_REQUIRED');
  let schemaOwned = false, roleOwned = false, closed = false, producer;
  const own = fs.mkdtempSync(path.join(directory, 'pgstream-')); fs.chmodSync(own, 0o700);
  async function close() {
    if (closed) return;
    await producer?.close();
    // An active slot proves an independently managed producer is still live. Never
    // terminate or adopt a backend to make cleanup look green.
    const slot = (await admin.query('SELECT active FROM pg_replication_slots WHERE slot_name=$1', [pgstream.slot])).rows[0];
    if (slot?.active) fail('PGSTREAM_NATIVE_CHILD_STILL_ACTIVE');
    if (slot) await admin.query('SELECT pg_drop_replication_slot($1)', [pgstream.slot]);
    if (schemaOwned) await admin.query('DROP SCHEMA pgstream CASCADE');
    if (roleOwned) { await admin.query('DROP OWNED BY ' + q(pgstream.streamRole)); await admin.query('DROP ROLE ' + q(pgstream.streamRole)); }
    // Wire/init files contain passwords. Retain private logs in the owned
    // capture, but remove these two plaintext connection documents on close.
    for (const file of ['init.json', 'wire.yaml']) fs.rmSync(path.join(own, file), { force: true });
    closed = true;
  }
  try {
    const streamPassword = crypto.randomBytes(24).toString('hex');
    await admin.query('CREATE ROLE ' + q(pgstream.streamRole) + " LOGIN REPLICATION NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE CONNECTION LIMIT 4 PASSWORD '" + streamPassword + "'"); roleOwned = true;
    const streamURL = new URL(adminURI); streamURL.username = pgstream.streamRole; streamURL.password = streamPassword;
    const layout={roles:{pgstream:pgstream.streamRole,evaluator:evaluatorRole,...(realtimeRole?{realtime:realtimeRole}:{})},
      namespaces:{clock:ns.clock,eval_checkpoint:ns.checkpoint,...(realtimeRole?{rt_checkpoint:realtimeConfig?.namespaces?.checkpoint}:{})}};
    try{
      await canonical.init({admin,adminURL:adminURI,layout,config,binary:selected.binary,binarySha256:selected.sha256,
        routes:require('../../lib/pgstream/evaluator').routes(config),workColumns:require('../../lib/pgstream/checkpoint').WORK_COLUMNS,
        ...(realtimeRole?{realtimeColumns:require('../../lib/pgstream/realtime-receipt').COLUMNS,realtimeConsumers:[realtimeConfig.consumer]}:{})});
    }finally{
      const owned=(await admin.query("SELECT to_regnamespace('pgstream') IS NOT NULL AS schema_owned")).rows[0];
      schemaOwned=owned?.schema_owned===true;
    }
    const configFile = path.join(own, 'wire.yaml'); fs.writeFileSync(configFile, JSON.stringify(wire(config, streamURL.href, selected.subscriptionsPort, canonical)), { flag: 'wx', mode: 0o600 });
    binary(selected.binary, selected.sha256, selected.sha256);
    producer=createProducer({binary:selected.binary,configFile,receiverURL:pgstream.receiver.url,timeoutMs:pgstream.bounds.recoveryMs,directory:own});
    return Object.freeze({configuration:pgstream,environment:pgstream.recovery?.connectionEnv?{[pgstream.recovery.connectionEnv]:streamURL.href}:{},configFile,binary:selected.binary,slot:pgstream.slot,start:producer.start,stop:producer.stop,identity:producer.identity,state:producer.state,descriptor:producer.descriptor,close});
  } catch (error) { await close(); throw error; }
}
module.exports = { ENV, capability, ports, configuration, binding, wire, setup, binary, createProducer, waitReceiver };
