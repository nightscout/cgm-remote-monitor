'use strict';
// covers: tests/tenant-notifications.integration.test.js
// Actual registered test body with an explicit bounded ACL protocol; NOT native PG evidence.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),Module=require('node:module');
describe('actual notification native unsafe-test restoration protocol',function(){
  it('restores the exact narrow column authority after table-level UPDATE ablation before its recovery assertion',async function(){
    const file=path.join(__dirname,'tenant-notifications.integration.test.js'),actual=Module.createRequire(file),tests=[];
    const columns=['state','next_at','attempt','attempt_token','attempt_until','accepted_at','receipt','cleared_at'];
    const initial=new Set(columns);let grants=new Set(initial),unsafe=false,callbacks=0;
    const calls=[];
    const lab={name:'synthetic_outbox',role:'synthetic_worker',A:'11111111-1111-4111-8111-111111111111',cycle(){},trace(){},async rows(){return [];},
      admin:{async query(sql){calls.push(sql);
        if(sql.includes('GRANT UPDATE ON'))unsafe=true;
        else if(sql.includes('REVOKE UPDATE ON')){unsafe=false;grants.clear();} // PostgreSQL table revoke also removes column grants.
        else if(sql.includes('GRANT UPDATE('))for(const col of sql.match(/UPDATE\(([^)]+)\)/)[1].split(','))grants.add(col.trim());
        else if(sql.startsWith('GRANT ')||sql.includes('DISABLE ROW LEVEL'))unsafe=true;
        else if(sql.startsWith('REVOKE ')||sql.includes('ENABLE ROW LEVEL'))unsafe=false;
      }},component({adapter}){return {async run(){if(unsafe||columns.some(c=>!grants.has(c)))throw new Error('NOTIFICATION_SCHEMA_UNSAFE');callbacks++;adapter.send({},()=>{});}};}};
    const m={exports:{}};
    const requireFixture=id=>id==='./fixtures/tenant-notifications-native'?()=>lab:id==='./support/opt-in'?{optInSuite:()=> (title,body)=>body.call({timeout(){}})}:actual(id);
    const compiled=vm.compileFunction(fs.readFileSync(file,'utf8'),['require','module','exports','__dirname','process','before','beforeEach','after','it'],{filename:file});
    compiled(requireFixture,m,m.exports,__dirname,{env:{NS_TENANT_NOTIFICATIONS_TEST:'1',NS_TEST_POSTGRES_ADMIN_URI:'postgres://synthetic:synthetic@127.0.0.1:15432/acl_protocol_test'}},
      ()=>{},()=>{},()=>{},(title,body)=>tests.push({title,body}));
    const selected=tests.find(row=>row.title.startsWith('refuses unsafe RLS schema'));
    await selected.body();assert.equal(callbacks,1,'NOTIFICATION_NATIVE_NARROW_GRANTS_RESTORED');
    assert.deepEqual([...grants].sort(),[...initial].sort());assert.ok(calls.some(sql=>sql.includes('REVOKE UPDATE ON')));
  });
});
