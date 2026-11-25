'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const scope=require('../lib/storage/tenant-scope');
function load(relative,connect,mutate=s=>s){const file=path.resolve(__dirname,'../lib',relative),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));const original=m.require.bind(m);m.require=name=>name==='../storage/postgres-connection'?connect:original(name);m._compile(mutate(fs.readFileSync(file,'utf8')),file);return m.exports;}
describe('API authority adapters borrow their role-owned connection',function(){
 let prior;beforeEach(()=>{prior=scope.getTenancyMode();scope.setTenancyMode('multi');});afterEach(()=>scope.setTenancyMode(prior));
 for(const [relative,namespaces,n] of [['secrets/legacy-postgres.js',{namespace:'legacy',localVerification:true},3],['tenant-authorization/access-postgres.js',{namespace:'access',authorityNamespace:'authorization'},8]]){
  async function criterion(mutate){let opens=0,ends=0,unsafe=false;const connection={withTenant:(tenant,fn)=>scope.withTenant(tenant,fn),async query(){return{rows:Array.from({length:n},()=>({secured:!unsafe,owns:false,reads:true,writes:false}))};},async end(){ends++;}};
   const constructor=load(relative,async()=>{opens++;return connection;},mutate);
   const service=await constructor({...namespaces,connection});await service.close();await service.close();assert.equal(opens,0,'NO_DUPLICATE_AUTHORITY_POOL');assert.equal(ends,0,'BORROWER_DOES_NOT_CLOSE_API_POOL');
   unsafe=true;await assert.rejects(constructor({...namespaces,connection}));assert.equal(ends,0,'FAILED_BORROWER_DOES_NOT_CLOSE_API_POOL');
  }
  it(relative+' screens and closes only its own resources',()=>criterion());
  it(relative+' red/restored: removing connection borrowing creates a duplicate pool',async()=>{
   await assert.rejects(criterion(source=>{const needle='suppliedConnection || await connect(';assert(source.includes(needle));return source.replace(needle,'await connect(');}),assert.AssertionError);
   await criterion();
  });
 }
});
