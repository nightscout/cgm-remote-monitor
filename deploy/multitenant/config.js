'use strict';

// Explicit synthetic deployment plan. No database, network or filesystem I/O.
const path = require('node:path');
const clinical = Object.freeze(['entries','treatments','devicestatus','profile','food','activity']);
const ordered = Object.freeze(['entries','treatments','devicestatus','profile','food']);
const serviceRoles = Object.freeze(['api','realtime','evaluator','tenant-admin']);
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const subject = '000000000000000000000001';
function quote(name) {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(name) || name.startsWith('pg_')) throw new TypeError('Explicit deployment SQL identifier required');
  return '"' + name + '"';
}
function catalogues() {
  const domains = require('../../lib/server/serve/postgres-domains');
  const successors = require('../../lib/server/tenant-socket-order-port').catalogues;
  return {...Object.fromEntries([...clinical,'settings'].map(name => [name,successors[name] || domains.get(name).catalogue])),
    authorization:require('../../lib/tenant-authorization/postgres-candidate.json'), secrets:require('../../lib/secrets/postgres-candidate.json'),
    legacy:require('../../lib/secrets/legacy-credentials-candidate.json'), access:require('../../lib/tenant-authorization/access-candidate.json'),
    clock:require('../../migrations/candidates/postgres-write-clock-v1.json'), rt_checkpoint:require('../../migrations/candidates/postgres-consumer-checkpoint-v1.json'),
    eval_checkpoint:require('../../migrations/candidates/postgres-consumer-checkpoint-v1.json'), alarm:require('../../migrations/candidates/postgres-alarm-suppression-v1.json'),
    outbox:require('../../lib/tenant-notifications/postgres-candidate.json'),control:require('../../lib/tenant-lifecycle/postgres-candidate.json')};
}
function layout(prefix = 'nsdemo') {
  quote(prefix);
  if (prefix.length > 24) throw new TypeError('Deployment prefix too long');
  const names = ['api','readiness','realtime','evaluator','alarm','suppression','outbox','owner_writer','owner_reader','operator',
    ...serviceRoles.map(name=>'lifetime_'+name.replace('-','_'))];
  return {prefix,owner:prefix+'_owner',namespaces:Object.fromEntries(Object.keys(catalogues()).map(name=>[name,prefix+'_'+name])),
    roles:Object.fromEntries(names.map(name=>[name,prefix+'_'+name])),mount:prefix+'_transit'};
}
function insertionGrants({namespace,domain,role,mode='serving'}) {
  const table=quote(namespace)+'.'+quote(domain),who=quote(role);
  if (!['serving','reader','restore'].includes(mode)) throw new TypeError('Explicit grant mode required');
  const isOrdered=ordered.includes(domain);
  if (mode==='reader') return ['GRANT SELECT ON '+table+' TO '+who,...(isOrdered?['GRANT SELECT ON '+quote(namespace)+'.tenant_insertion_ordinal TO '+who]:[])];
  const base=['GRANT SELECT,INSERT,UPDATE,DELETE ON '+table+' TO '+who];
  if (!isOrdered) return base;
  const built=require('../../lib/tenant-lifecycle/tenant-insertion-sql').build({namespace,domain});
  return [...base,...(mode==='restore'?built.restoreGrants(role):built.servingGrants(role)),
    ...(mode==='restore'?['GRANT DELETE ON '+quote(namespace)+'.tenant_insertion_ordinal TO '+who]:[])];
}
function grants(l) {
  const ns=l.namespaces,r=l.roles,sql=[];
  const schema=(name,who)=>sql.push('GRANT USAGE ON SCHEMA '+quote(ns[name])+' TO '+quote(r[who]));
  const table=(name,logical=name)=>quote(ns[name])+'.'+quote(logical);
  const grant=(privilege,name,who)=>sql.push('GRANT '+privilege+' ON '+name+' TO '+quote(r[who]));
  for(const name of [...clinical,'settings','authorization','secrets','legacy','access','clock'])schema(name,'api');
  for(const name of [...clinical,'settings'])sql.push(...insertionGrants({namespace:ns[name],domain:name,role:r.api}));
  for(const name of ['authorization','legacy','access'])grant('SELECT','ALL TABLES IN SCHEMA '+quote(ns[name]),'api');
  grant('SELECT,INSERT',table('secrets','secret_records'),'api');grant('INSERT',table('secrets','secret_audit'),'api');
  grant('SELECT,UPDATE(last_stamp)',table('clock','tenant_write_clock'),'api');
  for(const name of [...clinical,'settings','authorization','secrets','legacy','access','clock','alarm']){schema(name,'readiness');grant('SELECT',table(name,'schema_migrations'),'readiness');}
  for(const [who,checkpoint]of [['realtime','rt_checkpoint'],['evaluator','eval_checkpoint']]){
    for(const name of [...clinical,'clock',checkpoint]){schema(name,who);grant('SELECT',table(name,'schema_migrations'),who);}
    for(const domain of clinical)sql.push(...insertionGrants({namespace:ns[domain],domain,role:r[who],mode:'reader'}));
    grant('SELECT',table('clock','tenant_write_clock'),who);grant('SELECT,UPDATE(checkpoint,projection,contract_digest)',table(checkpoint,'tenant_consumer_checkpoint'),who);
  }
  schema('alarm','suppression');for(const name of ['tenant_alarm_suppression','schema_migrations'])grant('SELECT',table('alarm',name),'suppression');
  schema('outbox','outbox');grant('SELECT',table('outbox','schema_migrations'),'outbox');
  grant('SELECT,INSERT,UPDATE(request_id,blocked_until)',table('outbox','tenant_notification_heads'),'outbox');
  grant('SELECT,INSERT,UPDATE(state,next_at,attempt,attempt_token,attempt_until,accepted_at,receipt,cleared_at)',table('outbox','tenant_notification_requests'),'outbox');
  grant('SELECT,INSERT,UPDATE(revision,config_identity,producer)',table('outbox','tenant_notification_state'),'outbox');
  for(const name of ['alarm','authorization','access','outbox'])schema(name,'alarm');
  grant('SELECT,INSERT,UPDATE(acked_at,expires_at)',table('alarm','tenant_alarm_suppression'),'alarm');grant('SELECT',table('alarm','schema_migrations'),'alarm');
  for(const name of ['authorization','access'])grant('SELECT','ALL TABLES IN SCHEMA '+quote(ns[name]),'alarm');
  for(const name of ['tenant_notification_state','schema_migrations'])grant('SELECT',table('outbox',name),'alarm');
  for(const who of ['owner_writer','owner_reader'])for(const name of ['authorization','legacy','access']){schema(name,who);grant('SELECT','ALL TABLES IN SCHEMA '+quote(ns[name]),who);}
  for(const name of [table('authorization','tenant_authorization_subjects'),table('legacy','legacy_credential_subjects')])grant('UPDATE,DELETE',name,'owner_writer');
  grant('INSERT,DELETE',table('authorization','tenant_authorization_subject_roles'),'owner_writer');
  sql.push('REVOKE SELECT ON '+table('authorization','tenant_subject_admin_audit')+' FROM '+quote(r.owner_writer));
  grant('INSERT',table('authorization','tenant_subject_admin_audit'),'owner_writer');
  for(const name of ['tenant_authorization_config','tenant_authorization_roles','tenant_owner_policy','tenant_owner_actors'])grant('UPDATE(owner_fence)',table('authorization',name),'owner_writer');
  for(const who of Object.keys(r).filter(name=>name!=='operator')){
    schema('control',who);for(const name of ['schema_migrations','tenant_lifecycle_windows','tenant_lifecycle_operations'])grant('SELECT',table('control',name),who);
    if(who.startsWith('lifetime_')){
      grant('INSERT(tenant_id,operation_id,generation),UPDATE(finished)',table('control','tenant_lifecycle_operations'),who);
      grant('EXECUTE','FUNCTION '+quote(ns.control)+'.tenant_lifecycle_backend_birth()',who);
    }
  }
  sql.push(...require('../../lib/tenant-lifecycle/maintenance-window').operatorGrants({namespace:ns.control,role:r.operator}));
  sql.push('GRANT pg_read_all_stats TO '+quote(r.operator));
  for(const name of Object.keys(ns).filter(name=>name!=='control')){
    schema(name,'operator');grant('SELECT','ALL TABLES IN SCHEMA '+quote(ns[name]),'operator');
    if([...clinical,'settings'].includes(name))sql.push(...insertionGrants({namespace:ns[name],domain:name,role:r.operator,mode:'restore'}));
  }
  grant('UPDATE(last_stamp)',table('clock','tenant_write_clock'),'operator');
  return sql;
}
function documents({layout:l,urls,tokens,publicKeys,managementKeys,vaultAddress}) {
  const ns=l.namespaces, base='/run/ns-config',ipc='/run/ns-ipc';
  const domainNamespaces=Object.fromEntries(clinical.map(name=>[name,ns[name]]));
  const tenants=[A,B].map(id=>({id,revision:'compose-demo-v1',settings:{enable:['bgnow','delta','direction','simplealarms','treatmentnotify']}}));
  const aliases=[['one.example.test'],['two.example.test']];
  const limits={pageSize:100,maxRows:10000,maxBytes:8388608,maxTenants:2,recoveryIntervalMs:1000};
  const pgAddress=new URL(urls.evaluator);
  const evaluator={version:1,datastore:{hostname:pgAddress.hostname,port:Number(pgAddress.port||5432),database:decodeURIComponent(pgAddress.pathname.slice(1))},postgres:{connectionEnv:'NS_EVALUATOR_PG',namespaces:{...domainNamespaces,clock:ns.clock,checkpoint:ns.eval_checkpoint}},
    consumer:'evaluator-compose-demo',...limits,timeIntervalMs:1000,socketOrderDomains:['treatments','devicestatus','profile'],tenants,
    consumers:{realtime:{outbox:{connectionEnv:'NS_OUTBOX_PG',namespace:ns.outbox,maxRows:10000,maxBytes:8388608,maxConnections:2},
      suppression:{connectionEnv:'NS_SUPPRESSION_PG',namespace:ns.alarm,maxRows:10000,maxBytes:8388608,maxConnections:2},
      route:{id:'realtime-compose-demo',socketPathEnv:'NS_ALARM_SOCKET',maxMessageBytes:1048576,operationTimeoutMs:5000},
      maxPayloadBytes:524288,maxInflight:4,attemptTimeoutMs:10000,retryDelayMs:1000,pollIntervalMs:1000,retryIntervalMs:1000}}};
  const realtime={version:1,postgres:{connectionEnv:'NS_REALTIME_PG',namespaces:{...domainNamespaces,clock:ns.clock,checkpoint:ns.rt_checkpoint}},consumer:'realtime-compose-demo',
    ...limits,tenants,socketOrderDomains:['treatments','devicestatus','profile'],admissionFileEnv:'NS_ADMISSION_FILE',apiSocketPathEnv:'NS_API_SOCKET',alarmSocketPathEnv:'NS_ALARM_SOCKET',
    maxMessageBytes:1048576,operationTimeoutMs:5000,maxSockets:100};
  const api={version:1,domains:[...clinical,'settings'],legacy:true,context:true,writeClock:true,
    postgres:{connectionEnv:'NS_API_PG',readinessConnectionEnv:'NS_READINESS_PG',namespaces:{...domainNamespaces,settings:ns.settings,authorization:ns.authorization,secrets:ns.secrets,legacy:ns.legacy,access:ns.access,clock:ns.clock}},
    vault:{address:vaultAddress,mount:l.mount,timeoutMs:5000},resolution:{mode:'direct-alias'},tenants:tenants.map((tenant,i)=>({id:tenant.id,aliases:aliases[i],settings:tenant.settings,
      vault:{tokenEnv:'NS_VAULT_'+i,encryptionKey:'tenant-'+i+'-data',signingKey:'tenant-'+i+'-signing',signingVersion:1}})),
    accessTokens:{issuer:'nightscout-compose-demo',audience:'nightscout-data',keys:publicKeys},
    socketForwarding:{socketPathEnv:'NS_API_SOCKET',admissionFileEnv:'NS_ADMISSION_FILE',maxTenants:2,maxMessageBytes:1048576,operationTimeoutMs:5000,
      alarm:{connectionEnv:'NS_ALARM_PG',namespace:ns.alarm},consumerState:{evaluatorConfigEnv:'MULTITENANT_EVALUATOR_CONFIG'}}};
  const owner={version:1,postgres:{writerConnectionEnv:'NS_OWNER_WRITER_PG',accessConnectionEnv:'NS_OWNER_READER_PG',namespaces:{authorization:ns.authorization,credentials:ns.legacy,access:ns.access}},
    ownerPolicy:{catalogue:['api:entries:read']},resolution:{mode:'direct-alias'},tenants:api.tenants.map(({id,aliases})=>({id,aliases})),
    management:{issuer:'nightscout-compose-management',audience:'nightscout-management',purpose:'management',consumer:'compose-owner',maxLifetimeSeconds:600,keys:managementKeys}};
  const configs={api,realtime,evaluator,'tenant-admin':owner};
  const common={NS_API_SOCKET:ipc+'/api.sock',NS_ALARM_SOCKET:ipc+'/alarm.sock',NODE_EXTRA_CA_CERTS:'/run/ns-ca/ca.crt'};
  const environments={api:{...common,API_HOSTNAME:'0.0.0.0',API_PORT:'1337',MULTITENANT_PREVIEW_CONFIG:base+'/config.json',MULTITENANT_EVALUATOR_CONFIG:base+'/evaluator-metadata.json',NS_ADMISSION_FILE:base+'/admission.json',NS_API_PG:urls.api,NS_READINESS_PG:urls.readiness,NS_ALARM_PG:urls.alarm,NS_VAULT_0:tokens[0],NS_VAULT_1:tokens[1]},
    realtime:{...common,REALTIME_HOSTNAME:'0.0.0.0',REALTIME_PORT:'1339',MULTITENANT_REALTIME_CONFIG:base+'/config.json',NS_ADMISSION_FILE:base+'/admission.json',NS_REALTIME_PG:urls.realtime},
    evaluator:{...common,MULTITENANT_EVALUATOR_CONFIG:base+'/config.json',NS_EVALUATOR_PG:urls.evaluator,NS_OUTBOX_PG:urls.outbox,NS_SUPPRESSION_PG:urls.suppression},
    'tenant-admin':{...common,TENANT_ADMIN_HOSTNAME:'0.0.0.0',TENANT_ADMIN_PORT:'1341',MULTITENANT_OWNER_PREVIEW_CONFIG:base+'/config.json',NS_OWNER_WRITER_PG:urls.owner_writer,NS_OWNER_READER_PG:urls.owner_reader}};
  const protectedNamespaces=require('../../lib/server/serve/operation-cohort').protectedNamespaces;
  const participants=serviceRoles.map(role=>({id:role,roles:[role],namespaces:[...new Set([...protectedNamespaces(configs[role]),...(role==='api'?[ns.outbox]:[])])].sort(),socketPathEnv:'NS_COHORT_'+role.toUpperCase().replace('-','_')+'_SOCKET',maxMessageBytes:1048576,timeoutMs:5000}));
  const participantEnvironment=Object.fromEntries(participants.map(peer=>[peer.socketPathEnv,ipc+'/cohort-'+peer.id+'.sock']));
  const locks=[{tenant:A,key:'810001'},{tenant:B,key:'810002'}],operations={};
  for(const role of serviceRoles){operations[role]={version:2,namespace:ns.control,connectionEnv:'NS_LIFETIME_PG',locks,participantId:role,participants};Object.assign(environments[role],participantEnvironment,{NS_LIFETIME_PG:urls['lifetime_'+role.replace('-','_')],MULTITENANT_OPERATION_CONFIG:base+'/operation.json'});}
  const admission={version:1,mode:'preview-socket-allowlist',tenants:api.tenants.map(({id,aliases})=>({id,enabled:true,aliases}))};
  const remote=participants.map(peer=>({id:peer.id,roles:peer.roles,namespaces:peer.namespaces,endpoint:{socketPath:participantEnvironment[peer.socketPathEnv],maxBytes:peer.maxMessageBytes,timeoutMs:peer.timeoutMs}}));
  return {configs,environments,operations,admission,remote,locks,ui:{version:1,tenants:aliases.map(aliases=>({aliases,theme:'default'}))}};
}
function lifecycle(l) {
  const aliases={rt_checkpoint:'checkpoint',eval_checkpoint:'evaluator_checkpoint',alarm:'alarm_suppression',outbox:'notification_outbox'};
  const tables={...Object.fromEntries([...clinical,'settings'].map(name=>[name,[...(ordered.includes(name)?['tenant_insertion_ordinal']:[]),name]])),authorization:['tenant_authorization_config','tenant_authorization_roles','tenant_authorization_subjects','tenant_authorization_subject_roles','tenant_subject_admin_audit','tenant_owner_policy','tenant_owner_actors'],secrets:['secret_records','secret_audit'],legacy:['legacy_credential_config','legacy_credential_subjects'],access:['access_tenants','access_credentials','access_sessions','access_keys'],clock:['tenant_write_clock'],rt_checkpoint:['tenant_consumer_checkpoint'],eval_checkpoint:['tenant_consumer_checkpoint'],alarm:['tenant_alarm_suppression'],outbox:['tenant_notification_state','tenant_notification_heads','tenant_notification_requests']};
  const selected=catalogues();
  return {namespaces:Object.fromEntries(Object.entries(l.namespaces).filter(([name])=>name!=='control').map(([name,namespace])=>[aliases[name]||name,namespace])),
    catalogues:Object.entries(tables).map(([name,tables])=>({kind:aliases[name]||name,candidate:selected[name],tables,secrets:name==='secrets'?['secret_records']:[]}))};
}
function validateFiles(directory, docs) {
  const parsers={api:require('../../lib/server/serve/preview-config').load,realtime:require('../../lib/server/realtime/config').load,
    evaluator:require('../../lib/server/serve/evaluator-config').load,'tenant-admin':require('../../lib/server/serve/owner-preview-config').load};
  const namespaces=require('../../lib/server/serve/operation-cohort').protectedNamespaces;
  for(const role of serviceRoles){
    const env=Object.fromEntries(Object.entries(docs.environments[role]).map(([key,value])=>[key,typeof value==='string'?value.replace('/run/ns-config',path.join(directory,role)):value]));
    const parsed=parsers[role](env),operation=require('../../lib/server/serve/operation-cohort-config').load(env);
    const participant=operation.participants.find(row=>row.id===role);
    if(JSON.stringify(namespaces(parsed).sort())!==JSON.stringify(participant.namespaces))throw new TypeError('Deployment participant namespace mismatch');
  }
}
module.exports={A,B,subject,clinical,ordered,serviceRoles,quote,catalogues,layout,insertionGrants,grants,documents,lifecycle,validateFiles};
