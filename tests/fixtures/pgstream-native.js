'use strict';

// Concrete maintained-pgstream setup for owned native fixtures. No import-time
// IO or Docker. The caller owns the database and closes role children first.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const {execFileSync}=require('node:child_process');
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
  return { binaryEnv: ENV.binary, configFileEnv: ENV.config, receiverPort: selected.receiverPort, slot, streamRole,
    bounds: { heartbeatMs: 1000, stallMs: 5000, stepMs: 5000, stopMs: 2000, recoveryMs: 30000, pendingMs: 30000, maxRestarts: 3 } };
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
async function setup({ admin, adminURI, directory, config, evaluatorRole, realtimeRole, realtimeConfig, source = process.env }) {
  const selected = capability(source), canonical=binding(source), pgstream = config.pgstream;
  if (!admin || typeof admin.query !== 'function' || typeof adminURI !== 'string' || !path.isAbsolute(directory || '') ||
      !pgstream || pgstream.receiverPort !== selected.receiverPort || pgstream.binaryEnv !== ENV.binary || pgstream.configFileEnv !== ENV.config) fail('PGSTREAM_NATIVE_SETUP_REQUIRED');
  q(evaluatorRole); q(pgstream.streamRole); q(pgstream.slot);
  const ns=config.namespaces,heartbeat=q(ns.clock)+'.nightscout_heartbeat';
  if (!/^evaluator-[A-Za-z0-9_-]{1,100}$/.test(config.consumer)) fail('PGSTREAM_NATIVE_CONSUMER');
  const objects = (await admin.query("SELECT to_regnamespace('pgstream') IS NOT NULL AS schema_exists,EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$1) AS role_exists,EXISTS(SELECT 1 FROM pg_replication_slots WHERE slot_name=$2) AS slot_exists,current_setting('wal_level') AS wal_level", [pgstream.streamRole, pgstream.slot])).rows[0];
  if (!objects || objects.schema_exists || objects.role_exists || objects.slot_exists || objects.wal_level !== 'logical') fail('PGSTREAM_NATIVE_OWNED_EMPTY_DATABASE_REQUIRED');
  let schemaOwned = false, roleOwned = false, heartbeatOwned = false, closed = false;
  const own = fs.mkdtempSync(path.join(directory, 'pgstream-')); fs.chmodSync(own, 0o700);
  async function close() {
    if (closed) return;
    // An active slot proves a caller has not closed its maintained child. Never
    // terminate or adopt a backend to make cleanup look green.
    const slot = (await admin.query('SELECT active FROM pg_replication_slots WHERE slot_name=$1', [pgstream.slot])).rows[0];
    if (slot?.active) fail('PGSTREAM_NATIVE_CHILD_STILL_ACTIVE');
    if (slot) await admin.query('SELECT pg_drop_replication_slot($1)', [pgstream.slot]);
    if (heartbeatOwned) await admin.query('DROP TABLE ' + heartbeat);
    if (schemaOwned) await admin.query('DROP SCHEMA pgstream CASCADE');
    if (roleOwned) { await admin.query('DROP OWNED BY ' + q(pgstream.streamRole)); await admin.query('DROP ROLE ' + q(pgstream.streamRole)); }
    // Wire/init files contain passwords. Retain private logs in the owned
    // capture, but remove these two plaintext connection documents on close.
    for (const file of ['init.json', 'wire.json']) fs.rmSync(path.join(own, file), { force: true });
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
      const owned=(await admin.query("SELECT to_regnamespace('pgstream') IS NOT NULL AS schema_owned,to_regclass($1) IS NOT NULL AS heartbeat_owned",[heartbeat])).rows[0];
      schemaOwned=owned?.schema_owned===true;heartbeatOwned=owned?.heartbeat_owned===true;
    }
    const configFile = path.join(own, 'wire.json'); fs.writeFileSync(configFile, JSON.stringify(wire(config, streamURL.href, selected.subscriptionsPort, canonical)), { flag: 'wx', mode: 0o600 });
    binary(selected.binary, selected.sha256, selected.sha256);
    return Object.freeze({ configuration: pgstream, environment: { [ENV.binary]: selected.binary, [ENV.config]: configFile }, configFile, close });
  } catch (error) { await close(); throw error; }
}
module.exports = { ENV, capability, ports, configuration, binding, wire, setup, binary };
