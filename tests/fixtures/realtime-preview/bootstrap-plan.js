'use strict';
// Source-only plan and actual configuration parser inputs. No service imports or
// side effects; execution lives in bootstrap.js and requires parent-owned URLs.
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const phases = Object.freeze(['joined-role-recovery','joined-data-parity','joined-consumer-handoff','joined-consumer-plugin-ack','joined-socket-epoch','joined-browser-consumer']);
const A='11111111-1111-4111-8111-111111111111', B='22222222-2222-4222-8222-222222222222';
const SUBJECT='000000000000000000000001', STALE='000000000000000000000002';
const STATUS='000000000000000000000003';
const rolePermissions=Object.freeze({fixture:Object.freeze(['api:*:read','api:*:create,update,delete','notifications:*:ack']),status:Object.freeze(['api:status:read'])});
const subjects=Object.freeze([{id:SUBJECT,role:'fixture',legacy:'fixture'},{id:STALE,role:'fixture',legacy:'stale'},{id:STATUS,role:'status',legacy:'status'}].map(Object.freeze));
function phaseConfiguration (phase) {
  if (!phases.includes(phase)) fail();
  return {credentialEnv:['joined-consumer-handoff','joined-consumer-plugin-ack'].includes(phase)?'RT_BOOTSTRAP_ALARM_A_JSON':'RT_BOOTSTRAP_MAIN_A_JSON',
    dataCredentialEnv:'RT_BOOTSTRAP_MAIN_A_JSON',
    ...(phase==='joined-socket-epoch'?{epochReadCredentialEnv:'RT_BOOTSTRAP_EPOCH_READ_JSON',epochStatusCredentialEnv:'RT_BOOTSTRAP_EPOCH_STATUS_JSON'}:{})};
}
function credentials (index,subject,token) {
  if (![0,1].includes(index) || !subjects.some(row=>row.id===subject) || typeof token!=='string' || !token) fail();
  if (subject===SUBJECT) return index?{RT_BOOTSTRAP_MAIN_B_JSON:JSON.stringify({token})}:{RT_BOOTSTRAP_MAIN_A_JSON:JSON.stringify({token}),
    RT_BOOTSTRAP_ALARM_A_JSON:JSON.stringify({accessToken:token}),RT_BOOTSTRAP_EPOCH_READ_JSON:JSON.stringify({token,accessToken:token})};
  if (index===0&&subject===STALE) return {RT_BOOTSTRAP_STALE_ALARM_JSON:JSON.stringify({accessToken:token})};
  if (index===0&&subject===STATUS) return {RT_BOOTSTRAP_EPOCH_STATUS_JSON:JSON.stringify({token,accessToken:token})};
  return {};
}
// Exact fixture-owned phase reset. Encrypted bootstrap roots must survive phase
// resets; all other selected data/audit tables reset, never migration ledgers.
function resetTables () {
  return {entries:['entries'],treatments:['treatments'],devicestatus:['devicestatus'],profile:['profile'],food:['food'],activity:['activity'],settings:['settings'],
    authorization:['tenant_authorization_config','tenant_authorization_roles','tenant_authorization_subjects','tenant_authorization_subject_roles',
      'tenant_subject_admin_audit','tenant_owner_policy','tenant_owner_actors'],secrets:['secret_audit'],
    legacy:['legacy_credential_config','legacy_credential_subjects'],access:['access_tenants','access_credentials','access_sessions','access_keys'],
    clock:['tenant_write_clock'],rt_checkpoint:['tenant_consumer_checkpoint'],eval_checkpoint:['tenant_consumer_checkpoint'],
    alarm:['tenant_alarm_suppression'],outbox:['tenant_notification_state','tenant_notification_heads','tenant_notification_requests']};
}
function resetPlan (layout, catalogues, reset=resetTables()) {
  const preserve={secrets:['secret_records']}, known=resetTables(), tables=new Map(), foreignKeys=[];
  const refuse=code=>{throw new Error(code);};
  if (Object.keys(catalogues).sort().join(',')!==Object.keys(known).sort().join(',') ||
      Object.keys(reset).sort().join(',')!==Object.keys(known).sort().join(',')) refuse('JOINED_BOOTSTRAP_RESET_DOMAINS');
  for (const [domain,catalogue] of Object.entries(catalogues)) {
    const names=new Set();tables.set(domain,names);
    for (const migration of catalogue.migrations) for (const sql of migration.up) {
      const create=/^CREATE TABLE ([a-z][a-z0-9_]*) \(/.exec(sql);
      if (/CREATE TABLE/i.test(sql)&&!create) refuse('JOINED_BOOTSTRAP_RESET_DDL_UNREVIEWED');
      if (create) { if(names.has(create[1]))refuse('JOINED_BOOTSTRAP_RESET_DDL_UNREVIEWED');names.add(create[1]); }
      if (/REFERENCES/i.test(sql)) {
        const owner=/^(?:CREATE|ALTER) TABLE ([a-z][a-z0-9_]*) /.exec(sql), references=[...sql.matchAll(/REFERENCES ([a-z][a-z0-9_]*) \(/g)];
        if (!owner||references.length!==(sql.match(/REFERENCES/gi)||[]).length) refuse('JOINED_BOOTSTRAP_RESET_DDL_UNREVIEWED');
        for (const target of references) foreignKeys.push({domain,from:owner[1],to:target[1]});
      }
    }
    if (!Array.isArray(reset[domain])||new Set(reset[domain]).size!==reset[domain].length) refuse('JOINED_BOOTSTRAP_RESET_TABLES');
  }
  for (const relation of foreignKeys) {
    if (!tables.get(relation.domain).has(relation.from)||!tables.get(relation.domain).has(relation.to)) refuse('JOINED_BOOTSTRAP_RESET_DDL_UNREVIEWED');
    if (reset[relation.domain].includes(relation.to)&&!reset[relation.domain].includes(relation.from)) refuse('JOINED_BOOTSTRAP_RESET_FK_CLOSURE');
  }
  for (const [domain,names] of tables) {
    const accounted=[...reset[domain],...(preserve[domain]||[])];
    if (new Set(accounted).size!==accounted.length||accounted.length!==names.size||accounted.some(name=>!names.has(name))) refuse('JOINED_BOOTSTRAP_RESET_TABLE_COVERAGE');
  }
  const expand=map=>Object.entries(map).flatMap(([domain,names])=>names.map(table=>({domain,namespace:layout.namespaces[domain],table})));
  return {reset:expand(reset),preserved:expand(preserve),foreignKeys};
}
const optionsKeys = Object.freeze(['timeoutMs','recoveryIntervalMs','timeIntervalMs','pollIntervalMs','retryIntervalMs','retryDelayMs',
  'attemptTimeoutMs','maxRows','maxBytes','pageSize','maxMessageBytes','maxPayloadBytes','maxConnections','maxInflight','maxSockets',
  'snoozeMs','settleMs','observationMs','credentialLifetimeSeconds']);
const optionalOptionsKeys = Object.freeze(['evaluatorMaxRows','realtimeMaxRows']);
const fail = () => {throw new Error('JOINED_BOOTSTRAP_INPUT_REFUSED');};
const exact = (value,keys) => value && typeof value==='object' && !Array.isArray(value) && keys.length===Object.keys(value).length && keys.every(key=>Object.hasOwn(value,key));
function parse (input) {
  if (!input || path.resolve(input.sourceDir || '')!==path.resolve(__dirname,'../../..') ||
      !path.isAbsolute(input.captureDir || '') || !input.env || !Array.isArray(input.resources) || typeof input.onObservation!=='function') fail();
  let options, ui;
  try {options=JSON.parse(input.env.NS_RT_BOOTSTRAP_OPTIONS_JSON);ui=JSON.parse(input.env.NS_RT_BOOTSTRAP_UI_JSON);} catch {fail();}
  if (!options || typeof options!=='object' || Array.isArray(options) || !optionsKeys.every(key=>Object.hasOwn(options,key)) ||
      Object.keys(options).some(key=>!optionsKeys.includes(key)&&!optionalOptionsKeys.includes(key)) ||
      [...optionsKeys,...optionalOptionsKeys.filter(key=>Object.hasOwn(options,key))].some(key=>!Number.isSafeInteger(options[key]) || options[key]<1 || options[key]>2147483647) ||
      options.pageSize>options.maxRows || options.pageSize>(options.evaluatorMaxRows??options.maxRows) || options.pageSize>(options.realtimeMaxRows??options.maxRows) || options.maxPayloadBytes>options.maxBytes || options.timeoutMs>options.attemptTimeoutMs ||
      options.timeoutMs>60000 || options.credentialLifetimeSeconds>28800 ||
      !exact(ui,['bundleDirectory','expectedBundleSha256','settings']) || !path.isAbsolute(ui.bundleDirectory || '') ||
      !/^[a-f0-9]{64}$/.test(ui.expectedBundleSha256) || !ui.settings || typeof ui.settings!=='object' || Array.isArray(ui.settings)) fail();
  function resource (kind) {const rows=input.resources.filter(row=>row?.kind===kind);if(rows.length!==1)fail();return rows[0];}
  function endpoint (kind,envKey,protocols) {
    const own=resource(kind);let url;try{url=new URL(input.env[envKey]);}catch{fail();}
    if (!protocols.includes(url.protocol) || url.hostname!=='127.0.0.1' || own.host!==url.hostname || Number(url.port)!==own.port ||
        !Number.isSafeInteger(own.port) || own.port<1 || own.port>65535 || typeof own.containerId!=='string' || !own.containerId ||
        typeof own.image!=='string' || own.image!==require('./early').plan.pins[kind] || !own.labelKey || !own.labelValue || !Array.isArray(own.mounts)) fail();
    return {own,url};
  }
  const pg=endpoint('postgres','NS_TEST_POSTGRES_ADMIN_URI',['postgres:','postgresql:']);
  if (!pg.url.username || !pg.url.password || !/test/i.test(decodeURIComponent(pg.url.pathname)) ||
      decodeURIComponent(pg.url.pathname.slice(1))!==pg.own.database) fail();
  const mongo=endpoint('mongo','CUSTOMCONNSTR_mongo',['mongodb:']);
  const vault=endpoint('vault','NS_RT_BOOTSTRAP_VAULT_ADDRESS',['http:']);
  if (vault.url.username || vault.url.password || vault.url.pathname!=='/' || vault.url.search || vault.url.hash ||
      typeof input.env.NS_RT_BOOTSTRAP_VAULT_ROOT_TOKEN!=='string' || !input.env.NS_RT_BOOTSTRAP_VAULT_ROOT_TOKEN) fail();
  const directory=resource('private-directory');let stat;
  try {stat=fs.lstatSync(directory.path);}catch{fail();}
  if (!path.isAbsolute(directory.path || '') || !stat.isDirectory() || stat.isSymbolicLink() || (stat.mode&0o777)!==0o700 ||
      stat.uid!==process.getuid() || directory.ownerUid!==stat.uid || directory.mode!==0o700 || Buffer.byteLength(directory.path)>56) fail();
  return {options:{...options,evaluatorMaxRows:options.evaluatorMaxRows??options.maxRows,realtimeMaxRows:options.realtimeMaxRows??options.maxRows},ui,pg,mongo,vault,directory};
}
function layout (suffix=crypto.randomBytes(8).toString('hex')) {
  if (!/^[a-f0-9]{16}$/.test(suffix)) fail();
  const prefix='rtj_'+suffix;
  const names=['entries','treatments','devicestatus','profile','food','activity','settings','authorization','secrets','legacy','access','clock','rt_checkpoint','eval_checkpoint','alarm','outbox'];
  return {prefix,namespaces:Object.fromEntries(names.map(name=>[name,prefix+'_'+name])),
    roles:Object.fromEntries(['api','readiness','alarm','realtime','evaluator','suppression','outbox'].map(name=>[name,prefix+'_'+name])),
    mongoDatabase:'rt_data_'+suffix,mount:prefix+'_transit'};
}
function documents ({selected,layout: l,publicKeys,paths}) {
  const o=selected.options, ns=l.namespaces;
  const clinical=Object.fromEntries(['entries','treatments','devicestatus','profile','food','activity'].map(d=>[d,ns[d]]));
  const tenants=[A,B].map(id=>({id,revision:'joined-fixture-v1',settings:{enable:['bgnow','delta','direction','simplealarms','treatmentnotify']}}));
  const common={version:1,postgres:{connectionEnv:'RT_BOOTSTRAP_RT_PG',namespaces:{...clinical,clock:ns.clock,checkpoint:ns.rt_checkpoint}},
    consumer:'realtime-joined-fixture',pageSize:o.pageSize,maxRows:o.realtimeMaxRows,maxBytes:o.maxBytes,maxTenants:2,recoveryIntervalMs:o.recoveryIntervalMs,
    socketOrderDomains:['treatments','devicestatus','profile'],tenants};
  const evaluator={...common,datastore:{hostname:selected.pg.url.hostname,port:Number(selected.pg.url.port),database:selected.pg.own.database},postgres:{connectionEnv:'RT_BOOTSTRAP_EVAL_PG',namespaces:{...clinical,clock:ns.clock,checkpoint:ns.eval_checkpoint}},
    consumer:'evaluator-joined-fixture',maxRows:o.evaluatorMaxRows,timeIntervalMs:o.timeIntervalMs,consumers:{realtime:{
      outbox:{connectionEnv:'RT_BOOTSTRAP_OUTBOX_PG',namespace:ns.outbox,maxRows:o.maxRows,maxBytes:o.maxBytes,maxConnections:o.maxConnections},
      suppression:{connectionEnv:'RT_BOOTSTRAP_SUPPRESSION_PG',namespace:ns.alarm,maxRows:o.maxRows,maxBytes:o.maxBytes,maxConnections:o.maxConnections},
      route:{id:'realtime-joined-fixture',socketPathEnv:'RT_BOOTSTRAP_ALARM_SOCKET',maxMessageBytes:o.maxMessageBytes,operationTimeoutMs:o.timeoutMs},
      maxPayloadBytes:o.maxPayloadBytes,maxInflight:o.maxInflight,attemptTimeoutMs:o.attemptTimeoutMs,retryDelayMs:o.retryDelayMs,
      pollIntervalMs:o.pollIntervalMs,retryIntervalMs:o.retryIntervalMs}}};
  const realtime={...common,admissionFileEnv:'RT_BOOTSTRAP_ADMISSION',apiSocketPathEnv:'RT_BOOTSTRAP_API_SOCKET',alarmSocketPathEnv:'RT_BOOTSTRAP_ALARM_SOCKET',
    maxMessageBytes:o.maxMessageBytes,operationTimeoutMs:o.timeoutMs,maxSockets:o.maxSockets};
  const aliases=[['one.example.test'],['two.example.test']];
  const api={version:1,domains:[...Object.keys(clinical),'settings'],legacy:true,context:true,writeClock:true,
    postgres:{connectionEnv:'RT_BOOTSTRAP_API_PG',readinessConnectionEnv:'RT_BOOTSTRAP_READINESS_PG',
      namespaces:{...clinical,settings:ns.settings,authorization:ns.authorization,secrets:ns.secrets,legacy:ns.legacy,access:ns.access,clock:ns.clock}},
    vault:{address:selected.vault.url.origin,mount:l.mount,allowInsecureLoopback:true,timeoutMs:o.timeoutMs},resolution:{mode:'direct-alias'},
    tenants:[A,B].map((id,i)=>({id,aliases:aliases[i],settings:tenants[i].settings,
      vault:{tokenEnv:'RT_BOOTSTRAP_VAULT_'+i,encryptionKey:'tenant-'+i+'-data',signingKey:'tenant-'+i+'-signing',signingVersion:1}})),
    accessTokens:{issuer:'nightscout-joined-fixture',audience:'nightscout-data',keys:publicKeys},
    socketForwarding:{socketPathEnv:'RT_BOOTSTRAP_API_SOCKET',admissionFileEnv:'RT_BOOTSTRAP_ADMISSION',maxTenants:2,
      maxMessageBytes:o.maxMessageBytes,operationTimeoutMs:o.timeoutMs,alarm:{connectionEnv:'RT_BOOTSTRAP_ALARM_PG',namespace:ns.alarm},
      consumerState:{evaluatorConfigEnv:'MULTITENANT_EVALUATOR_CONFIG'}}};
  return {api,evaluator,realtime,admission:{version:1,mode:'preview-socket-allowlist',tenants:[A,B].map((id,i)=>({id,enabled:true,aliases:aliases[i]}))},paths};
}
module.exports={parse,layout,documents,phases,optionsKeys,optionalOptionsKeys,A,B,SUBJECT,STALE,STATUS,rolePermissions,subjects,phaseConfiguration,credentials,resetTables,resetPlan};
