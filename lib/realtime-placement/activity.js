'use strict';
// Fixed publication-only activity reader. No pool, arbitrary SQL, callback
// verifier, transaction creation or tenant authority can enter through this API.
const admission=require('../storage/connection-admission');
const scope=require('../storage/tenant-scope');
const windows=require('../tenant-lifecycle/operation-window');
const {screen}=require('../tenant-activity/readiness');
const policy=require('../tenant-activity/policy');
const META='00000000-0000-0000-0000-000000000000';
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v)&&v!==META;
const fail=code=>Object.assign(new Error(code),{code});
function neutral(){if(scope.getTenancyMode()!=='multi'||scope.currentTenant()!==undefined)throw fail('REALTIME_RECOVERY_ACTIVITY_SCOPE');windows.assertNoAmbientScope();}
async function create({client,namespace,tenants}){
  neutral();
  if(typeof namespace!=='string'||!/^[a-z][a-z0-9_]{0,62}$/.test(namespace)||['public','information_schema'].includes(namespace)||namespace.startsWith('pg_')||!Array.isArray(tenants)||tenants.length>100000||tenants.some(t=>!uuid(t))||new Set(tenants).size!==tenants.length)throw fail('REALTIME_RECOVERY_ACTIVITY_INPUT');
  const allowed=new Set(tenants),expected=admission.assertRecoveryTransaction(client);
  const p=expected.principal,e=expected.resourceEpoch;
  if(!p||typeof p.role!=='string'||!/^[a-z][a-z0-9_]{0,62}$/.test(p.role)||typeof p.roleOid!=='string'||!/^[1-9][0-9]{0,9}$/.test(p.roleOid)||p.database!==expected.database.database||p.databaseOid!==expected.database.databaseOid||e.length!==2||e.some(v=>typeof v!=='string'||v.length<1||v.length>128))throw fail('REALTIME_RECOVERY_ACTIVITY_IDENTITY');
  let active=true,pending=null,failure=null,cleanupError=null,backendPid=null;
  const poison=error=>{failure=failure||error;return error;};
  async function query(text,values,cleanup=false){
    if(!cleanup&&(!active||failure))throw failure||fail('REALTIME_RECOVERY_ACTIVITY_CLOSED');
    admission.assertRecoveryTransaction(client);
    if(backendPid!==null&&client.processID!==backendPid)throw fail('REALTIME_RECOVERY_ACTIVITY_IDENTITY');
    const result=await client.query({text,values,query_timeout:1000});
    admission.assertRecoveryTransaction(client);
    if(backendPid!==null&&client.processID!==backendPid)throw fail('REALTIME_RECOVERY_ACTIVITY_IDENTITY');
    if(!cleanup&&(!active||failure))throw failure||fail('REALTIME_RECOVERY_ACTIVITY_CLOSED');
    return result;
  }
  try{
    await query("SET LOCAL statement_timeout='1000ms'");await query("SET LOCAL lock_timeout='1000ms'");
    const rows=(await query("SELECT current_user AS role,current_user::regrole::oid::text AS \"roleOid\",current_database() AS database,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS \"databaseOid\",pg_postmaster_start_time()::text AS epoch,pg_backend_pid() AS pid,(SELECT backend_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid()) AS birth,current_setting('transaction_read_only') AS \"readOnly\",rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows;
    const r=rows?.[0];
    if(rows?.length!==1||r.role!==p.role||r.roleOid!==p.roleOid||r.database!==p.database||r.databaseOid!==p.databaseOid||r.epoch!==e[1]||r.pid!==client.processID||!Number.isSafeInteger(r.pid)||r.pid<1||typeof r.birth!=='string'||r.birth.length<1||r.birth.length>128||r.readOnly!=='on'||r.rolsuper!==false||r.rolbypassrls!==false)throw fail('REALTIME_RECOVERY_ACTIVITY_IDENTITY');
    backendPid=r.pid;
    await query("SELECT set_config('app.current_tenant_id',$1,true)",[META]);
    await scope.withTenant(META,()=>screen({query},namespace,'reader'));
  }catch(error){active=false;throw error;}
  function readActivity(tenant){
    try{
      if(!active||failure)throw failure||fail('REALTIME_RECOVERY_ACTIVITY_CLOSED');
      if(pending)throw fail('REALTIME_RECOVERY_ACTIVITY_CONCURRENT');
      if(!allowed.has(tenant)||!uuid(tenant))throw fail('REALTIME_RECOVERY_ACTIVITY_TENANT');
      if(scope.currentTenant()!==undefined)throw fail('REALTIME_RECOVERY_ACTIVITY_SCOPE');windows.assertNoAmbientScope();
    }catch(error){poison(error);const rejected=Promise.reject(error);rejected.catch(()=>{});return rejected;}
    const operation=scope.withTenant(tenant,async()=>{
      let primary;
      try{
        await query("SELECT set_config('app.current_tenant_id',$1,true)",[tenant]);
        const rows=(await query('SELECT version::text,paused,suspended FROM "'+namespace+'".tenant_activity WHERE tenant_id=$1',[tenant])).rows;
        if(rows?.length!==1)throw fail('ACTIVITY_NOT_PROVISIONED');
        const row=rows[0],state=policy.stateOf(row),version=Number(row.version);
        if(typeof row.version!=='string'||!/^[1-9][0-9]*$/.test(row.version)||!Number.isSafeInteger(version))throw fail('ACTIVITY_UNAVAILABLE');
        return Object.freeze({tenant,version,paused:row.paused,suspended:row.suspended,state});
      }catch(error){primary=poison(error);throw error;}
      finally{
        try{await query("SELECT set_config('app.current_tenant_id',$1,true)",[META],true);}
        catch(error){cleanupError=error;poison(error);if(primary){if(Object.isExtensible(primary))primary.cleanupError=error;}else throw error;}
      }
    });
    pending=operation.then(value=>{pending=null;return value;},error=>{pending=null;throw error;});pending.catch(()=>{});return pending;
  }
  function assertClosed(){if(active||pending)throw fail('REALTIME_RECOVERY_ACTIVITY_UNAWAITED');if(failure)throw failure;}
  async function finish(){
    active=false;
    if(pending){
      poison(fail('REALTIME_RECOVERY_ACTIVITY_UNAWAITED'));
      await pending.catch(error=>{if(error!==failure&&Object.isExtensible(failure))failure.activityWorkError=error;});
    }
    assertClosed();
  }
  function rollbackSafe(){active=false;if(pending)return false;try{admission.assertRecoveryTransaction(client);return true;}catch{return false;}}
  return Object.freeze({readActivity,finish,assertClosed,rollbackSafe,get cleanupError(){return cleanupError;}});
}
module.exports={create,neutral};
