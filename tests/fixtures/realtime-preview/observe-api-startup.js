'use strict';
// Fixture-only, explicit default-off preload. No business arguments/results,
// error messages, stack, provider data or credentials are observed or written.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const STAGES=new Set(['migrations.run','postgres-domains.readiness','postgres-domains.assertServing','private-api.boot']);
const PHASES=new Set(['joined-role-recovery','joined-data-parity','joined-consumer-handoff','joined-consumer-plugin-ack','joined-socket-epoch','joined-browser-consumer']);
const NAMES=new Set(['Error','TypeError','RangeError','SyntaxError','MigrationError','PreviewConfigError']);
const CODES=new Set(['42501','0A000','42P01','42703','3F000','28P01','08001','08006','53300','55000','23503','23505','57014',
  'MIG_CATALOGUE','MIG_CHECKSUM','MIG_CONNECTION','MIG_DIRECT','MIG_DRIFT','MIG_HISTORY','MIG_LOCK_LOST','MIG_LOCK_TIMEOUT',
  'MIG_NAMESPACE','MIG_OPTIONS','MIG_STALE','MIG_UNKNOWN','MIG_UNSUPPORTED','SOCKET_PRIVATE_TENANT_REFUSED','SOCKET_ADMISSION_REFUSED']);
function options(env){
  if(env.NS_RT_API_STARTUP_OBSERVE!=='1')return null;
  const value={file:env.NS_RT_API_STARTUP_OBSERVATION_FILE,maxBytes:Number(env.NS_RT_API_STARTUP_OBSERVATION_MAX_BYTES),sourceHead:env.NS_RT_SOURCE_HEAD,phaseId:env.NS_RT_NATIVE_PHASE};
  assert(typeof value.file==='string'&&path.isAbsolute(value.file),'API_OBSERVER_PATH_REQUIRED');
  assert(Number.isSafeInteger(value.maxBytes)&&value.maxBytes>0,'API_OBSERVER_BOUND_REQUIRED');assert.match(value.sourceHead,/^[a-f0-9]{40}$/);assert(PHASES.has(value.phaseId),'API_OBSERVER_PHASE_REQUIRED');
  return value;
}
function writer(config){
  const directory=fs.lstatSync(path.dirname(config.file));
  assert(directory.isDirectory()&&!directory.isSymbolicLink()&&directory.uid===process.getuid()&&(directory.mode&0o777)===0o700&&fs.realpathSync(path.dirname(config.file))===path.dirname(config.file),'API_OBSERVER_OWNED_PRIVATE_DIRECTORY_REQUIRED');
  const fd=fs.openSync(config.file,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600),own=fs.fstatSync(fd);
  const value={sourceHead:config.sourceHead,phaseId:config.phaseId,pid:process.pid,events:[]};let closed=false;
  function close(){if(!closed){closed=true;fs.closeSync(fd);}}
  function flush(){
    const current=fs.lstatSync(config.file);assert(current.isFile()&&!current.isSymbolicLink()&&current.dev===own.dev&&current.ino===own.ino&&current.uid===own.uid,'API_OBSERVER_FILE_OWNERSHIP_CHANGED');
    const bytes=Buffer.from(JSON.stringify(value));assert(bytes.length<=config.maxBytes,'API_OBSERVER_BOUND');
    fs.writeSync(fd,bytes,0,bytes.length,0);fs.ftruncateSync(fd,bytes.length);
  }
  try{flush();}catch(error){close();throw error;}
  return {record(stage,status,error){
    assert(!closed&&STAGES.has(stage)&&['enter','ready','refused'].includes(status),'API_OBSERVER_STATIC_EVENT_REQUIRED');
    const row={stage,status};if(status==='refused'){row.name=NAMES.has(error?.name)?error.name:'UnclassifiedError';row.code=CODES.has(error?.code)?error.code:'UNCLASSIFIED';}
    value.events.push(row);try{flush();}catch(error){value.events.pop();throw error;}
  },close};
}
function wrap(original,stage,record){
  assert(typeof original==='function'&&STAGES.has(stage));
  const observe=(status,error)=>{try{record(stage,status,error);}catch{ /* observational failure never changes product outcome */ }};
  return function observed(...args){
    observe('enter');let result;
    try{result=Reflect.apply(original,this,args);}catch(error){observe('refused',error);throw error;}
    if(result&&typeof result.then==='function')result.then(()=>observe('ready'),error=>observe('refused',error));
    else observe('ready');
    return result; // preserves returned object/promise and thrown error identity
  };
}
function install(env=process.env,load=require){
  const selected=options(env);if(!selected)return null;
  const output=writer(selected);
  // Wrap migrations FIRST: postgres-domains captures run when it imports.
  const migrations=load('../../../lib/migrations/postgres');migrations.run=wrap(migrations.run,'migrations.run',output.record);
  const domains=load('../../../lib/server/serve/postgres-domains');
  for(const method of ['readiness','assertServing'])domains[method]=wrap(domains[method],'postgres-domains.'+method,output.record);
  const api=load('../../../lib/server/realtime/private-api');api.boot=wrap(api.boot,'private-api.boot',output.record);
  return output;
}
module.exports={options,writer,wrap,install};
if(process.env.NS_RT_API_STARTUP_OBSERVE==='1'){
  const output=install();process.once('exit',()=>output.close());
}
