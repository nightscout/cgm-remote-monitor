'use strict';
const assert=require('node:assert/strict');
const fixed=require('../lib/pgstream/fixed-assignment'),hints=require('../lib/pgstream/input-hints');
const ids=Array.from({length:16},(_,i)=>'00000000-0000-4000-8000-'+(i+1).toString(16).padStart(12,'0'));
const assignment=fixed.create({tenants:ids,members:2,revision:'9007199254740993'});
it('routes bounded input hints only to the fixed owner; callback is wake-only',async()=>{
 const seen=[[],[]],peers=[0,1].map(ordinal=>({hintEvaluatorInput:hints.handler({assignment,ordinal,wake:(tenant,kind)=>seen[ordinal].push({tenant,kind})})}));
 const hint=hints.router({assignment,peers});
 for(const tenant of ids)assert.deepEqual(await hint(tenant,'settings'),{accepted:true});
 assert.equal(seen.flat().length,ids.length);assert(seen.every((rows,ordinal)=>rows.length&&rows.every(row=>assignment.owner(row.tenant)===ordinal)));
});
it('refuses wrong revision, ordinal, extra payload, output feedback kinds and malformed peer replies',async()=>{
 let effects=0;const receive=hints.handler({assignment,ordinal:0,wake:()=>effects++}),tenant=ids.find(id=>assignment.owner(id)===0),body={tenant,kind:'clock',assignmentRevision:assignment.revision};
 for(const request of [{...body,assignmentRevision:'7'},{...body,kind:'completed-output'},{...body,rows:[]},{...body,tenant:ids.find(id=>assignment.owner(id)===1)}])await assert.rejects(receive(request));
 assert.equal(effects,0);
 const peers=[0,1].map(()=>({hintEvaluatorInput:async()=>({accepted:true,clinicalResult:[]})}));await assert.rejects(hints.router({assignment,peers})(tenant,'clock'),/SCHEMA_REFUSED/);
});
it('control: routing every hint to ordinal0 fails the two-owner criterion then restores',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),{createRequire}=require('node:module'),file=require.resolve('../lib/pgstream/input-hints'),source=fs.readFileSync(file,'utf8'),needle='selected[assignment.owner(tenant)]';
 assert.equal(source.split(needle).length,2);const broken={exports:{}};
 vm.runInThisContext('(function(require,module,exports){'+source.replace(needle,'selected[0]')+'\n})',{filename:file})(createRequire(file),broken,broken.exports);
 const qualify=async module=>{const counts=[0,0],peers=counts.map((_,ordinal)=>({hintEvaluatorInput:async request=>{assert.equal(assignment.owner(request.tenant),ordinal);counts[ordinal]++;return {accepted:true};}}));for(const tenant of ids)await module.router({assignment,peers})(tenant,'clock');assert(counts.every(Boolean));};
 await assert.rejects(qualify(broken.exports),{code:'ERR_ASSERTION'});await qualify(hints);
});
