'use strict';

// Synthetic registry test-plan layout only. These pure assemblies delegate to
// core catalogues/grant builders and do not import the retired deployment plan.
// No role documents, static tenant configuration, credentials or IO live here.
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
    eval_checkpoint:require('../../migrations/candidates/postgres-evaluator-work-v2.json'), alarm:require('../../migrations/candidates/postgres-alarm-suppression-v1.json'),
    outbox:require('../../lib/tenant-notifications/postgres-candidate.json'),control:require('../../lib/tenant-lifecycle/postgres-candidate.json')};
}
function layout(prefix = 'nsdemo') {
  quote(prefix);
  if (prefix.length > 24) throw new TypeError('Deployment prefix too long');
  const names = ['api','readiness','realtime','evaluator','alarm','suppression','outbox','owner_writer','owner_reader','root_writer','operator','ownership_operator',
    ...serviceRoles.map(name=>'lifetime_'+name.replace('-','_'))];
  return {prefix,owner:prefix+'_owner',namespaces:Object.fromEntries(Object.keys(catalogues()).map(name=>[name,prefix+'_'+name])),
    roles:Object.fromEntries(names.map(name=>[name,prefix+'_'+name])),mount:prefix+'_transit'};
}
function insertionGrants({namespace,domain,role,mode='serving'}) {
  const table=quote(namespace)+'.'+quote(domain),who=quote(role);
  if (!['serving','reader','restore'].includes(mode)) throw new TypeError('Explicit grant mode required');
  const isOrdered=ordered.includes(domain);
  if (mode==='reader') return ['GRANT SELECT ON '+table+' TO '+who,...(isOrdered?['GRANT SELECT ON '+quote(namespace)+'.tenant_insertion_ordinal TO '+who]:[])];
  const windowFunction={entries:'window_time_ms',devicestatus:'window_time_text',treatments:'window_time_text'}[domain];
  const base=['GRANT SELECT,INSERT,UPDATE,DELETE ON '+table+' TO '+who,
    ...(windowFunction?['GRANT EXECUTE ON FUNCTION '+quote(namespace)+'.'+windowFunction+'(jsonb) TO '+who]:[])];
  if (domain==='entries' || domain==='treatments') {
    base.push('GRANT EXECUTE ON FUNCTION '+quote(namespace)+'.clinical_instant_ms(jsonb) TO '+who);
  }
  if (!isOrdered) return base;
  const built=require('../../lib/tenant-lifecycle/tenant-insertion-sql').build({namespace,domain});
  return [...base,...(mode==='restore'?built.restoreGrants(role):built.servingGrants(role)),
    ...(mode==='restore' && (domain==='entries' || domain==='treatments') ? ['GRANT INSERT(received_ms) ON '+table+' TO '+who] : []),
    ...(mode==='restore'?['GRANT DELETE ON '+quote(namespace)+'.tenant_insertion_ordinal TO '+who]:[])];
}
const { ownerGrants, lifetimeGrants } = require('../../lib/server/ordinary-deployment-grants');
function grants(l) {
  const ns=l.namespaces,r=l.roles,sql=[];
  const schema=(name,who)=>sql.push('GRANT USAGE ON SCHEMA '+quote(ns[name])+' TO '+quote(r[who]));
  const table=(name,logical=name)=>quote(ns[name])+'.'+quote(logical);
  const grant=(privilege,name,who)=>sql.push('GRANT '+privilege+' ON '+name+' TO '+quote(r[who]));
  for(const name of [...clinical,'settings','authorization','secrets','legacy','access','clock'])schema(name,'api');
  for(const name of [...clinical,'settings'])sql.push(...insertionGrants({namespace:ns[name],domain:name,role:r.api}));
  for(const name of ['authorization','legacy','access'])grant('SELECT','ALL TABLES IN SCHEMA '+quote(ns[name]),'api');
  grant('SELECT,INSERT',table('secrets','secret_records'),'api');grant('INSERT',table('secrets','secret_audit'),'api');
  grant('SELECT,UPDATE(last_stamp,last_delete_stamp)',table('clock','tenant_write_clock'),'api');
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
  sql.push(...ownerGrants(l));
  sql.push(...require('../../lib/tenant-activity/postgres').grants({ namespace: ns.control, reader: r.api }));
  // Tenant root (API_SECRET) subject administration on the api role: the owner-aware
  // writer's root plane. Reads owner actor rows for the last-owner guard, never locks
  // or writes them; no access schema, no legacy_credential_config, no audit reads.
  for(const name of ['authorization','legacy'])schema(name,'root_writer');
  grant('SELECT,INSERT,UPDATE,DELETE',table('authorization','tenant_authorization_subjects'),'root_writer');
  grant('SELECT,INSERT,UPDATE,DELETE',table('legacy','legacy_credential_subjects'),'root_writer');
  // Root alone edits role permissions and deletes unheld roles (decision root-role-edit-delete).
  grant('SELECT,INSERT,DELETE,UPDATE(permissions,owner_fence)',table('authorization','tenant_authorization_roles'),'root_writer');
  grant('SELECT,INSERT,DELETE',table('authorization','tenant_authorization_subject_roles'),'root_writer');
  grant('INSERT',table('authorization','tenant_subject_admin_audit'),'root_writer');
  for(const name of ['tenant_authorization_config','tenant_owner_policy'])grant('SELECT,UPDATE(owner_fence)',table('authorization',name),'root_writer');
  grant('SELECT',table('authorization','tenant_owner_actors'),'root_writer');
  // The admin role's ownership-operations identity (lib/tenant-ownership/postgres.js SHAPE): reads
  // authority rows, row-locks config/policy through UPDATE(owner_fence), changes only owner actor
  // rows and appends audit. No DELETE, no table UPDATE. In the lifecycle control namespace it reads
  // the tenant phase only (lib/tenant-lifecycle/tenant-phase.js): no operation registration, no
  // window or ceremony write. No clinical table, so the restore census accepts its backends.
  schema('authorization','ownership_operator');
  for(const name of ['tenant_authorization_config','tenant_owner_policy'])grant('SELECT,UPDATE(owner_fence)',table('authorization',name),'ownership_operator');
  grant('SELECT,INSERT,UPDATE(active,can_update,delegable)',table('authorization','tenant_owner_actors'),'ownership_operator');
  grant('SELECT',table('authorization','tenant_authorization_subjects'),'ownership_operator');
  grant('INSERT',table('authorization','tenant_subject_admin_audit'),'ownership_operator');
  sql.push(...require('../../lib/tenant-lifecycle/tenant-phase').phaseGrants({namespace:ns.control,role:r.ownership_operator}));
  // Decision root-writer-fenced: root_writer joins the lower-role window reads; the api opens its
  // subject-admin store connection under the tenant operation window, whose admission reads these.
  sql.push(...lifetimeGrants(l,Object.keys(r).filter(name=>!['operator','ownership_operator'].includes(name))));
  sql.push(...require('../../lib/tenant-lifecycle/maintenance-window').operatorGrants({namespace:ns.control,role:r.operator}));
  sql.push('GRANT pg_read_all_stats TO '+quote(r.operator));
  // Restore's key-retention gate (lib/tenant-lifecycle/key-retention.js admitRestore/markRestored):
  // SELECT request_id,phase,retained_at,retain_until ... WHERE tenant_id=$1 FOR UPDATE, then
  // UPDATE ... SET phase,restored_at WHERE request_id,tenant_id,phase. Nothing else in that table.
  grant('SELECT(request_id,tenant_id,phase,retained_at,retain_until),UPDATE(phase,restored_at)',table('control','tenant_lifecycle_key_retention'),'operator');
  for(const name of Object.keys(ns).filter(name=>name!=='control')){
    schema(name,'operator');grant('SELECT','ALL TABLES IN SCHEMA '+quote(ns[name]),'operator');
    if([...clinical,'settings'].includes(name))sql.push(...insertionGrants({namespace:ns[name],domain:name,role:r.operator,mode:'restore'}));
  }
  grant('UPDATE(last_stamp)',table('clock','tenant_write_clock'),'operator');
  grant('UPDATE('+require('../../lib/pgstream/work-state').COLUMNS.join(',')+')',table('eval_checkpoint','tenant_consumer_checkpoint'),'evaluator');
  return sql;
}
function lifecycle(l) {
  const aliases={rt_checkpoint:'checkpoint',eval_checkpoint:'evaluator_checkpoint',alarm:'alarm_suppression',outbox:'notification_outbox'};
  const tables={...Object.fromEntries([...clinical,'settings'].map(name=>[name,[...(ordered.includes(name)?['tenant_insertion_ordinal']:[]),name]])),authorization:['tenant_authorization_config','tenant_authorization_roles','tenant_authorization_subjects','tenant_authorization_subject_roles','tenant_subject_admin_audit','tenant_owner_policy','tenant_owner_actors'],secrets:['secret_records','secret_audit'],legacy:['legacy_credential_config','legacy_credential_subjects'],access:['access_tenants','access_credentials','access_sessions','access_keys','management_session_requests'],clock:['tenant_write_clock'],rt_checkpoint:['tenant_consumer_checkpoint'],eval_checkpoint:['tenant_consumer_checkpoint'],alarm:['tenant_alarm_suppression'],outbox:['tenant_notification_state','tenant_notification_heads','tenant_notification_requests']};
  const selected=catalogues();
  return {namespaces:Object.fromEntries(Object.entries(l.namespaces).filter(([name])=>name!=='control').map(([name,namespace])=>[aliases[name]||name,namespace])),
    catalogues:Object.entries(tables).map(([name,tables])=>({kind:aliases[name]||name,candidate:selected[name],tables,secrets:name==='secrets'?['secret_records']:[]}))};
}

module.exports = { A, B, subject, clinical, ordered, serviceRoles, quote, catalogues, layout, insertionGrants, ownerGrants, lifetimeGrants, grants, lifecycle };
