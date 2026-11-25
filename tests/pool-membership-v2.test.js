'use strict';
// Recording source SQL and real module constructors, not native PostgreSQL.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{createRequire}=require('node:module');
const mode=require('../lib/pool-membership/pool-candidate'),{RULE}=require('../lib/pool-membership/slice');
const desired=(partitioned=true,members=3,revision='9',previousMembers=null,previousPartitioned=null)=>({partitioned,members,revision,rule:RULE,previousMembers,previousPartitioned});
function load(file,overrides={},mutate=s=>s){const original=createRequire(file),m={exports:{}};vm.runInThisContext('(function(require,module,exports){'+mutate(fs.readFileSync(file,'utf8'))+'\n})',{filename:file})(name=>Object.hasOwn(overrides,name)?overrides[name]:original(name),m,m.exports);return m.exports;}
describe('retained placement catalogue admission (source protocols)',()=>{
 it('appends a default-compatible migration with locked historical mode backfill',()=>{const prior=require('../migrations/candidates/postgres-pool-mutation-v1.json'),catalogue=mode.build();assert.deepEqual(catalogue.migrations.slice(0,prior.migrations.length),prior.migrations);assert.equal(catalogue.migrations.at(-1).name,'0005_pool_placement');assert(catalogue.migrations.at(-1).up.some(sql=>sql.includes('pg_advisory_xact_lock')));assert(catalogue.migrations.at(-1).up.some(sql=>sql.startsWith('UPDATE')&&sql.includes('previous_members IS NOT NULL')));});
 it('refuses unknown/ambiguous applied modes and enforces singleton count and previous-mode provenance',()=>{assert.equal(mode.placement(desired(false,1)).members,1);for(const value of [{...desired(),partitioned:null},desired(false,3),desired(true,3,'9',2,null),desired(true,3,'9',null,true),desired(true,3,'9',2,false)])assert.throws(()=>mode.placement(value),/SHAPE/);});

 function catalogueRead({badColumns=false,badConstraint=false}={}) {
  return async sql=>{
   if(sql.startsWith('SELECT to_regclass'))return {rows:[{present:true}]};
   if(sql.startsWith('SELECT name, checksum'))return {rows:mode.build().migrations.map(({name,checksum})=>({name,checksum}))};
   if(sql.includes('pool-placement-columns'))return {rows:[{name:'partitioned',type:'boolean',required:!badColumns,default_value:'true'},{name:'previous_partitioned',type:'boolean',required:false,default_value:null}]};
   if(sql.includes('pool-placement-constraint'))return {rows:[{expression:badConstraint?'true':mode.EXPRESSION,valid:true,deferrable:false}]};
   assert.fail('Unexpected placement catalogue query');
  };
 }
 it('refuses drift in the retained placement columns and constraint',async()=>{
  await mode.assertInstalled(catalogueRead(),'member_pool');
  await assert.rejects(mode.assertInstalled(catalogueRead({badColumns:true}),'member_pool'),/COLUMNS_UNQUALIFIED/);
  const qualify=api=>assert.rejects(api.assertInstalled(catalogueRead({badConstraint:true}),'member_pool'),/CONSTRAINT_UNQUALIFIED/);
  const file=require.resolve('../lib/pool-membership/pool-candidate');
  const needle="if (!matches || constraints[0].valid !== true || constraints[0].deferrable !== false) throw new Error('POOL_PLACEMENT_CONSTRAINT_UNQUALIFIED');";
  await qualify(mode);
  await assert.rejects(qualify(load(file,{},source=>replaceGuard(source,needle))),{code:'ERR_ASSERTION'});
  await qualify(mode);
 });
});
function replaceGuard(source,needle){
 assert.equal(source.split(needle).length,2);
 return source.replace(needle,'');
}
