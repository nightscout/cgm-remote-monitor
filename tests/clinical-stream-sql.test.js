'use strict';
const assert=require('node:assert/strict');
const sql=require('../lib/storage/clinical-stream-sql'),state=require('../lib/storage/clinical-stream-state');
const A='11111111-1111-4111-8111-111111111111',digest='a'.repeat(64);
const event={action:'I',xid:5,lsn:'0/20',columns:[{name:'tenant_id',value:A},{name:'id_kind',value:'string'},{name:'_id',value:'one'},{name:'doc',type:'jsonb',value:'{"_id":"one","date":1,"sgv":123,"extension":{"kept":true}}'},{name:'storage_bytes',value:80}],identity:null};
function fixture({holdCommit=false,projection=[state.empty()]}={}){
 const calls=[];let commit,release;
 const pending=new Promise(resolve=>{commit=()=>resolve({command:'COMMIT'});});
 const client={query:async(text,values)=>{calls.push({text,values});if(text==='COMMIT')return holdCommit?pending:{command:'COMMIT'};if(text.startsWith('SELECT '))return {rows:[{projection,contract_digest:digest}]};return {rowCount:1};},release:error=>{release=error||true;}};
 return {calls,commit,get released(){return release;},options:{pool:{connect:async()=>client},observeBackend:async()=>{},table:'synthetic_work.tenant_consumer_checkpoint',consumer:'evaluator-synthetic',tenant:A,data:event,domain:'entries',snapshotDigest:digest,maxRows:10,maxBytes:10000}};
}
describe('actual clinical stream SQL transport receipt',()=>{
 it('commits recoverable staged payload before receipt resolves, without clinical source reads or evaluation',async()=>{
  const f=fixture({holdCommit:true});let acknowledged=false;
  const work=sql.accept(f.options).then(()=>{acknowledged=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(acknowledged,false);assert(f.calls.some(c=>c.text.startsWith('UPDATE ')));
  assert(f.calls.every(c=>!c.text.includes('.entries')),'NO_CLINICAL_SOURCE_ACQUISITION');
  assert(f.calls.find(c=>c.text.startsWith('SELECT')).text.includes("-'rows'"),'NO_WARM_ROWSET_TRANSFER_ON_RAW_ACK');
  const update=f.calls.find(c=>c.text.startsWith('UPDATE'));const staged=JSON.parse(update.values[2])[0].staged;
  assert.equal(staged[0].row.doc.extension.kept,true);
  f.commit();await work;assert.equal(acknowledged,true);assert.equal(f.released,true);
 });
 it('accepts only a recoverable bounded-gap marker for valid oversized input, keeping the serial feed available to neighbors',async()=>{
  const f=fixture(),large=structuredClone(event);large.columns.find(c=>c.name==='doc').value=JSON.stringify({_id:'one',extension:'x'.repeat(2000)});
  await sql.accept({...f.options,data:large,maxBytes:512});
  const update=f.calls.find(c=>c.text.startsWith('UPDATE')),saved=JSON.parse(update.values[2])[0];
  assert(!update.text.includes('projection->0)||'),'GAP_MUST_REPLACE_OLD_CACHE_METADATA');assert.equal(saved.ready,false);assert.equal(saved.gap,'bytes');assert.deepEqual(saved.staged,[]);assert(f.calls.some(c=>c.text==='COMMIT'));
 });
 it('keeps exact and older raw replay durable without rewriting input or output',async()=>{
  const journal=require('../lib/storage/storage-event-journal');
  const normalize=value=>Array.isArray(value)?value.map(normalize):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,normalize(v)])):value;
  // PostgreSQL JSONB normalizes key order before returning the saved receipt.
  const limits={maxRows:10,maxBytes:10000},saved=normalize(state.stage(null,state.eventOf('entries',event),limits)),tail=journal.append(null,'entries',event,limits);
  for(const data of [event,{...event,lsn:'0/19'}]){
   const f=fixture({projection:[saved,tail]});
   await sql.accept({...f.options,data,completedConsumer:'evaluator-synthetic-completed',completedDigest:digest});
   assert.equal(f.calls.filter(c=>c.text.startsWith('UPDATE ')).length,0,'REPLAY_REWRITES_DURABLE_STATE');
   assert(f.calls.some(c=>c.text.endsWith('FOR UPDATE')),'REPLAY_CONTRACT_LOCK');
   assert(f.calls.some(c=>c.text==='COMMIT'),'REPLAY_CONFIRMED_COMMIT');
  }
  // A different COPY row at the same LSN still needs its own durable receipt.
  const f=fixture({projection:[saved,tail]}),other=structuredClone(event);
  other.columns.find(c=>c.name==='_id').value='two';other.columns.find(c=>c.name==='doc').value='{"_id":"two","sgv":124}';
  await sql.accept({...f.options,data:other,completedConsumer:'evaluator-synthetic-completed',completedDigest:digest});
  assert.equal(f.calls.filter(c=>c.text.startsWith('UPDATE ')).length,2,'DISTINCT_EQUAL_LSN_ROW_LOST');
 });
 it('reads the completed engine instant with the input, keeping clock receipt atomic',async()=>{
  const f=fixture(),saved=state.bootstrap(null,{checkpoint:0,signature:{stamp:0,deleted:0},rows:[],policy:{kind:'clinical-window-v1',at:0,devicestatusMs:86400000}},{maxRows:10,maxBytes:10000});
  const client={release:()=>{},query:async(text,values)=>{
   f.calls.push({text,values});
   if(text==='COMMIT')return {command:'COMMIT'};
   if(text.startsWith('SELECT ')&&text.includes('ORDER BY tenant_id'))return {rows:[{tenant:A,contract_digest:digest,work_version:2,work_observed:[],work_completed:[],work_observed_at:[],work_pending_at:null,work_due_at:null,work_enabled:true,work_activity_enabled:true,work_lifecycle_enabled:true,delivery_revision:'0',delivery_ack_revision:'0'}]};
   if(text.startsWith('SELECT '))return {rows:[{projection:[saved],contract_digest:digest,checkpoint:0,evaluated_at:100}]};
   return {rowCount:1};
  }};
  await sql.accept({...f.options,pool:{connect:async()=>client},domain:undefined,data:{xid:5,lsn:'0/30',columns:[{name:'last_stamp',value:'1'},{name:'last_delete_stamp',value:'0'}]},completedConsumer:'evaluator-synthetic-completed',completedDigest:digest});
  assert.equal(f.calls.filter(c=>c.text.startsWith('SELECT ')).length,2,'REDUNDANT_ENGINE_INSTANT_ROUNDTRIP');
  assert(f.calls[1].text.includes("'result'->'now'"));
  const input=f.calls.find(c=>c.text.startsWith('UPDATE ')&&c.text.includes('projection=jsonb_build_array'));
  assert.equal(JSON.parse(input.values[2])[0].policy.at,100);
  assert(f.calls.findIndex(c=>c.text.includes('work_observed=p.observed'))<f.calls.findIndex(c=>c.text==='COMMIT'));
 });
 it('refuses invalid transaction identity before taking a physical connection',async()=>{
  let connected=false;const f=fixture();await assert.rejects(sql.accept({...f.options,data:{...event,xid:undefined},pool:{connect:async()=>{connected=true;}}}),/XID/);assert.equal(connected,false);
 });
 it('control: omitting actual COMMIT await fails the receipt oracle and restoration passes',async()=>{
  const fs=require('node:fs'),vm=require('node:vm'),{createRequire}=require('node:module'),file=require.resolve('../lib/storage/clinical-stream-sql'),source=fs.readFileSync(file,'utf8');
  const needle="await client.query('COMMIT')";assert(source.includes(needle));
  const broken={exports:{}};vm.runInThisContext('(function(require,module,exports){'+source.replace(needle,"({command:'COMMIT'})")+'\n})',{filename:file})(createRequire(file),broken,broken.exports);
  const check=async module=>{const f=fixture({holdCommit:true});let done=false;const pending=module.accept(f.options).then(()=>{done=true;});await new Promise(resolve=>setImmediate(resolve));const early=done;f.commit();await pending;assert.equal(early,false,'EARLY_CLINICAL_ACK');};
  await assert.rejects(check(broken.exports),/EARLY_CLINICAL_ACK/);await check(sql);
 });
});
