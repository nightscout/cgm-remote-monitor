'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
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
    async function boot (change) {
      await lab.provisionPreview(); await lab.openSink();
      const worker = await lab.workerConsumers(lab.configureConsumers(change));
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
    it('refuses a missing or foreign static slice before sink effects and accepts the exact default receiver identity', async function () {
      await lab.openSink();
      // Direct synthetic protocol probes are distinct from the actual durable
      // producer assertions below. No producer or clinical cycle runs here.
      const request = { tenant: lab.A, id: randomUUID(), attempt: 1,
        notification: { title: 'synthetic static ownership probe', originGeneration: '1' }, receipts: [] };
      const missing = { ...request }, wrongCount = { ...request, slice: { count: 2, ordinal: 0 } },
        wrongOrdinal = { ...request, slice: { count: 1, ordinal: 1 } };
      for (const [body, code] of [[missing, 'REALTIME_ALARM_SLICE_REFUSED'], [wrongCount, 'REALTIME_WRONG_OWNER'], [wrongOrdinal, 'REALTIME_WRONG_OWNER']]) {
        await assert.rejects(lab.deliverToSink(body), /SOCKET_IPC_UNAVAILABLE/);
        assert.equal(lab.observations.at(-1).phase, 'sink-refused');
        assert.equal(lab.observations.at(-1).code, code, 'M5_CONSUMER_STATIC_RECEIVER_REFUSAL');
        assert.equal(lab.sinkEffects.length, 0, 'M5_CONSUMER_STATIC_REFUSED_BEFORE_EFFECT');
      }
      assert.deepEqual(await lab.requests(lab.A), []);
      assert.deepEqual(await lab.requests(lab.B), []);
      assert.deepEqual(await lab.deliverToSink({ ...request, slice: { count: 1, ordinal: 0 } }),
        { accepted: true, receipt: null, clearedRequestIds: [] });
      assert.deepEqual(lab.sinkEffects, [{ id: request.id, tenant: request.tenant, notification: request.notification }]);
      assert.deepEqual(await lab.requests(lab.A), [], 'the protocol probe does not claim a durable enqueue');
    });
    it('commits immutable tenant intent before actual adapter handoff and admits same-output once plus a repeat on the heartbeat clock', async function () {
      // Tenant heartbeat (single-site setting, seconds) shortened so the repeat arrives in the test.
      const epoch=await reading(50); await reading(111,lab.B); await lab.setSettings({ enable: ['bgnow', 'delta', 'direction', 'simplealarms'], heartbeat: 3 }); const worker=await boot();
      const first=lab.sinkEffects.filter(row=>row.tenant===lab.A); lab.traceConsumer('first-output-before-verdict',{effects:first,requests:await lab.requests(),state:await lab.producerState(),health:await worker.call('health')}); assert.equal(first.length,1,'M5_CONSUMER_COMMIT_BEFORE_SINK');
      const capture=lab.observations.find(row=>row.phase==='sink-before-accept' && row.id===first[0].id);
      assert.deepEqual(capture.slice,{count:1,ordinal:0},'M5_CONSUMER_ACTUAL_STATIC_ROUTE');
      assert.equal(capture.ownRow.request_id,first[0].id); assert.equal(capture.ownRow.state,'attempting','M5_CONSUMER_COMMIT_BEFORE_SINK');
      const before=await lab.requests(); lab.traceConsumer('committed-before-verdict',{rows:before,state:await lab.producerState(),foreign:await lab.requests(lab.B)}); assert.equal(before[0].state,'accepted'); assert.ok(Number(before[0].created_at)>=epoch);
      const producerBefore = await lab.producerState();
      await worker.call('wake'); await worker.call('flush'); assert.equal(lab.sinkEffects.length,1,'M5_CONSUMER_SAME_OUTPUT_ONCE');
      const producerAfter=await lab.producerState(); lab.traceConsumer('unchanged-wake-before-verdict',{before:producerBefore,after:producerAfter});
      assert.equal(producerAfter[0].revision,producerBefore[0].revision,'M5_CONSUMER_JSONB_UNCHANGED_NO_REVISION');
      await worker.call('tick'); await worker.call('flush'); assert.equal(lab.sinkEffects.length,1,'M5_CONSUMER_IDENTICAL_CYCLE_NO_REPEAT before the heartbeat');
      await lab.wait(async () => lab.sinkEffects.length >= 2); // the coordinator's own repeat-clock wake, no trigger
      assert.equal(lab.sinkEffects.length,2);
      assert.notEqual(lab.sinkEffects[0].id,lab.sinkEffects[1].id,'M5_CONSUMER_NEW_RT_CYCLE repeat on the heartbeat clock');
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
      const exited=new Promise(resolve=>first.child.once('exit',(code,signal)=>resolve({code,signal}))); lab.killConsumer(first);
      const death={...await exited,pid:first.child.pid}; assert.equal(death.signal,'SIGKILL'); lab.sinkMode='accept'; await waitDue(original.request_id);
      const next=await lab.workerConsumers(lab.configureConsumers()); assert.equal(next.startup.ready,true); await next.call('flush');
      const after=(await lab.requests()).find(row=>row.request_id===original.request_id);
      lab.traceConsumer('uncertain-restart-before-verdict',{original,after,death,all:await lab.requests(),state:await lab.producerState()});
      assert.equal(after.state,'accepted','M5_CONSUMER_PROCESS_DEATH_SAME_UUID'); assert.ok(after.attempt>=2,'M5_CONSUMER_PROCESS_DEATH_SAME_UUID'); assert.deepEqual(after.payload,original.payload);
      assert.equal(lab.sinkEffects.filter(row=>row.id===original.request_id).length,2);
      lab.traceConsumer('uncertain-process-restart',{original,after,death,all:await lab.requests()}); await lab.stopConsumer(next);
    });
    it('clears a committed authorized ACK despite failed clinical acquisition and keeps the other tenant independent', async function () {
      await reading(50); await reading(50,lab.B); const first=await boot();
      let worker=first; const completed=await lab.previewCompleted(lab.A);
      await reading(50,lab.A,4);
      // Source COMMIT does not imply recoverable CDC acceptance. The prior
      // accepted model remains valid until this oversized cohort is received.
      await lab.wait(async()=>{
        const input=(await lab.checkpoint(lab.consumerName,lab.A)).projection?.[0];
        const observed=(await lab.admin.query('SELECT work_observed FROM "'+lab.replayNamespace+'".tenant_consumer_checkpoint WHERE tenant_id=$1 AND consumer=$2',[lab.A,lab.consumerName+'-completed'])).rows[0];
        return input?.gap==='rows'&&input.ready===false&&String(observed?.work_observed?.[5])===String(input.floor);
      });
      await worker.call('acquire',lab.A); await worker.call('flush',lab.A);
      assert.equal(await worker.call('last',lab.A),null,'M5_CONSUMER_REFUSED_WINDOW_NO_SERVABLE_MODEL');
      assert.deepEqual(await lab.previewCompleted(lab.A),completed,'M5_CONSUMER_REFUSAL_RETAINS_DURABLE_CLINICAL_RESULT');
      await lab.stopConsumer(worker);
      await lab.setSettings({ enable: ['bgnow', 'delta', 'direction', 'simplealarms'], units: 'mmol' }, lab.A);
      const changed = lab.configureConsumers();
      worker = await lab.workerConsumers(changed); assert.equal(worker.startup.ready,true);
      await worker.call('flush',lab.A); await worker.call('flush',lab.B);
      assert.equal(await worker.call('last',lab.A),null,'M5_CONSUMER_COLD_NO_CLINICAL_RESULT');
      const before=lab.sinkEffects.length; await lab.ack(lab.A,2,60000); const suppression=await lab.suppressions();
      const at=await lab.epoch(); assert.ok(suppression.every(row=>Number(row.acked_at)<=at && Number(row.expires_at)>at));
      await worker.call('retry',lab.A); const after=lab.sinkEffects.slice(before);
      lab.traceConsumer('control-clear-before-verdict',{suppression,after,state:await lab.producerState(),clinical:await worker.call('last',lab.A)});
      assert.equal(after.length,1,'M5_CONSUMER_CONTROL_CLEAR_FAILED_CLINICAL'); assert.equal(after[0].notification.clear,true,'M5_CONSUMER_CONTROL_CLEAR_FAILED_CLINICAL');
      assert.equal(after[0].notification.message,"default - Urgent was ack'd");
      const priorInput=await lab.checkpoint(lab.consumerName,lab.B);
      const changedAt=await lab.epoch(); await lab.persistDomains({entries:[{_id:'synthetic-b-changed',type:'sgv',sgv:48,date:changedAt-500,
        dateString:new Date(changedAt-500).toISOString(),direction:'Flat'}]}, lab.B);
      // A storage COMMIT and recoverable CDC acceptance are separate boundaries.
      // Wait for B's native input floor and its matching pending obligation.
      // The public history clock is independent of clinical native coverage.
      await lab.wait(async()=>{
        const row=(await lab.admin.query('SELECT work_observed FROM "'+lab.replayNamespace+'".tenant_consumer_checkpoint WHERE tenant_id=$1 AND consumer=$2',[lab.B,lab.consumerName+'-completed'])).rows[0];
        const input=await lab.checkpoint(lab.consumerName,lab.B);
        return BigInt(input.checkpoint)>BigInt(priorInput.checkpoint)&&String(row?.work_observed?.[5])===String(input.checkpoint);
      });
      await worker.call('acquire',lab.B); await worker.call('flush',lab.B); assert.ok(lab.sinkEffects.at(-1).tenant===lab.B,'B keeps delivering on its own new data');
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
