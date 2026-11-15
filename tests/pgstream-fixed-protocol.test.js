'use strict';
const {it}=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const fs=require('node:fs'),vm=require('node:vm'),{createRequire}=require('node:module');
const protocol=require('../lib/pool-membership/fixed-protocol');
// Native catalogue projection 2026-11-15, point93e898: these are the measured
// exact function bytes/fields, not a PostgreSQL execution in this unit fixture.
const SHA='a2c811800bb849dc9cad2c06b1d71798c6e2045aa94d01759a798542fede9953';
const rows=()=>['pool_membership','pool_desired'].map(table_name=>({table_name,enabled:'A',type:31,arguments:0,unconditional:true,source:protocol.BODY,definer:false,config:['search_path=pg_catalog'],language:'plpgsql',function_name:'pool_mutation_lock_required',function_arguments:0,trigger_result:true}));
it('matches the native-measured delimiter interior including both outer newlines without normalizing source',async()=>{
 assert.equal(Buffer.byteLength(protocol.BODY),1086);assert.equal(createHash('sha256').update(protocol.BODY).digest('hex'),SHA);assert(protocol.BODY.startsWith('\n')&&protocol.BODY.endsWith('\n'));
 await protocol.assertInstalled(async()=>({rows:rows()}),'synthetic_membership');
 await assert.rejects(protocol.assertInstalled(async()=>({rows:rows().map(row=>({...row,source:row.source.trim()}))}),'synthetic_membership'),/UNQUALIFIED/);
});
it('keeps all mutation trigger semantic/identity checks when exact body extraction is repaired',async()=>{
 for(const patch of [{enabled:'O'},{type:19},{arguments:1},{unconditional:false},{definer:true},{config:['search_path=public']},{language:'sql'},{function_name:'other'},{function_arguments:1},{trigger_result:false}])await assert.rejects(protocol.assertInstalled(async()=>({rows:rows().map(row=>({...row,...patch}))}),'synthetic_membership'),/UNQUALIFIED/);
});
it('control: the measured old extraction refuses the actual-shaped catalogue; exact restored matcher passes',async()=>{
 const file=require.resolve('../lib/pool-membership/fixed-protocol'),source=fs.readFileSync(file,'utf8'),needle='const BODY=statement.slice(start+tag.length,end);';assert.equal(source.split(needle).length,2);
 const old={exports:{}};vm.runInThisContext('(function(require,module,exports){'+source.replace(needle,()=>"const BODY=statement.split('$pool_mutation$\\n')[1].split('\\n$pool_mutation$')[0];")+'\n})',{filename:file})(createRequire(file),old,old.exports);
 await assert.rejects(old.exports.assertInstalled(async()=>({rows:rows()}),'synthetic_membership'),/POOL_MUTATION_PROTOCOL_UNQUALIFIED/);
 assert.equal(Buffer.byteLength(old.exports.BODY),1084);await protocol.assertInstalled(async()=>({rows:rows()}),'synthetic_membership');
});
