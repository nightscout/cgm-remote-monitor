'use strict';
// Supported synthetic fixture writes share the actual product clock transaction.
// No notification or checkpoint is fabricated; maintained pgstream observes COMMIT.
module.exports=async function clockWrite({admin,namespace,tenant,deleted=false},write){
  const scope=require('../../../lib/storage/tenant-scope'),dates=require('../../../lib/server/srv-dates');
  const connection={query:(...args)=>admin.query(...args),async transaction(work){
    await admin.query('BEGIN');try{await admin.query("SELECT set_config('app.current_tenant_id',$1,true)",[tenant]);const value=await work();const committed=await admin.query('COMMIT');if(committed.command!=='COMMIT')throw new Error('NATIVE_CLOCK_COMMIT_UNCONFIRMED');return value;}
    catch(error){await admin.query('ROLLBACK');throw error;}
  }};
  const clock=require('../../../lib/storage/postgres-write-clock')(connection,namespace);
  const prior=scope.getTenancyMode();scope.setTenancyMode('multi');
  try{return await scope.withTenant(tenant,()=>clock.transaction(async()=>{const stamp=dates.next();const value=await write(stamp);dates.recordWrite({deleted});return {stamp,value};}));}
  finally{scope.setTenancyMode(prior);}
};
