'use strict';
const assert=require('node:assert/strict'),{randomBytes}=require('node:crypto'),{Client}=require('pg');
const {optInSuite}=require('./support/opt-in');
const authority=require('../lib/pgstream/receipt-authority'),rules=require('../lib/tenant-registry/rules');
const uri=process.env.NS_TEST_POSTGRES_ADMIN_URI,A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
optInSuite(uri,'NS_TEST_POSTGRES_ADMIN_URI')('native intake authority under read-only lifecycle grants',function(){
 this.timeout(15000);
 const namespace='synthetic_receipt_'+randomBytes(5).toString('hex'),role=namespace+'_reader',generation='a'.repeat(32),table='"'+namespace+'".tenant_lifecycle_windows';
 let admin,reader,available=true,fence;
 before(async()=>{
  admin=new Client({connectionString:uri});await admin.connect();const password=randomBytes(24).toString('hex');
  await admin.query("CREATE ROLE "+role+" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '"+password+"'");
  await admin.query('CREATE SCHEMA "'+namespace+'";CREATE TABLE '+table+'(tenant_id uuid PRIMARY KEY,lock_key bigint UNIQUE,generation bigint,phase text);ALTER TABLE '+table+' ENABLE ROW LEVEL SECURITY;ALTER TABLE '+table+' FORCE ROW LEVEL SECURITY;CREATE POLICY tenant ON '+table+" USING(tenant_id=NULLIF(current_setting('app.current_tenant_id',true),'')::uuid);GRANT USAGE ON SCHEMA \""+namespace+'" TO '+role+';GRANT SELECT ON '+table+' TO '+role);
  await admin.query('INSERT INTO '+table+" VALUES($1,$2,1,'active'),($3,$4,2,'suspended')",[A,rules.lockKey(A),B,rules.lockKey(B)]);
  const address=new URL(uri);address.username=role;address.password=password;reader=new Client({connectionString:address.href});await reader.connect();
  fence=authority.create({namespace,generation,available:()=>available});
 });
 after(async()=>{await reader?.end();if(admin){await admin.query('DROP SCHEMA IF EXISTS "'+namespace+'" CASCADE;DROP ROLE IF EXISTS '+role);await admin.end();}});
 it('reproduces the unbound RLS and forbidden row-lock failures, then accepts active and suspended intake without UPDATE',async()=>{
  await reader.query('BEGIN');assert.equal((await reader.query('SELECT generation FROM '+table+' WHERE tenant_id=$1',[A])).rows.length,0,'UNBOUND_LIFECYCLE_READ_MUST_NOT_BYPASS_RLS');
  await assert.rejects(reader.query('SELECT generation FROM '+table+' WHERE tenant_id=$1 FOR SHARE',[A]),error=>error.code==='42501');await reader.query('ROLLBACK');
  for(const [tenant,expected]of [[A,'1'],[B,'2']]){await reader.query('BEGIN');try{assert.equal(await fence(reader,tenant),generation+':'+expected);assert.equal((await reader.query('SELECT has_table_privilege(current_user,$1,\'UPDATE\') AS writes',[table])).rows[0].writes,false);await reader.query('COMMIT');}catch(error){await reader.query('ROLLBACK');throw error;}}
 });
 it('holds the existing maintenance fence through COMMIT and refuses an exclusive maintenance owner',async()=>{
  await reader.query('BEGIN');await fence(reader,A);
  assert.equal((await admin.query('SELECT pg_try_advisory_lock($1::bigint) AS held',[rules.lockKey(A)])).rows[0].held,false,'RESTORE_MUST_NOT_CROSS_RECEIPT_COMMIT');
  await reader.query('COMMIT');await admin.query('SELECT pg_advisory_lock($1::bigint)',[rules.lockKey(A)]);
  try{await reader.query('BEGIN');await assert.rejects(fence(reader,A),/MAINTENANCE_FENCE/);await reader.query('ROLLBACK');}finally{await admin.query('SELECT pg_advisory_unlock($1::bigint)',[rules.lockKey(A)]);}
 });
 it('control: removing the transaction lock permits maintenance to cross a checked receipt',async()=>{
  const withoutLock=require('./lib/clinical-working-set/control')('../lib/pgstream/receipt-authority',
   "const lock=(await client.query('SELECT pg_try_advisory_xact_lock_shared($1::bigint) AS held',[key])).rows[0];",
   "const lock={held:true};").create({namespace,generation,available:()=>available});
  async function verify(assertFence){
   await reader.query('BEGIN');
   try{
    await assertFence(reader,A);
    const key=rules.lockKey(A),held=(await admin.query('SELECT pg_try_advisory_lock($1::bigint) AS held',[key])).rows[0].held;
    if(held)await admin.query('SELECT pg_advisory_unlock($1::bigint)',[key]);
    assert.equal(held,false,'RESTORE_CROSSED_CHECKED_RECEIPT');
   }finally{await reader.query('ROLLBACK');}
  }
  await verify(fence);
  await assert.rejects(verify(withoutLock),/RESTORE_CROSSED_CHECKED_RECEIPT/);
  await verify(fence);
 });
 it('refuses changed registry lock identity and lost receiver ownership',async()=>{
  await admin.query('UPDATE '+table+' SET lock_key=lock_key+1 WHERE tenant_id=$1',[A]);await reader.query('BEGIN');await assert.rejects(fence(reader,A),/RESTORE_FENCE/);await reader.query('ROLLBACK');
  available=false;await reader.query('BEGIN');await assert.rejects(fence(reader,B),/OWNER_FENCE/);await reader.query('ROLLBACK');
 });
});
