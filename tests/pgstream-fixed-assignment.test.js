'use strict';
const assert=require('node:assert/strict');
const {create}=require('../lib/pgstream/fixed-assignment');
const {RULE}=require('../lib/pool-membership/slice');
const ids=Array.from({length:128},(_,i)=>'00000000-0000-4000-8000-'+(i+1).toString(16).padStart(12,'0'));
const rows=[0,1].map(ordinal=>({ordinal,memberId:ids[ordinal],rule:RULE,live:true,appliedMembers:2}));
const desired={members:2,rule:RULE,revision:'7'};
const assignment=create({tenants:ids,members:2,revision:'7'});
const snapshot=ordinal=>({self:rows[ordinal],rows,desired});
describe('fixed pgstream assignment selection (not an effects fence)',()=>{
 it('covers the synthetic roster exactly once using the existing bucket rule',()=>{
   const selected=rows.map((_,i)=>assignment.select(snapshot(i)));
   assert(selected.every(s=>s.eligible&&s.tenants.length));
   assert.deepEqual(selected.flatMap(s=>s.tenants).sort(),[...ids].sort());
   for(const id of ids){assert.equal(selected.filter(s=>s.includes(id)).length,1);assert(selected[assignment.owner(id)].includes(id));}
   assert.deepEqual(create({tenants:[...ids].reverse(),members:2,revision:'7'}).tenants,assignment.tenants);
 });
 it('refuses missing owners, duplicate ordinals, unregistered incarnations and changed assignment',()=>{
   for(const patch of [{rows:[rows[0]]},{rows:[...rows,{...rows[1],memberId:ids[2]}]},
     {self:{...rows[0],memberId:ids[3]}},{desired:{...desired,revision:'8'}},
     {desired:{...desired,members:1}},{rows:rows.map(r=>({...r,appliedMembers:1}))},{rows:rows.map((r,i)=>i===0?{...r,appliedMembers:null}:r)},{rows:rows.map((r,i)=>i===1?{...r,appliedMembers:null}:r)}]){
     const result=assignment.select({...snapshot(0),...patch});assert.equal(result.eligible,false);assert.deepEqual(result.tenants,[]);
   }
 });
 it('has explicit one-worker selection and rejects invalid or mutable input rosters',()=>{
   const roster=[...ids],one=create({tenants:roster,members:1,revision:'1'});roster.pop();assert.equal(one.tenants.length,ids.length);
   const self={...rows[0],appliedMembers:1};assert.deepEqual(one.select({self,rows:[self],desired:{members:1,rule:RULE,revision:'1'}}).tenants,[...ids].sort());
   for(const tenants of [[ids[0],ids[0]],['INVALID'],[]])assert.throws(()=>create({tenants,members:2,revision:'7'}),/CONFIG/);
   assert.throws(()=>assignment.owner('unknown'),/TENANT/);
 });
 it('control: removing strict coverage admits a missing owner; the refusal criterion goes red then restores',()=>{
   const fs=require('node:fs'),vm=require('node:vm'),{createRequire}=require('node:module');
   const file=require.resolve('../lib/pgstream/fixed-assignment'),source=fs.readFileSync(file,'utf8'),needle='verdict.missingOrdinals.length||';
   assert.equal(source.split(needle).length,2);const broken={exports:{}};
   vm.runInThisContext('(function(require,module,exports){'+source.replace(needle,'')+'\n})',{filename:file})(createRequire(file),broken,broken.exports);
   const qualify=module=>assert.equal(module.create({tenants:ids,members:2,revision:'7'}).select({...snapshot(0),rows:[rows[0]]}).eligible,false,'missing owner must refuse');
   assert.throws(()=>qualify(broken.exports),{code:'ERR_ASSERTION'});qualify({create});
 });
});
