'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{createRequire}=require('node:module');
const assignment=require('../lib/pgstream/pool-assignment'),{RULE,MAX_MEMBERS,bucket}=require('../lib/pool-membership/slice');
const tenants=Array.from({length:128},(_,i)=>'00000000-0000-4000-8000-'+(i+1).toString(16).padStart(12,'0'));
const roster=n=>Array.from({length:n},(_,ordinal)=>({ordinal,memberId:'10000000-0000-4000-8000-'+(ordinal+1).toString(16).padStart(12,'0'),rule:RULE,live:true,appliedMembers:n}));
describe('shared pool assignment snapshots (selection, never effect authority)',()=>{
 it('covers singleton and non-power-of-two N exactly once with the shared unsigned-prefix rule',()=>{
  for(const members of [1,2,3,5,257,MAX_MEMBERS]){const a=assignment.create({tenants,members,revision:'9007199254740993'}),rows=roster(members),desired={members,revision:a.revision,rule:RULE},slices=rows.map(self=>a.select({self,rows,desired}));assert(slices.every(s=>s.eligible));assert.deepEqual(slices.flatMap(s=>s.tenants).sort(),tenants);for(const tenant of tenants)assert.equal(a.owner(tenant),bucket(tenant,members));}
 });
 it('does not accept stale revisions, missing/duplicate/incarnation-expired workers or partial new-epoch application',()=>{
  const a=assignment.create({tenants,members:3,revision:'9'}),rows=roster(3),base={self:rows[0],rows,desired:{members:3,revision:'9',rule:RULE}};
  for(const patch of [{rows:rows.slice(0,2)},{rows:[...rows,{...rows[2],memberId:tenants[0]}]},{self:{...rows[0],memberId:tenants[3]}},{rows:rows.map((r,i)=>i===1?{...r,live:false}:r)},{rows:rows.map((r,i)=>i===2?{...r,appliedMembers:2}:r)},{desired:{...base.desired,revision:'10'}}])assert.equal(a.select({...base,...patch}).eligible,false);
 });
 it('owns its active population without caller iteration and permits empty active population independently of worker count',()=>{
  const owned=[...tenants];owned[Symbol.iterator]=()=>assert.fail('caller iterator');const a=assignment.create({tenants:owned,members:3,revision:'1'});owned.pop();assert.equal(a.tenants.length,128);assert.equal(assignment.create({tenants:[],members:3,revision:'1'}).tenants.length,0);assert.equal(assignment.validate(a),a);assert.throws(()=>assignment.validate({...a}),/SOURCE_REQUIRED/);for(const members of [0,1025,1.5])assert.throws(()=>assignment.create({tenants,members,revision:'1'}));
 });
 it('control: dropping complete coverage admits missing owners, then restoration refuses',()=>{
  const file=require.resolve('../lib/pgstream/pool-assignment'),source=fs.readFileSync(file,'utf8'),needle='verdict.missingOrdinals.length||';assert.equal(source.split(needle).length,2);const broken={exports:{}};vm.runInThisContext('(function(require,module,exports){'+source.replace(needle,'')+'\n})',{filename:file})(createRequire(file),broken,broken.exports);
  const rows=roster(3).slice(0,2),qualify=api=>assert.equal(api.create({tenants,members:3,revision:'1'}).select({self:rows[0],rows,desired:{members:3,revision:'1',rule:RULE}}).eligible,false);assert.throws(()=>qualify(broken.exports),{code:'ERR_ASSERTION'});qualify(assignment);
 });
});
