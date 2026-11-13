'use strict';

// Exact fixture-owned grants. The production readiness code remains the oracle;
// this plan never alters PUBLIC, a parent role, or an unrelated schema.
const quote = name => {if(!/^[a-z][a-z0-9_]{0,62}$/.test(name))throw new Error('JOINED_BOOTSTRAP_IDENTIFIER_REFUSED');return '"'+name+'"';};
function grants (layout) {
  const ns=layout.namespaces,roles=layout.roles,sql=[];
  const grant=(privilege,table,who)=>sql.push('GRANT '+privilege+' ON '+table+' TO '+quote(roles[who]));
  const schema=(name,who)=>sql.push('GRANT USAGE ON SCHEMA '+quote(ns[name])+' TO '+quote(roles[who]));
  const table=(name,logical=name)=>quote(ns[name])+'.'+quote(logical);
  const clinical=['entries','treatments','devicestatus','profile','food','activity'];
  for(const name of [...clinical,'settings','authorization','secrets','legacy','access','clock'])schema(name,'api');
  for(const name of [...clinical,'settings']) {
    sql.push(...require('../tenant-insertion-grants').statements({namespace:ns[name],domain:name,role:roles.api,catalogue:catalogues()[name]}));
  }
  for(const name of ['authorization','legacy','access'])sql.push('GRANT SELECT ON ALL TABLES IN SCHEMA '+quote(ns[name])+' TO '+quote(roles.api));
  grant('SELECT,INSERT',table('secrets','secret_records'),'api');grant('INSERT',table('secrets','secret_audit'),'api');
  grant('SELECT,UPDATE(last_stamp,last_delete_stamp)',table('clock','tenant_write_clock'),'api');
  for(const name of [...clinical,'settings','authorization','secrets','legacy','access','clock','alarm']) {
    schema(name,'readiness');grant('SELECT',table(name,'schema_migrations'),'readiness');
  }
  for(const [who,checkpoint] of [['realtime','rt_checkpoint'],['evaluator','eval_checkpoint']]) {
    for(const name of [...clinical,'clock',checkpoint]) {schema(name,who);grant('SELECT',table(name,'schema_migrations'),who);}
    for(const name of clinical)sql.push(...require('../tenant-insertion-grants').statements({namespace:ns[name],domain:name,role:roles[who],catalogue:catalogues()[name],mode:'reader'}));
    grant('SELECT',table('clock','tenant_write_clock'),who);
    grant('SELECT,UPDATE(checkpoint,projection,contract_digest)',table(checkpoint,'tenant_consumer_checkpoint'),who);
  }
  schema('alarm','suppression');grant('SELECT',table('alarm','tenant_alarm_suppression'),'suppression');grant('SELECT',table('alarm','schema_migrations'),'suppression');
  schema('outbox','outbox');grant('SELECT',table('outbox','schema_migrations'),'outbox');
  grant('SELECT,INSERT,UPDATE(request_id,blocked_until)',table('outbox','tenant_notification_heads'),'outbox');
  grant('SELECT,INSERT,UPDATE(state,next_at,attempt,attempt_token,attempt_until,accepted_at,receipt,cleared_at)',table('outbox','tenant_notification_requests'),'outbox');
  grant('SELECT,INSERT,UPDATE(revision,config_identity,producer)',table('outbox','tenant_notification_state'),'outbox');
  for(const name of ['alarm','authorization','access','outbox'])schema(name,'alarm');
  grant('SELECT,INSERT,UPDATE(acked_at,expires_at)',table('alarm','tenant_alarm_suppression'),'alarm');
  grant('SELECT',table('alarm','schema_migrations'),'alarm');
  for(const name of ['authorization','access'])sql.push('GRANT SELECT ON ALL TABLES IN SCHEMA '+quote(ns[name])+' TO '+quote(roles.alarm));
  grant('SELECT',table('outbox','tenant_notification_state'),'alarm');grant('SELECT',table('outbox','schema_migrations'),'alarm');
  return sql;
}
function catalogues () {
  const domains=require('../../../lib/server/serve/postgres-domains');
  const successors=require('../../../lib/server/tenant-socket-order-port').catalogues;
  return {...Object.fromEntries(['entries','treatments','devicestatus','profile','food','activity','settings'].map(name=>[name,successors[name]||domains.get(name).catalogue])),
    authorization:require('../../../lib/tenant-authorization/postgres-candidate.json'),secrets:require('../../../lib/secrets/postgres-candidate.json'),
    legacy:require('../../../lib/secrets/legacy-credentials-candidate.json'),access:require('../../../lib/tenant-authorization/access-candidate.json'),
    clock:require('../../../migrations/candidates/postgres-write-clock-v1.json'),
    rt_checkpoint:require('../../../migrations/candidates/postgres-consumer-checkpoint-v1.json'),
    eval_checkpoint:require('../../../migrations/candidates/postgres-consumer-checkpoint-v1.json'),
    alarm:require('../../../migrations/candidates/postgres-alarm-suppression-v1.json'),outbox:require('../../../lib/tenant-notifications/postgres-candidate.json')};
}
module.exports={grants,catalogues,quote};
