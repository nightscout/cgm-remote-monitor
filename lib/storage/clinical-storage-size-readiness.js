'use strict';
const {isDeepStrictEqual}=require('node:util');
const builder=require('./clinical-storage-size-sql');
async function assertReady(connection,{namespace,domain}){
 const up=builder.build({namespace,domain}),body=up.find(sql=>sql.startsWith('CREATE FUNCTION')).split('$clinical_size$')[1];
 const row=(await connection.query(`SELECT /* clinical-storage-size-structure */
  t.relkind='r' AND t.relrowsecurity AND t.relforcerowsecurity AS secured,
  t.relowner=f.proowner AND t.relowner=n.nspowner AS same_owner,
  a.atttypid='pg_catalog.int8'::regtype AND a.attnotnull AND a.attidentity='' AND a.attgenerated='' AND a.atthasdef AS typed,
  pg_get_expr(d.adbin,d.adrelid) AS initial,
  f.prosrc AS body,f.prosecdef AS definer,f.provolatile AS volatility,f.proconfig AS config,l.lanname AS language,
  f.prorettype='pg_catalog.trigger'::regtype AND NOT f.proretset AND f.pronargs=0 AS trigger_function,
  (SELECT count(*)=1 AND bool_and(g.tgenabled='O' AND g.tgtype=21 AND g.tgfoid=f.oid AND g.tgnargs=0 AND g.tgqual IS NULL AND NOT g.tgisinternal
    AND g.tgattr::text=(SELECT attnum::text FROM pg_attribute WHERE attrelid=t.oid AND attname='doc' AND NOT attisdropped))
    FROM pg_trigger g WHERE g.tgrelid=t.oid AND g.tgname='clinical_storage_size') AS trigger_valid,
  EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=t.oid AND c.contype='c' AND c.convalidated AND pg_get_expr(c.conbin,c.conrelid)='(storage_bytes >= 0)') AS nonnegative
  FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace
  JOIN pg_attribute a ON a.attrelid=t.oid AND a.attname='storage_bytes' AND NOT a.attisdropped
  JOIN pg_attrdef d ON d.adrelid=t.oid AND d.adnum=a.attnum
  JOIN pg_proc f ON f.oid=to_regprocedure($2) JOIN pg_language l ON l.oid=f.prolang
  WHERE t.oid=to_regclass($1)`,[namespace+'.'+domain,namespace+'.clinical_storage_size()'])).rows[0];
 const checks={present:!!row,secured:row?.secured===true,sameOwner:row?.same_owner===true,typed:row?.typed===true,
  triggerFunction:row?.trigger_function===true,trigger:row?.trigger_valid===true,nonnegative:row?.nonnegative===true,
  initial:['0','0::bigint'].includes(row?.initial),body:row?.body===body,invoker:row?.definer===false,
  volatility:row?.volatility==='v',language:row?.language==='plpgsql',searchPath:isDeepStrictEqual(row?.config,['search_path=pg_catalog'])};
 const refused=Object.keys(checks).filter(key=>!checks[key]);
 if(refused.length){const error=new Error('CLINICAL_STORAGE_SIZE_ADMISSION_REFUSED');error.predicates=refused;throw error;}
}
module.exports={assertReady};
