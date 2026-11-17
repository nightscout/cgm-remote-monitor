'use strict';
// Additive v2 outbox protocol. The four historical migrations stay exact.
const legacy=require('./partition-candidate');
const {checksum,validateCatalogue}=require('../migrations/catalogue');
const {MAX_MEMBERS}=require('../pool-membership/slice');
function match(binding,intakeProfile){
 const selected=legacy.bindings(binding),profile=require('../pgstream/pool-intake-profile').validate(intakeProfile),b=profile.binding;
 if(b.namespace!==selected.checkpointNamespace||b.membershipNamespace!==selected.membershipNamespace||b.lifecycleNamespace!==selected.lifecycleNamespace||b.consumer+'-completed'!==selected.evaluatorConsumer)throw new TypeError('NOTIFICATION_INTAKE_PROFILE_BINDING');
 return {selected,profile};
}
function build({binding,intakeProfile}){
 const {selected,profile}=match(binding,intakeProfile),base=legacy.build(selected);
 const maintenance=require('./pool-notification-maintenance'),maintenanceBody=maintenance.deleteBody(profile,selected);
 let body=base.body.replace('lifetime record;','lifetime record; previous_tenant text; lifetime_found boolean; maintenance jsonb; maintenance_scope jsonb; maintenance_birth text; maintenance_role text;');
 const checkpoint='  SELECT work_owner_ordinal AS ordinal,work_assignment_revision::text AS revision INTO assignment';
 if(!body.includes(checkpoint))throw new Error('NOTIFICATION_POOL_SOURCE_MISMATCH');
 body=body.replace(checkpoint,()=>maintenanceBody+checkpoint);
 const unassigned="IF NOT FOUND OR assignment.ordinal IS NULL THEN IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END IF;";
 if(!body.includes(unassigned))throw new Error('NOTIFICATION_POOL_SOURCE_MISMATCH');
 body=body.replace(unassigned,"IF NOT FOUND OR assignment.ordinal IS NULL THEN RAISE EXCEPTION 'NOTIFICATION_ASSIGNED_CHECKPOINT' USING ERRCODE='55000'; END IF;");
 body=body.replace('SELECT members,revision::text AS revision,slice_rule INTO desired','SELECT members,partitioned,revision::text AS revision,slice_rule INTO desired');
 body=body.replace('desired.members NOT IN (1,2)',`desired.members<1 OR desired.members>${MAX_MEMBERS} OR jsonb_typeof(context->'partitioned') IS DISTINCT FROM 'boolean' OR context->>'partitioned' IS DISTINCT FROM desired.partitioned::text OR (NOT desired.partitioned AND desired.members<>1)`);
 const start=body.indexOf('  SELECT count(*) AS live_count'),end=body.indexOf('  SELECT phase,generation::text AS generation INTO lifetime',start);
 if(start<0||end<0)throw new Error('NOTIFICATION_POOL_SOURCE_MISMATCH');
 const roster=body.slice(start,end);
 body=body.slice(0,start)+'  IF desired.partitioned THEN\n'+roster+`  ELSE
    IF desired.members<>1 OR assignment.ordinal<>0 OR context->'memberId' IS DISTINCT FROM 'null'::jsonb OR EXISTS(SELECT 1 FROM ${legacy.quote(selected.membershipNamespace)}.pool_membership WHERE pool_kind='evaluator' AND lease_expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'NOTIFICATION_SINGLETON_MEMBERSHIP' USING ERRCODE='55000'; END IF;
  END IF;
`+body.slice(end);
 const lifetime=`  SELECT phase,generation::text AS generation INTO lifetime FROM ${legacy.quote(selected.lifecycleNamespace)}.tenant_lifecycle_windows WHERE tenant_id=subject;`;
 if(!body.includes(lifetime))throw new Error('NOTIFICATION_POOL_SOURCE_MISMATCH');
 body=body.replace(lifetime,`  previous_tenant:=current_setting('app.current_tenant_id',true);
  BEGIN
    PERFORM set_config('app.current_tenant_id',subject::text,true);
${lifetime}
    lifetime_found:=FOUND;
    PERFORM set_config('app.current_tenant_id',coalesce(previous_tenant,''),true);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.current_tenant_id',coalesce(previous_tenant,''),true);
    RAISE;
  END;`).replace("IF NOT FOUND OR lifetime.phase<>'active'","IF NOT lifetime_found OR lifetime.phase<>'active'");
 const up=['CREATE OR REPLACE FUNCTION pgstream_notification_partition() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $notification_partition$'+body+'$notification_partition$'];
 return Object.freeze({bindings:selected,body,maintenanceBody,READS:maintenance.READS,catalogue:{version:1,migrations:[...base.catalogue.migrations,{name:'0005_pool_notification_partition',up,checksum:checksum(up)}]}});
}
function expectedMigrations(catalogue){
 const migrations=validateCatalogue(catalogue);
 if(migrations.length!==5||migrations[4].name!=='0005_pool_notification_partition'||migrations[4].up.length!==1||!migrations[4].up[0].startsWith('CREATE OR REPLACE FUNCTION pgstream_notification_partition() RETURNS trigger '))throw new Error('NOTIFICATION_POOL_CATALOGUE');
 legacy.expectedMigrations({version:1,migrations:migrations.slice(0,4)});
 return migrations;
}
module.exports={build,match,expectedMigrations};
