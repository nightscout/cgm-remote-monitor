'use strict';

const assert = require('node:assert/strict');
const scope = require('../lib/storage/tenant-scope');
const {optInSuite} = require('./support/opt-in');
const createLab = require('./fixtures/evaluator-consumers-native');

optInSuite(process.env.NS_EVALUATOR_CONSUMERS_TEST === '1' && !!process.env.NS_TEST_POSTGRES_ADMIN_URI,
  'NS_EVALUATOR_CONSUMERS_TEST=1 with disposable NS_TEST_POSTGRES_ADMIN_URI')(
  'selected evaluator durable realtime consumer actual PostgreSQL and controlled UDS sink', function () {
    this.timeout(60000);
    const lab = createLab();
    before(() => lab.open()); beforeEach(() => lab.reset()); after(() => lab.close());
    async function reading (value, tenant = lab.A, count = 1) {
      const at = await lab.epoch();
      await lab.persistDomains({entries:Array.from({length:count}, (_,i)=>({_id:'synthetic-'+i,type:'sgv',sgv:value,
        date:at-1000-i,dateString:new Date(at-1000-i).toISOString(),direction:'Flat'}))}, tenant);
      return at;
    }
    async function boot () {
      await lab.provisionPreview(); await lab.openSink();
      const worker = await lab.workerConsumers(lab.configureConsumers());
      assert.equal(worker.startup.ready,true, 'M5_CONSUMER_ROLE_BOOT'); assert.equal(worker.startup.servers,0);
      await worker.call('flush',lab.A); await worker.call('flush',lab.B); return worker;
    }
    async function waitDue (id) {
      const deadline=Date.now()+5000;
      while (Date.now()<deadline) {
        const row=(await lab.requests()).find(row=>row.request_id===id);
        if (row && Number(row.next_at)<=await lab.epoch()) return row;
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      throw new Error('Consumer due-state watchdog');
    }
    it('commits immutable tenant intent before actual adapter handoff and admits same-output once plus a new realtime cycle', async function () {
      const epoch=await reading(50); await reading(111,lab.B); const worker=await boot();
      const first=lab.sinkEffects.filter(row=>row.tenant===lab.A); assert.equal(first.length,1);
      const capture=lab.observations.find(row=>row.phase==='sink-before-accept' && row.id===first[0].id);
      assert.equal(capture.ownRow.request_id,first[0].id); assert.equal(capture.ownRow.state,'attempting','M5_CONSUMER_COMMIT_BEFORE_SINK');
      const before=await lab.requests(); lab.traceConsumer('committed-before-verdict',{rows:before,state:await lab.producerState(),foreign:await lab.requests(lab.B)}); assert.equal(before[0].state,'accepted'); assert.ok(Number(before[0].created_at)>=epoch);
      const producerBefore = await lab.producerState();
      await worker.call('wake'); await worker.call('flush'); assert.equal(lab.sinkEffects.length,1,'M5_CONSUMER_SAME_OUTPUT_ONCE');
      const producerAfter=await lab.producerState(); lab.traceConsumer('unchanged-wake-before-verdict',{before:producerBefore,after:producerAfter});
      assert.equal(producerAfter[0].revision,producerBefore[0].revision,'M5_CONSUMER_JSONB_UNCHANGED_NO_REVISION');
      await worker.call('tick'); await worker.call('flush'); assert.equal(lab.sinkEffects.length,2);
      assert.notEqual(lab.sinkEffects[0].id,lab.sinkEffects[1].id,'M5_CONSUMER_NEW_RT_CYCLE');
      assert.deepEqual(await lab.requests(lab.B),[]); lab.traceConsumer('committed-per-cycle',{rows:await lab.requests(),state:await lab.producerState(),foreign:await lab.requests(lab.B)});
      await lab.stopConsumer(worker);
    });
    it('recovers retained producer normal-state clear after actual evaluator process restart without repeated clear UUIDs', async function () {
      await reading(50); const first=await boot(); const alarm=(await lab.requests())[0]; await lab.stopConsumer(first);
      await lab.writeCanonical({planned:{op:'update',form:'merge',target:{_id:'synthetic-0'},fields:{sgv:111}}});
      const next=await lab.workerConsumers(lab.configureConsumers()); assert.equal(next.startup.ready,true); await next.call('flush');
      const clears=(await lab.requests()).filter(row=>row.payload.clear); lab.traceConsumer('restart-clear-before-verdict',{alarm,clears,state:await lab.producerState()}); assert.equal(clears.length,1,'M5_CONSUMER_RESTART_CLEAR');
      assert.equal(clears[0].payload.message,"Auto ack'd alarm(s)"); assert.equal(clears[0].state,'accepted');
      await next.call('tick'); await next.call('flush'); assert.equal((await lab.requests()).filter(row=>row.payload.clear).length,1,'M5_CONSUMER_CLEAR_ORIGIN_ONCE');
      lab.traceConsumer('restart-normal-clear',{alarm,clears:await lab.requests(),state:await lab.producerState()}); await lab.stopConsumer(next);
    });
    it('retries a still-current uncertain request with the same UUID after actual process death while permitting one fresh cycle event', async function () {
      await reading(50); lab.sinkMode='lost-response'; const first=await boot();
      const original=(await lab.requests())[0]; lab.traceConsumer('uncertain-before-death',{original,state:await lab.producerState()}); assert.equal(original.state,'uncertain');
      const exited=new Promise(resolve=>first.child.once('exit',(code,signal)=>resolve({code,signal}))); first.child.kill('SIGKILL');
      const death=await exited; assert.equal(death.signal,'SIGKILL'); lab.sinkMode='accept'; await waitDue(original.request_id);
      const next=await lab.workerConsumers(lab.configureConsumers()); assert.equal(next.startup.ready,true); await next.call('flush');
      const after=(await lab.requests()).find(row=>row.request_id===original.request_id);
      lab.traceConsumer('uncertain-restart-before-verdict',{original,after,death,all:await lab.requests(),state:await lab.producerState()});
      assert.equal(after.state,'accepted'); assert.ok(after.attempt>=2,'M5_CONSUMER_PROCESS_DEATH_SAME_UUID'); assert.deepEqual(after.payload,original.payload);
      assert.equal(lab.sinkEffects.filter(row=>row.id===original.request_id).length,2);
      lab.traceConsumer('uncertain-process-restart',{original,after,death,all:await lab.requests()}); await lab.stopConsumer(next);
    });
    it('clears a committed authorized ACK despite failed clinical acquisition and keeps the other tenant independent', async function () {
      await reading(50); await reading(50,lab.B); const first=await boot();
      let worker=first;
      await reading(50,lab.A,4); await worker.call('acquire',lab.A); await worker.call('flush',lab.A);
      assert.equal((await worker.call('last',lab.A)).eligible,false);
      await lab.stopConsumer(worker);
      const changed = lab.configureConsumers(document => {document.tenants.find(row=>row.id===lab.A).revision='control-config-after-restart';});
      worker = await lab.workerConsumers(changed); assert.equal(worker.startup.ready,true);
      await worker.call('flush',lab.A); await worker.call('flush',lab.B);
      assert.equal(await worker.call('last',lab.A),null,'M5_CONSUMER_COLD_NO_CLINICAL_RESULT');
      const before=lab.sinkEffects.length; await lab.ack(lab.A,2,60000); const suppression=await lab.suppressions();
      const at=await lab.epoch(); assert.ok(suppression.every(row=>Number(row.acked_at)<=at && Number(row.expires_at)>at));
      await worker.call('retry',lab.A); const after=lab.sinkEffects.slice(before);
      lab.traceConsumer('control-clear-before-verdict',{suppression,after,state:await lab.producerState(),clinical:await worker.call('last',lab.A)});
      assert.equal(after.length,1); assert.equal(after[0].notification.clear,true,'M5_CONSUMER_CONTROL_CLEAR_FAILED_CLINICAL');
      assert.equal(after[0].notification.message,"default - Urgent was ack'd");
      await worker.call('tick',lab.B); await worker.call('flush',lab.B); assert.ok(lab.sinkEffects.at(-1).tenant===lab.B);
      lab.traceConsumer('control-ack-with-failed-clinical',{suppression,after,health:await worker.call('health'),state:await lab.producerState()}); await lab.stopConsumer(worker);
    });
    it('keeps ACK producer state SELECT-only and refuses unsafe forced-RLS state before any sink effect', async function () {
      await reading(50); const worker=await boot(); const writer=lab.writerConnection(), table='"'+lab.consumerNamespaces.outbox+'".tenant_notification_state';
      for (const sql of ['UPDATE '+table+' SET revision=revision+1','SELECT * FROM '+table+' FOR UPDATE',
        'INSERT INTO '+table+' SELECT * FROM '+table]) {
        let refusal;
        try {await scope.withTenant(lab.A,()=>writer.transaction(()=>writer.query(sql)));} catch (error) {refusal=error.code || error.name;}
        lab.traceConsumer('ack-privilege-before-verdict',{operation:sql.split(' ')[0],refusal,state:await lab.producerState()});
        assert.equal(refusal,'42501','M5_CONSUMER_ACK_STATE_READ_ONLY');
      }
      await lab.ack(lab.A,2,60000); const before=lab.sinkEffects.length;
      await lab.admin.query('ALTER TABLE '+table+' NO FORCE ROW LEVEL SECURITY');
      try {await worker.call('retry'); const health=await worker.call('health');
        lab.traceConsumer('unsafe-state-before-verdict',{state:await lab.producerState(),effectsBefore:before,effectsAfter:lab.sinkEffects.length,health});
        assert.equal(lab.sinkEffects.length,before); assert.equal(health.consumers.tenants.find(row=>row.tenant===lab.A).state,'refused','M5_CONSUMER_UNSAFE_STATE_REFUSED');}
      finally {await lab.admin.query('ALTER TABLE '+table+' FORCE ROW LEVEL SECURITY');}
      lab.traceConsumer('ack-state-readonly-and-rls-refusal',{state:await lab.producerState(),effectsBefore:before,effectsAfter:lab.sinkEffects.length}); await lab.stopConsumer(worker);
    });
  });
