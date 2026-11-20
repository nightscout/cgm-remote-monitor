'use strict';

// Ordinary deployment SQL composition. Callers supply explicit namespaces and
// identities; this module does not install a selected intake profile or perform IO.
const clinical = Object.freeze(['entries','treatments','devicestatus','profile','food','activity']);
const ordered = Object.freeze(['entries','treatments','devicestatus','profile','food']);
function quote(name) {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(name) || name.startsWith('pg_')) throw new TypeError('Explicit deployment SQL identifier required');
  return '"' + name + '"';
}
function provisioningNamespaces(ns) {
  return { registry: ns.registry, legacy: ns.legacy, secrets: ns.secrets, authorization: ns.authorization,
    access: ns.access, clock: ns.clock, control: ns.control, settings: ns.display_settings, operatorPolicy: ns.operator_policy };
}
// Subsets retain the same role contract for native fixtures. Missing identities
// are omitted explicitly; arbitrary identities never acquire registry authority.
function registryGrants({namespaces: ns, roles: r}) {
  const identities = names => names.filter(name => Object.hasOwn(r, name)).map(name => r[name]);
  return require('../tenant-registry/postgres').grants({namespace:ns.registry,
    resolvers:identities(['api','owner_reader','ui_registry','realtime']),
    enumerators:identities(['realtime','evaluator','operator','placement_publisher']),
    readers:identities(['api','owner_reader'])});
}
function ownerGrants(l){
  const ns=l.namespaces,r=l.roles,sql=[];
  const schema=(name,who)=>sql.push('GRANT USAGE ON SCHEMA '+quote(ns[name])+' TO '+quote(r[who]));
  const table=(name,logical=name)=>quote(ns[name])+'.'+quote(logical);
  const grant=(privilege,name,who)=>sql.push('GRANT '+privilege+' ON '+name+' TO '+quote(r[who]));
  for(const who of ['owner_writer','owner_reader'])for(const name of ['authorization','legacy','access']){schema(name,who);grant('SELECT','ALL TABLES IN SCHEMA '+quote(ns[name]),who);}
  for(const name of [table('authorization','tenant_authorization_subjects'),table('legacy','legacy_credential_subjects')])grant('INSERT,UPDATE,DELETE',name,'owner_writer');
  grant('INSERT',table('authorization','tenant_authorization_roles'),'owner_writer');
  grant('INSERT,DELETE',table('authorization','tenant_authorization_subject_roles'),'owner_writer');
  sql.push('REVOKE SELECT ON '+table('authorization','tenant_subject_admin_audit')+' FROM '+quote(r.owner_writer));
  grant('INSERT',table('authorization','tenant_subject_admin_audit'),'owner_writer');
  for(const name of ['tenant_authorization_config','tenant_authorization_roles','tenant_owner_policy','tenant_owner_actors'])grant('UPDATE(owner_fence)',table('authorization',name),'owner_writer');
  if(r.owner_settings){
    for(const name of ['display_settings','operator_policy','owner_configuration']){
      schema(name,'owner_settings');
      grant('SELECT',table(name,'schema_migrations'),'owner_settings');
    }
    grant('SELECT,INSERT,UPDATE',table('display_settings','tenant_settings'),'owner_settings');
    grant('SELECT,INSERT',table('display_settings','tenant_settings_history'),'owner_settings');
    sql.push(...require('../tenant-settings/function-privileges').writerGrants({namespace:ns.display_settings,role:r.owner_settings}));
    grant('SELECT',table('operator_policy','tenant_operator_policy'),'owner_settings');
    grant('SELECT,UPDATE(owner_fence)',table('owner_configuration','tenant_owner_configuration_authority'),'owner_settings');
  }
  return sql;
}
function lifetimeGrants(l,roles,nativeSelection){
  const ns=l.namespaces,r=l.roles,sql=[];
  if(!Array.isArray(roles)||new Set(roles).size!==roles.length||roles.some(name=>!Object.hasOwn(r,name)))throw new TypeError('Explicit fixture lifetime identity names required');
  const schema=(name,who)=>sql.push('GRANT USAGE ON SCHEMA '+quote(ns[name])+' TO '+quote(r[who]));
  const table=(name,logical=name)=>quote(ns[name])+'.'+quote(logical);
  const grant=(privilege,name,who)=>sql.push('GRANT '+privilege+' ON '+name+' TO '+quote(r[who]));
  for(const who of roles){
    schema('control',who);for(const name of ['schema_migrations','tenant_lifecycle_windows','tenant_lifecycle_operations'])grant('SELECT',table('control',name),who);
    if (nativeSelection) sql.push(...require('../tenant-lifecycle/native-selection').servingGrants({ namespace: ns.control, role: r[who] }));
    if(who.startsWith('lifetime_')){
      grant('INSERT(tenant_id,operation_id,generation),UPDATE(finished)',table('control','tenant_lifecycle_operations'),who);
      grant('EXECUTE','FUNCTION '+quote(ns.control)+'.tenant_lifecycle_backend_birth()',who);
    }
  }
  return sql;
}
function realtimeGrants(l) {
  const ns=l.namespaces,r=l.roles,sql=[];
  const schema=(name,who)=>sql.push('GRANT USAGE ON SCHEMA '+quote(ns[name])+' TO '+quote(r[who]));
  const table=(name,logical=name)=>quote(ns[name])+'.'+quote(logical);
  const grant=(privilege,name,who)=>sql.push('GRANT '+privilege+' ON '+name+' TO '+quote(r[who]));
  for(const name of ['clock','rt_checkpoint']){schema(name,'realtime');grant('SELECT',table(name,'schema_migrations'),'realtime');}
  grant('SELECT',table('clock','tenant_write_clock'),'realtime');grant('SELECT',table('rt_checkpoint','tenant_consumer_checkpoint'),'realtime');
  // Remove the retired realtime clinical cursor surface when regenerating roles.
  for(const domain of clinical){
    sql.push('REVOKE SELECT ON '+table(domain)+' FROM '+quote(r.realtime));
    sql.push('REVOKE SELECT ON '+table(domain,'schema_migrations')+' FROM '+quote(r.realtime));
    if(ordered.includes(domain))sql.push('REVOKE SELECT ON '+table(domain,'tenant_insertion_ordinal')+' FROM '+quote(r.realtime));
    sql.push('REVOKE USAGE ON SCHEMA '+quote(ns[domain])+' FROM '+quote(r.realtime));
  }
  sql.push('REVOKE UPDATE(checkpoint,projection,contract_digest) ON '+table('rt_checkpoint','tenant_consumer_checkpoint')+' FROM '+quote(r.realtime));
  return sql;
}
function insertionGrants({namespace,domain,role,mode='serving'}) {
  const table=quote(namespace)+'.'+quote(domain),who=quote(role);
  if (!['serving','reader','restore'].includes(mode)) throw new TypeError('Explicit grant mode required');
  const isOrdered=ordered.includes(domain);
  if (mode==='reader') return ['GRANT SELECT ON '+table+' TO '+who,...(isOrdered?['GRANT SELECT ON '+quote(namespace)+'.tenant_insertion_ordinal TO '+who]:[])];
  // The windowed time column's array branch calls a catalogue function that
  // migration 0001 revokes from PUBLIC; PostgreSQL checks EXECUTE for every
  // insert or update of the generated column, taken branch or not.
  const windowFunction={entries:'window_time_ms',devicestatus:'window_time_text',treatments:'window_time_text'}[domain];
  const base=['GRANT SELECT,INSERT,UPDATE,DELETE ON '+table+' TO '+who,
    ...(windowFunction?['GRANT EXECUTE ON FUNCTION '+quote(namespace)+'.'+windowFunction+'(jsonb) TO '+who]:[])];
  if (!isOrdered) return base;
  const built=require('../tenant-lifecycle/tenant-insertion-sql').build({namespace,domain});
  return [...base,...(mode==='restore'?built.restoreGrants(role):built.servingGrants(role)),
    ...(mode==='restore'?['GRANT DELETE ON '+quote(namespace)+'.tenant_insertion_ordinal TO '+who]:[])];
}
function notificationScheduleGrants ({ namespace, owner, outboxRole, ackRole }) {
  const schema = quote(namespace);
  const schedule = schema+'.tenant_notification_schedule(text,uuid[],integer,integer,bigint)';
  const markAck = schema+'.tenant_notification_mark_ack(uuid,text)';
  return [
    ...['tenant_notification_requests','tenant_notification_state'].map(name =>
      'ALTER POLICY notification_schedule_owner ON '+schema+'.'+quote(name)+' TO '+quote(owner)),
    ...[schedule,markAck].map(fn => 'ALTER FUNCTION '+fn+' OWNER TO '+quote(owner)),
    'GRANT EXECUTE ON FUNCTION '+schedule+' TO '+quote(outboxRole),
    'GRANT EXECUTE ON FUNCTION '+markAck+' TO '+quote(ackRole)
  ];
}
function grants(l, { nativeSelection, writerDriven = require('../writer-driven').selection(process.env) === 'writer-driven' } = {}) {
  const ns=l.namespaces,r=l.roles,sql=[];
  // Writer-driven input: the api and owner settings writers mark the evaluator
  // work row pending in their own transactions (lib/writer-driven grants).
  if(writerDriven)sql.push(...require('../writer-driven').grants({namespace:ns.eval_checkpoint,roles:[r.api,...(r.owner_settings?[r.owner_settings]:[]),...(r.operator?[r.operator]:[])]}));
  const schema=(name,who)=>sql.push('GRANT USAGE ON SCHEMA '+quote(ns[name])+' TO '+quote(r[who]));
  const table=(name,logical=name)=>quote(ns[name])+'.'+quote(logical);
  const grant=(privilege,name,who)=>sql.push('GRANT '+privilege+' ON '+name+' TO '+quote(r[who]));
  for(const name of [...clinical,'settings','authorization','secrets','legacy','access','clock'])schema(name,'api');
  for(const name of [...clinical,'settings'])sql.push(...insertionGrants({namespace:ns[name],domain:name,role:r.api}));
  for(const name of ['authorization','legacy','access'])grant('SELECT','ALL TABLES IN SCHEMA '+quote(ns[name]),'api');
  grant('SELECT,INSERT',table('secrets','secret_records'),'api');grant('INSERT',table('secrets','secret_audit'),'api');
  grant('SELECT,UPDATE(last_stamp,last_delete_stamp)',table('clock','tenant_write_clock'),'api');
  for(const name of [...clinical,'settings','authorization','secrets','legacy','access','clock','alarm']){schema(name,'readiness');grant('SELECT',table(name,'schema_migrations'),'readiness');}
  for(const name of [...clinical,'clock','eval_checkpoint']){schema(name,'evaluator');grant('SELECT',table(name,'schema_migrations'),'evaluator');}
  for(const domain of clinical)sql.push(...insertionGrants({namespace:ns[domain],domain,role:r.evaluator,mode:'reader'}));
  grant('SELECT',table('clock','tenant_write_clock'),'evaluator');grant('SELECT,UPDATE(checkpoint,projection,contract_digest)',table('eval_checkpoint','tenant_consumer_checkpoint'),'evaluator');
  sql.push(...realtimeGrants(l));
  schema('secrets','owner_credentials');
  grant('SELECT',table('secrets','schema_migrations'),'owner_credentials');
  grant('SELECT,INSERT',table('secrets','secret_records'),'owner_credentials');
  grant('INSERT',table('secrets','secret_audit'),'owner_credentials');
  schema('alarm','suppression');for(const name of ['tenant_alarm_suppression','schema_migrations'])grant('SELECT',table('alarm',name),'suppression');
  schema('outbox','outbox');grant('SELECT',table('outbox','schema_migrations'),'outbox');
  grant('SELECT,INSERT,UPDATE(request_id,blocked_until)',table('outbox','tenant_notification_heads'),'outbox');
  grant('SELECT,INSERT,UPDATE(state,next_at,attempt,attempt_token,attempt_until,accepted_at,receipt,cleared_at)',table('outbox','tenant_notification_requests'),'outbox');
  grant('SELECT,INSERT,UPDATE(revision,config_identity,producer)',table('outbox','tenant_notification_state'),'outbox');
  for(const name of ['alarm','authorization','access','outbox'])schema(name,'alarm');
  grant('SELECT,INSERT,UPDATE(acked_at,expires_at)',table('alarm','tenant_alarm_suppression'),'alarm');grant('SELECT',table('alarm','schema_migrations'),'alarm');
  for(const name of ['authorization','access'])grant('SELECT','ALL TABLES IN SCHEMA '+quote(ns[name]),'alarm');
  for(const name of ['tenant_notification_state','schema_migrations'])grant('SELECT',table('outbox',name),'alarm');
  sql.push(...notificationScheduleGrants({namespace:ns.outbox,owner:l.owner,outboxRole:r.outbox,ackRole:r.alarm}));
  sql.push(...ownerGrants(l));
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
  // The private operator plane uses identities separate from every serving writer.
  schema('authorization','ownership_operator');
  for(const name of ['tenant_authorization_config','tenant_owner_policy']) grant('SELECT,UPDATE(owner_fence)',table('authorization',name),'ownership_operator');
  grant('SELECT,INSERT,UPDATE(active,can_update,delegable)',table('authorization','tenant_owner_actors'),'ownership_operator');
  schema('owner_configuration','ownership_operator');
  grant('SELECT,INSERT,UPDATE(active)',table('owner_configuration','tenant_owner_configuration_authority'),'ownership_operator');
  grant('SELECT',table('authorization','tenant_authorization_subjects'),'ownership_operator');
  grant('INSERT',table('authorization','tenant_subject_admin_audit'),'ownership_operator');
  sql.push(...require('../tenant-lifecycle/tenant-phase').phaseGrants({namespace:ns.control,role:r.ownership_operator}));
  sql.push(...require('../tenant-registry/postgres').grants({namespace:ns.registry,readers:[r.ownership_operator]}));
  sql.push(...require('../tenant-connector/postgres-sources').grants({namespaces:{settings:ns.display_settings,registry:ns.registry,secrets:ns.secrets,control:ns.control},writer:r.connector_writer}));
  const nonServing = ['operator','ownership_operator','provisioner','connector_writer','management_issuer','ui_registry','pool_member','pool_operator'];
  const serving = Object.keys(r).filter(name => !nonServing.includes(name));
  sql.push(...lifetimeGrants(l, serving, nativeSelection));
  sql.push(...require('../tenant-lifecycle/maintenance-window').operatorGrants({ namespace: ns.control, role: r.operator, nativeSelection }));
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
  // Existing-tenant authentication preparation is confined to exclusive maintenance.
  grant('UPDATE(root_version,root_verifiers,verifier_root_reference_id)',table('legacy','legacy_credential_config'),'operator');
  grant('UPDATE(verifiers,verifier_token_prefix)',table('legacy','legacy_credential_subjects'),'operator');
  grant('INSERT,UPDATE',table('legacy','legacy_data_keys'),'operator');
  // The D15 CHECK validator is an invoker function. Its default PUBLIC EXECUTE
  // would violate the private issuer/lifetime identities' exact function surface.
  sql.push('REVOKE ALL ON FUNCTION '+quote(ns.display_settings)+'.tenant_settings_values_valid(jsonb) FROM PUBLIC');
  grant('EXECUTE','FUNCTION '+quote(ns.display_settings)+'.tenant_settings_values_valid(jsonb)','provisioner');
  for(const [name,logical] of [['display_settings','tenant_settings'],['operator_policy','tenant_operator_policy']]){
    schema(name,'display_reader');grant('SELECT',table(name,'schema_migrations'),'display_reader');grant('SELECT',table(name,logical),'display_reader');
  }
  sql.push('REVOKE SELECT ON '+table('display_settings','tenant_settings_history')+' FROM '+quote(r.display_reader));
  for (const who of ['api','activity_reader']) {
    schema('control',who); grant('SELECT',table('control','schema_migrations'),who); grant('SELECT',table('control','tenant_activity'),who);
  }
  sql.push(...registryGrants(l));
  sql.push(...require('../tenant-registry/provision').provisionerGrants({namespaces:provisioningNamespaces(ns),role:r.provisioner,
    checkpoints:[{namespace:ns.rt_checkpoint},{namespace:ns.eval_checkpoint}]}));
  if(ns.pool)sql.push(...require('../pool-membership/postgres').grants({namespace:ns.pool,member:r.pool_member,operator:r.pool_operator}));
  sql.push(...require('../trusted-worker/postgres').grants({ namespaces: { activity: ns.control, clock: ns.clock, settings: ns.display_settings, operatorPolicy: ns.operator_policy }, roles: [r.evaluator, r.realtime] }));
  return sql;
}
module.exports = { grants, insertionGrants, registryGrants, provisioningNamespaces, ownerGrants, lifetimeGrants, realtimeGrants, notificationScheduleGrants };
