'use strict';

// One coordinator-granted actual restricted-role metadata probe. No containers,
// schema changes, role changes, outbox effects, retries or acceptance campaign.
module.exports=async function diagnostic({env,connectionEnv,namespace,tenant,maxRows,maxBytes,timeoutMs,onObservation,kind='outbox'}) {
  if(!['outbox','suppression'].includes(kind)||!env||env.NS_NOTIFICATION_DIAGNOSTIC_NATIVE!=='1'||typeof connectionEnv!=='string'||!/^[A-Z][A-Z0-9_]{0,127}$/.test(connectionEnv)||
      typeof env[connectionEnv]!=='string'||typeof namespace!=='string'||!/^[a-z][a-z0-9_]{0,62}$/.test(namespace)||
      namespace==='public'||namespace==='information_schema'||namespace.startsWith('pg_')||typeof onObservation!=='function'||
      [maxRows,maxBytes,timeoutMs].some(value=>!Number.isSafeInteger(value)||value<1||value>2147483647)) throw new TypeError('EXPLICIT_BOUNDED_NOTIFICATION_DIAGNOSTIC_REQUIRED');
  const c=require('../../lib/tenant-notifications/contract');c.tenant(tenant);
  const scope=require('../../lib/storage/tenant-scope'),oldMode=scope.getTenancyMode();let connection,stage='connect';
  const records=[];
  let bytes=0,rows=0;
  async function observe(record) {
    bytes+=Buffer.byteLength(JSON.stringify(record));rows+=record.rows?.length||0;
    if(bytes>maxBytes||rows>maxRows)throw new Error('NOTIFICATION_DIAGNOSTIC_BOUND');
    records.push(structuredClone(record));await onObservation(structuredClone(record));
  }
  const safeCode=error=>/^[A-Z0-9_]{1,80}$/.test(error?.code||error?.message||'')?(error.code||error.message):'NOTIFICATION_DIAGNOSTIC_SQL_REFUSED';
  scope.setTenancyMode('multi');
  try {
    connection=await require('../../lib/storage/postgres-connection')({connectionString:env[connectionEnv],max:1,
      statement_timeout:timeoutMs,connectionTimeoutMillis:timeoutMs,application_name:'notification-readiness-diagnostic'});
    return await scope.withTenant(tenant,()=>connection.transaction(async()=>{
      stage='context';const context=await connection.query('SELECT current_user AS role_name,current_database() AS database,version() AS version');
      await observe({kind:'context',rows:context.rows});stage='readiness';
      try {
        const check = kind==='outbox' ? require('../../lib/tenant-notifications/readiness') : require('../../lib/server/serve/evaluator-consumer-readiness').suppression;
        await check(connection,namespace,{diagnosticMaxRows:maxRows,diagnosticMaxBytes:maxBytes,
          async onMetadata(record){stage=record.kind+(record.table?':'+record.table:'');await observe(record);}});
        return {complete:true,ready:true,stage,records};
      } catch(error) {
        if(!['NOTIFICATION_SCHEMA_UNSAFE','EVALUATOR_CONSUMER_READINESS_REFUSED'].includes(error.message))throw error;
        // The measurement is a refusal, never a passing activation. Raw rows and
        // JSON primitive types above, not a guessed canonicalisation, explain it.
        return {complete:true,ready:false,stage,code:error.message,records};
      }
    }));
  } catch(error) {return {complete:false,ready:false,stage,code:safeCode(error),records};}
  finally {try{if(connection)await connection.end();}finally{scope.setTenancyMode(oldMode);}}
};
