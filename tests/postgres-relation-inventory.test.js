'use strict';
// Retired pulse tables are unknown relations; only source-owned selected profiles
// can admit infrastructure beside the tenant catalogue.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {createRequire}=require('node:module');
const file=require.resolve('../lib/storage/postgres-relation-inventory');
const actual=require(file).assertRelationInventory;
const fail=(code,detail)=>Object.assign(new Error(code),{code,detail});
function fixture(extra=false){return {query:async()=>({rows:['schema_migrations','tenant_write_clock',...(extra?['retired_pulse']:[])].map(name=>({name,kind:'r',partition:false,inherited:false}))})};}
const options={namespace:'synthetic_clock',tables:['tenant_write_clock'],fail};
describe('strict source-owned relation inventory after pulse retirement',function(){
 it('admits the tenant clock catalogue and refuses every unselected sibling',async()=>{
  await actual(fixture(),options);
  await assert.rejects(actual(fixture(true),options),{code:'UNADMITTED',detail:'retired_pulse'});
 });
 async function criterion(check){
  await assert.rejects(check(fixture(true),{...options,infrastructure:{namespace:options.namespace,table:'retired_pulse',contract:'retired'}}),{code:'INVALID',detail:'infrastructure'});
 }
 it('rejects former arbitrary infrastructure declarations; removing its authority fence is red and restored passes',async()=>{
  const source=fs.readFileSync(file,'utf8'),needle="  if (infrastructure !== null && infrastructure !== undefined && !globalProfile) throw fail('INVALID', 'infrastructure');";
  assert.equal(source.split(needle).length,2);
  const module={exports:{}};
  vm.runInThisContext('(function(require,module,exports){'+source.replace(needle,'')+'\n})',{filename:file})(createRequire(file),module,module.exports);
  await assert.rejects(criterion(module.exports.assertRelationInventory),{code:'ERR_ASSERTION'});
  await criterion(actual);
 });
});
