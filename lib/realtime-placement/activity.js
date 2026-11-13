'use strict';
// Fixed publication readers on one admitted READ ONLY backend. No pool,
// caller-selected SQL/transaction/namespace path, or verifier callback escapes.
const admission=require('../storage/connection-admission');
const scope=require('../storage/tenant-scope');
const windows=require('../tenant-lifecycle/operation-window');
const {screen}=require('../tenant-activity/readiness');
const policy=require('../tenant-activity/policy');
const META='00000000-0000-0000-0000-000000000000';
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v)&&v!==META;
const namespace=v=>typeof v==='string'&&/^[a-z][a-z0-9_]{0,62}$/.test(v)&&!['public','information_schema'].includes(v)&&!v.startsWith('pg_');
const fail=code=>Object.assign(new Error(code),{code});
function neutral(){if(scope.getTenancyMode()!=='multi'||scope.currentTenant()!==undefined)throw fail('REALTIME_RECOVERY_ACTIVITY_SCOPE');windows.assertNoAmbientScope();}
async function create({client,namespace:ns,registryNamespace,tenants}){
  neutral();
  if(!namespace(ns)||!namespace(registryNamespace))throw fail('REALTIME_RECOVERY_ACTIVITY_INPUT');
  let allowed=null,active=true,pending=null,failure=null,cleanupError=null,backendPid=null,operationKind=null;
  const poison=error=>{failure=failure||error;return error;};
  function bindAffected(ids){
    if(!active||failure||pending||allowed!==null||!Array.isArray(ids)||ids.length>100000||ids.some(t=>!uuid(t))||new Set(ids).size!==ids.length)throw poison(fail('REALTIME_RECOVERY_ACTIVITY_INPUT'));
    allowed=new Set(ids);
  }
  if(tenants!==undefined)bindAffected(tenants);
  const expected=admission.assertRecoveryTransaction(client),p=expected.principal,e=expected.resourceEpoch;
  if(!p||typeof p.role!=='string'||!/^[a-z][a-z0-9_]{0,62}$/.test(p.role)||typeof p.roleOid!=='string'||!/^[1-9][0-9]{0,9}$/.test(p.roleOid)||p.database!==expected.database.database||p.databaseOid!==expected.database.databaseOid||e.length!==2||e.some(v=>typeof v!=='string'||v.length<1||v.length>128))throw fail('REALTIME_RECOVERY_ACTIVITY_IDENTITY');
  async function query(text,values,cleanup=false){
    try{
      if(!cleanup&&(!active||failure))throw failure||fail('REALTIME_RECOVERY_ACTIVITY_CLOSED');
      admission.assertRecoveryTransaction(client);
      if(backendPid!==null&&client.processID!==backendPid)throw fail('REALTIME_RECOVERY_ACTIVITY_IDENTITY');
      const result=await client.query({text,values,query_timeout:1000});
      admission.assertRecoveryTransaction(client);
      if(backendPid!==null&&client.processID!==backendPid)throw fail('REALTIME_RECOVERY_ACTIVITY_IDENTITY');
      if(!cleanup&&(!active||failure))throw failure||fail('REALTIME_RECOVERY_ACTIVITY_CLOSED');
      return result;
    }catch(error){if(!cleanup)poison(error);throw error;}
  }
  try{
    await query("SET LOCAL statement_timeout='1000ms'");await query("SET LOCAL lock_timeout='1000ms'");
    const rows=(await query("SELECT current_user AS role,current_user::regrole::oid::text AS \"roleOid\",current_database() AS database,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS \"databaseOid\",pg_postmaster_start_time()::text AS epoch,pg_backend_pid() AS pid,(SELECT backend_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid()) AS birth,current_setting('transaction_read_only') AS \"readOnly\",current_setting('transaction_isolation') AS isolation,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows;
    const r=rows?.[0];
    if(rows?.length!==1||r.role!==p.role||r.roleOid!==p.roleOid||r.database!==p.database||r.databaseOid!==p.databaseOid||r.epoch!==e[1]||r.pid!==client.processID||!Number.isSafeInteger(r.pid)||r.pid<1||typeof r.birth!=='string'||r.birth.length<1||r.birth.length>128||r.readOnly!=='on'||r.isolation!=='read committed'||r.rolsuper!==false||r.rolbypassrls!==false)throw fail('REALTIME_RECOVERY_ACTIVITY_IDENTITY');
    backendPid=r.pid;
    await query("SELECT set_config('app.current_tenant_id',$1,true)",[META]);
    await scope.withTenant(META,()=>screen({query},ns,'reader'));
  }catch(error){active=false;throw error;}
  function reject(error){poison(error);const p=Promise.reject(error);p.catch(()=>{});return p;}
  function tracked(tenant,kind,fn){
    try{
      if(!active||failure)throw failure||fail('REALTIME_RECOVERY_ACTIVITY_CLOSED');
      if(pending)throw fail('REALTIME_RECOVERY_ACTIVITY_CONCURRENT');
      if(scope.currentTenant()!==undefined)throw fail('REALTIME_RECOVERY_ACTIVITY_SCOPE');windows.assertNoAmbientScope();
    }catch(error){return reject(error);}
    operationKind=kind;
    const operation=scope.withTenant(tenant,async()=>{
      let primary;
      try{
        await query("SELECT set_config('app.current_tenant_id',$1,true)",[tenant]);
        const result=await fn();
        if(!active||failure)throw failure||fail('REALTIME_RECOVERY_ACTIVITY_CLOSED');
        return result;
      }catch(error){primary=poison(error);throw error;}
      finally{
        try{await query("SELECT set_config('app.current_tenant_id',$1,true)",[META],true);}
        catch(error){cleanupError=error;poison(error);if(primary){if(Object.isExtensible(primary))primary.cleanupError=error;}else throw error;}
      }
    });
    pending=operation.then(value=>{pending=null;operationKind=null;return value;},error=>{pending=null;operationKind=null;throw error;});pending.catch(()=>{});return pending;
  }
  function tenantOperation(tenant,kind,fn){
    if(!allowed?.has(tenant)||!uuid(tenant))return reject(fail('REALTIME_RECOVERY_ACTIVITY_TENANT'));
    return tracked(tenant,kind,fn);
  }
  function readActivity(tenant){return tenantOperation(tenant,'activity',async()=>{
    const rows=(await query('SELECT version::text,paused,suspended FROM "'+ns+'".tenant_activity WHERE tenant_id=$1',[tenant])).rows;
    if(rows?.length!==1)throw fail('ACTIVITY_NOT_PROVISIONED');
    const row=rows[0],state=policy.stateOf(row),version=Number(row.version);
    if(typeof row.version!=='string'||!/^[1-9][0-9]*$/.test(row.version)||!Number.isSafeInteger(version))throw fail('ACTIVITY_UNAVAILABLE');
    return Object.freeze({tenant,version,paused:row.paused,suspended:row.suspended,state});
  });}
  function assertActive(tenant){return tenantOperation(tenant,'lifecycle',async()=>{
    const rows=(await query('SELECT phase,lock_key::text AS lock_key FROM "'+ns+'".tenant_lifecycle_windows WHERE tenant_id=$1',[tenant])).rows;
    if(rows?.length!==1||rows[0].phase!=='active'||rows[0].lock_key!==require('../tenant-registry/rules').lockKey(tenant))throw fail('LIFECYCLE_WINDOW_SUSPENDED');
  });}
  const unsupported=()=>{throw poison(fail('REALTIME_RECOVERY_REGISTRY_METHOD'));};
  // The actual registry implementation constructs every statement and preserves
  // its full function-version/catalogue screen. Its other lower-port methods
  // exist only to fail closed; no public raw query/readOnly facade is returned.
  const rawRegistry=require('../tenant-registry/postgres').create({namespace:registryNamespace,connection:Object.freeze({
    readOnly(text,values){if(operationKind!=='registry'||scope.currentTenant()!==META)return Promise.reject(poison(fail('REALTIME_RECOVERY_REGISTRY_METHOD')));return query(text,values);},
    scanTenants:unsupported,withTenant:unsupported,query:unsupported
  })});
  const registry=Object.freeze({
    revision(...args){if(args.length)return reject(fail('REALTIME_RECOVERY_REGISTRY_METHOD'));return tracked(META,'registry',()=>rawRegistry.revision());},
    page(...args){const [after=null,limit=1000]=args;if(args.length>2||after!==null&&!uuid(after)||!Number.isSafeInteger(limit)||limit<1||limit>1000)return reject(fail('REALTIME_RECOVERY_REGISTRY_METHOD'));return tracked(META,'registry',()=>rawRegistry.page(after,limit));},
    lookup:unsupported,alias:unsupported,attributes:unsupported,enumerate:unsupported,scanTenants:unsupported
  });
  function assertClosed(){if(active||pending)throw fail('REALTIME_RECOVERY_ACTIVITY_UNAWAITED');if(failure)throw failure;}
  function assertBeforeCommit(){assertClosed();admission.assertRecoveryTransaction(client);}
  async function finish(){
    active=false;
    if(pending){
      poison(fail('REALTIME_RECOVERY_ACTIVITY_UNAWAITED'));
      await pending.catch(error=>{if(error!==failure&&Object.isExtensible(failure))failure.activityWorkError=error;});
    }
    assertClosed();
  }
  function rollbackSafe(){active=false;if(pending)return false;try{admission.assertRecoveryTransaction(client);return true;}catch{return false;}}
  return Object.freeze({readActivity,registry,bindAffected,assertActive,finish,assertClosed,assertBeforeCommit,rollbackSafe,get cleanupError(){return cleanupError;}});
}
module.exports={create,neutral};
