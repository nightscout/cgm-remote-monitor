'use strict';
const assert=require('node:assert/strict');
const {randomBytes}=require('node:crypto');
const {Client}=require('pg');
const {optInSuite}=require('./support/opt-in');
const owner=require('../lib/realtime-ownership/owner');
const connect=require('../lib/storage/postgres-connection');
optInSuite(!!process.env.NS_TEST_POSTGRES_ADMIN_URI,'disposable PostgreSQL static owner admission')('actual static realtime worker resources',function(){
  this.timeout(30000);
  it('STATIC_OWNER: duplicate ordinal and mixed K refuse; physical backend loss revokes old owner while healthy ordinal and replacement remain independent',async function(){
    const admin=new Client({connectionString:process.env.NS_TEST_POSTGRES_ADMIN_URI}),tag=randomBytes(8).toString('hex'),role='rt_owner_'+tag,password=randomBytes(24).toString('hex');
    let a,b,held,other,restored,losses=0;
    await admin.connect();
    try{
      await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
      const url=new URL(process.env.NS_TEST_POSTGRES_ADMIN_URI);url.username=role;url.password=password;
      const options={connectionString:url.toString(),max:3,connectionTimeoutMillis:500,query_timeout:500,statement_timeout:500};a=await connect(options);b=await connect(options);
      held=await owner.acquire({connection:a,shape:{count:2,ordinal:0},consumer:'realtime-stable',onLoss:()=>{losses++;}});await held.check();
      async function refused(shape,code,label){let unexpected;try{await assert.rejects(async()=>{unexpected=await owner.acquire({connection:b,shape,consumer:'realtime-stable'});},{code},label);}finally{await unexpected?.close();}}
      await refused({count:2,ordinal:0},'POSTGRES_OPERATIONAL_OWNER_CONFLICT','STATIC_DUPLICATE_ORDINAL_MUST_REFUSE');
      await refused({count:3,ordinal:2},'REALTIME_MIXED_LAYOUT_REFUSED','STATIC_MIXED_K_MUST_REFUSE');
      other=await owner.acquire({connection:b,shape:{count:2,ordinal:1},consumer:'realtime-stable'});await other.check();
      const locks=(await admin.query("SELECT l.pid,l.mode FROM pg_locks l JOIN pg_stat_activity a USING(pid) WHERE a.usename=$1 AND l.locktype='advisory' AND l.granted ORDER BY l.pid",[role])).rows;
      assert.equal(locks.filter(row=>row.mode==='ExclusiveLock').length,2);assert.equal(locks.filter(row=>row.mode==='ShareLock').length,2);
      const heldPid=held.backendPid,healthyPid=other.backendPid;assert.notEqual(heldPid,healthyPid);
      await admin.query('SELECT pg_terminate_backend($1)',[heldPid]);for(let n=0;n<100&&!losses;n++)await new Promise(resolve=>setTimeout(resolve,5));
      assert.ok(losses>0,'STATIC_LOSS_QUIESCES_OLD_OWNER');assert.equal(held.available,false);await assert.rejects(held.check(),{code:'POSTGRES_OPERATIONAL_OWNER_LOST'},'STATIC_OLD_OWNER_MUST_REFUSE');await other.check();assert.equal(other.backendPid,healthyPid);await held.close();
      restored=await owner.acquire({connection:b,shape:{count:2,ordinal:0},consumer:'realtime-stable'});await restored.check();assert.notEqual(restored.backendPid,heldPid);
      await assert.rejects(held.check(),{code:'POSTGRES_OPERATIONAL_OWNER_LOST'});await other.check();
      console.log('STATIC_OWNER_PROOF '+JSON.stringify({exclusiveOwners:2,layoutMarkers:2,oldLost:true,sameOrdinalReplacement:true,healthyUnchanged:true}));
    }finally{for(const resource of [held,other,restored])await resource?.close().catch(()=>{});await Promise.allSettled([a?.end(),b?.end()]);await admin.query(`DROP ROLE IF EXISTS "${role}"`);await admin.end();}
  });
});
