'use strict';
const assert=require('node:assert/strict');
const sql=require('../lib/storage/clinical-stream-sql'),state=require('../lib/storage/clinical-stream-state');
const A='11111111-1111-4111-8111-111111111111',digest='a'.repeat(64);
const event={action:'I',xid:5,lsn:'0/20',columns:[{name:'tenant_id',value:A},{name:'id_kind',value:'string'},{name:'_id',value:'one'},{name:'doc',type:'jsonb',value:'{"_id":"one","date":1,"sgv":123,"extension":{"kept":true}}'},{name:'storage_bytes',value:80}],identity:null};
function fixture({holdCommit=false}={}){
 const calls=[];let commit,release;
 const pending=new Promise(resolve=>{commit=()=>resolve({command:'COMMIT'});});
 const client={query:async(text,values)=>{calls.push({text,values});if(text==='COMMIT')return holdCommit?pending:{command:'COMMIT'};if(text.startsWith('SELECT '))return {rows:[{projection:[state.empty()],contract_digest:digest}]};return {rowCount:1};},release:error=>{release=error||true;}};
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
  assert.equal(saved.ready,false);assert.equal(saved.gap,'CLINICAL_STREAM_BYTE_BOUND');assert.deepEqual(saved.staged,[]);assert(f.calls.some(c=>c.text==='COMMIT'));
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
