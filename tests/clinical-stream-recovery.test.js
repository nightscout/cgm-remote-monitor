'use strict';
const assert=require('node:assert/strict');
const scope=require('../lib/storage/tenant-scope'),replay=require('../lib/storage/postgres-durable-replay'),stream=require('../lib/storage/clinical-stream-state');
const A='11111111-1111-4111-8111-111111111111',limits={maxRows:10,maxBytes:100000};
const snapshot={checkpoint:10,signature:{stamp:10,deleted:0},rows:[{domain:'entries',document:{_id:'a',sgv:123,date:1},ordinal:1,storageBytes:80}]};
function fixture(factory=replay){
 const queries=[],state=stream.bootstrap(null,snapshot,limits);
 let handle;
 const connection={snapshotTransaction:fn=>fn(),query:async(text)=>{queries.push(text);if(text.includes('FROM "synthetic_work"."tenant_consumer_checkpoint"'))return {rows:[{checkpoint:10,projection:[JSON.parse(JSON.stringify(state))],contract_digest:handle.snapshotDigest}]};throw new Error('WARM_CLINICAL_SOURCE_READ:'+text);}};
 handle=factory({connection,checkpointTable:'synthetic_work.tenant_consumer_checkpoint',clockTable:'synthetic_clock.tenant_write_clock',domains:{entries:'synthetic_entries.entries'},consumer:'evaluator-synthetic',projectionVersion:'clinical-current-rows-v1',pageSize:3,maxRows:10,stream:true});
 return {handle,queries};
}
describe('streamed clinical input recovery through actual replay module',()=>{
 let previous;
 before(()=>{previous=scope.getTenancyMode();scope.setTenancyMode('multi');});
 after(()=>scope.setTenancyMode(previous));
 it('recovers committed working rows/stats after handle loss without clinical source query or routine catalogue lookup',async()=>{
  for(let process=0;process<2;process++){
   const f=fixture();const result=await scope.withTenant(A,()=>f.handle.reconcile({...limits,signature:true}));
   assert.equal(result.checkpoint,10);assert.equal(result.rows[0].document.sgv,123);assert.equal(result.stats.dataSize,80);
   assert.equal(f.queries.length,1);assert(!f.queries[0].includes('information_schema'));assert(!f.queries[0].includes('FOR UPDATE'),'WARM_ACCEPTED_STATE_MUST_NOT_LOCK_RECEIPT');
  }
 });
 it('control: restoring snapshot acquisition on warm events fails with source-read symptom, then restored source passes',async()=>{
  const fs=require('node:fs'),vm=require('node:vm'),{createRequire}=require('node:module'),file=require.resolve('../lib/storage/postgres-durable-replay'),source=fs.readFileSync(file,'utf8');
  const needle='if (stream && streamState?.ready && saved.contract_digest === snapshotDigest)';assert(source.includes(needle));
  const broken={exports:{}};vm.runInThisContext('(function(require,module,exports){'+source.replace(needle,'if (false)')+'\n})',{filename:file})(createRequire(file),broken,broken.exports);
  const f=fixture(broken.exports);await assert.rejects(scope.withTenant(A,()=>f.handle.reconcile({...limits,signature:true})),/WARM_CLINICAL_SOURCE_READ/);
  const restored=fixture();await scope.withTenant(A,()=>restored.handle.reconcile({...limits,signature:true}));
 });
});
