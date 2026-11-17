'use strict';
// Native commit intake replaces mutation clock seals. These controls exercise
// only the API's required history boundary and its deliberate exclusions.
const assert = require('node:assert/strict');
const scope = require('../lib/storage/tenant-scope');
const createV3 = require('../lib/storage/postgres-entries-intent');
const createLegacy = require('../lib/storage/postgres-collection-intent');
const createLab = require('./fixtures/tenant-commit-clock-port');
const { optInSuite } = require('./support/opt-in');
const { EventEmitter } = require('node:events');
const intent = require('../lib/storage/write-intent');
optInSuite(process.env.NS_TENANT_COMMIT_CLOCK_TEST === '1' && !!process.env.NS_TEST_POSTGRES_ADMIN_URI,
  'NS_TENANT_COMMIT_CLOCK_TEST=1 with disposable NS_TEST_POSTGRES_ADMIN_URI')(
  'API history lock scope on actual PostgreSQL', function () {
    this.timeout(30000);
    const lab=createLab(); before(()=>lab.open()); beforeEach(()=>lab.reset()); after(()=>lab.close());
    const entry = id => ({identifier:id,type:'sgv',sgv:123,date:1793923200000,utcOffset:0});
    const write = (port, operation) => scope.withTenant(lab.A,()=>port.write(operation));
    it('activity writes and permanent deletes commit and publish without the held history lock', async function() {
      const events=[], bus=new EventEmitter(); bus.on(intent.INTENT_EVENT,event=>events.push(event));
      const entries=createV3({connection:lab.clocks[1],table:lab.table,bus});
      await write(entries,{op:'create',docs:[entry('removed')]});
      const floor=await lab.floor(lab.A); events.length=0;
      let release,held; const ready=new Promise(r=>held=r),barrier=new Promise(r=>release=r);
      const holding=scope.withTenant(lab.A,()=>lab.clocks[0].transaction(async()=>{held();await barrier;}));
      try {
        await ready;
        const activity=createLegacy({connection:lab.clocks[1],table:lab.namespaces.activity+'.activity',logical:'activity',source:'v1/internal',bus});
        await write(activity,{op:'create',docs:[{_id:'synthetic-activity',created_at:'2026-11-17T00:00:00.000Z',steps:5}]});
        await write(entries,{op:'delete',form:'permanent',target:{identifier:'removed'}});
        assert.equal(await lab.floor(lab.A),floor,'non-history mutations issue no cursor or seal');
        assert.equal((await lab.rows()).length,0);
        assert.equal(events.length,2,'both canonical effects publish after commit');
        assert(events.every(event=>event.stamp===null));
      } finally {release();await holding;}
    });
    it('rolled-back non-history writes publish no events and retain stored rows',async function(){
      const bus=new EventEmitter(),events=[]; bus.on(intent.INTENT_EVENT,event=>events.push(event));
      const base=lab.clocks[0], broken={...base,transaction:async(fn,options)=>{
        const connection=lab.raw[0]; return connection.transaction(async()=>{await fn();throw Error('synthetic rollback');});
      }};
      const port=createLegacy({connection:broken,table:lab.namespaces.activity+'.activity',logical:'activity',source:'v1/internal',bus});
      await assert.rejects(write(port,{op:'create',docs:[{_id:'rolled-back',created_at:'2026-11-17T00:00:00.000Z',steps:7}]}),/synthetic rollback/);
      assert.deepEqual(events,[]); assert.equal((await lab.admin.query('SELECT count(*)::int AS n FROM "'+lab.namespaces.activity+'".activity')).rows[0].n,0);
    });
  });
