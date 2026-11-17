'use strict';
const assert=require('node:assert/strict');
const work=require('../lib/pgstream/work-state');
const A='11111111-1111-4111-8111-111111111111',digest='a'.repeat(64);
function fixture(row={tenant:A,contract_digest:digest,work_version:0,empty:true}){
 const calls=[];let durable={...row},pending;
 const client={release(){},async query(sql,args){calls.push(sql);
  if(sql==='BEGIN'){pending={...durable};return {};}
  if(sql==='ROLLBACK'){pending=null;return {};}
  if(sql==='COMMIT'){durable=pending;pending=null;return {command:'COMMIT'};}
  if(sql.startsWith('SELECT tenant_id'))return {rows:[{...pending}]};
  if(sql.startsWith('UPDATE')){assert.equal(pending.empty,true);pending.work_version=2;pending.empty=false;return {rowCount:1};}
  throw Error('UNEXPECTED_SQL');
 }};
 return {calls,read:()=>({...durable}),options:{pool:{connect:async()=>client},observeBackend:async()=>{},table:'synthetic.tenant_consumer_checkpoint',consumer:'evaluator-test-completed',digest,tenants:[A]}};
}
describe('current typed work admission',()=>{
 it('initializes fresh rows once and reads only compact admission metadata',async()=>{
  const f=fixture();await work.admit(f.options);assert.equal(f.read().work_version,2);await work.admit(f.options);
  assert.equal(f.calls.filter(sql=>sql.startsWith('UPDATE')).length,1);
  assert(f.calls.filter(sql=>sql.startsWith('SELECT')).every(sql=>sql.includes('projection IS NULL AS empty')&&!sql.includes('->')),'ADMISSION_MUST_NOT_READ_PAYLOAD');
 });
 it('refuses old/nonempty/foreign rows and preserves the original',async()=>{
  for(const patch of [{empty:false},{work_version:1},{contract_digest:'b'.repeat(64)}]){
   const f=fixture({tenant:A,contract_digest:digest,work_version:0,empty:true,...patch}),before=f.read();
   await assert.rejects(work.admit(f.options),/EVALUATOR_OUTPUT_CONTRACT/);assert.deepEqual(f.read(),before);assert(!f.calls.some(sql=>sql.startsWith('UPDATE')));
  }
 });
 it('control: removing nonempty refusal reaches the SQL write boundary; restoration refuses before update',async()=>{
  const control=require('./lib/clinical-working-set/control');
  const broken=control('../lib/pgstream/work-state',"if(row.work_version!==0||!row.empty)throw new Error('EVALUATOR_OUTPUT_CONTRACT');",'');
  async function criterion(admit){const f=fixture({tenant:A,contract_digest:digest,work_version:0,empty:false});await assert.rejects(admit(f.options),/EVALUATOR_OUTPUT_CONTRACT/);assert(!f.calls.some(sql=>sql.startsWith('UPDATE')),'OLD_STATE_MUST_NOT_BE_REPLACED');}
  await assert.rejects(criterion(broken.admit));await criterion(work.admit);
 });
});
