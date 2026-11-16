'use strict';
// Actual evaluator role and canonical maintained producer, two synthetic tenants.
// Does not exercise selected partition topology, cold API, or restore acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const { optInSuite } = require('./support/opt-in');
const enabled = process.env.NS_PGSTREAM_RECOVERY_TEST === '1' && !!process.env.NS_TEST_POSTGRES_ADMIN_URI;
optInSuite(enabled, 'NS_PGSTREAM_RECOVERY_TEST=1 and owned disposable PostgreSQL plus canonical pgstream fixture inputs')(
  'actual role maintained-stream recovery fault points', function () {
    this.timeout(60000);
    const lab = require('./fixtures/evaluator-preview-registry-lab')();
    before(() => lab.open());
    beforeEach(() => lab.reset());
    after(() => lab.close());
    function identity(pid) {
      const stat = fs.readFileSync('/proc/'+pid+'/stat', 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/);
      return { pid, parent:Number(fields[1]), group:Number(fields[2]), session:Number(fields[3]), birth:fields[19], executable:fs.readlinkSync('/proc/'+pid+'/exe') };
    }
    async function wait(check, milliseconds, symptom) {
      const end = performance.now()+milliseconds;
      while (performance.now()<end) {
        const result = await check(); if (result) return result;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error(symptom);
    }
    async function write(value, id='synthetic-recovery', age=1000) {
      const at = Date.now();
      return lab.persistDomains({ entries:[{ _id:id, type:'sgv', sgv:value, date:at-age, dateString:new Date(at-age).toISOString(), direction:'Flat' }] });
    }
    async function state() {
      const table='"'+lab.replayNamespace+'".tenant_consumer_checkpoint';
      const rows=(await lab.admin.query('SELECT work_observed,work_completed,work_pending_at,work_due_at::text AS due_at,work_completed_at::text AS completed_at FROM '+table+' WHERE tenant_id=$1 AND consumer=$2',[lab.A,lab.consumerName+'-completed'])).rows;
      assert.equal(rows.length,1,'ONE_DURABLE_WORK_ROW');
      return {...rows[0],observed:require('../lib/pgstream/work-state').map(rows[0].work_observed),completed:require('../lib/pgstream/work-state').map(rows[0].work_completed)};
    }
    async function killWorker(worker) {
      assert.equal(worker.child.exitCode,null);assert.equal(worker.child.signalCode,null);
      const current=identity(worker.child.pid);
      assert.equal(current.birth,worker.birth,'OWNED_ROLE_BIRTH_BEFORE_KILL');
      assert.equal(current.group,worker.processGroup,'OWNED_ROLE_GROUP_BEFORE_KILL');
      assert.equal(current.group,worker.child.pid);assert.equal(current.session,worker.child.pid);
      const exited=new Promise(resolve=>worker.child.once('exit',(code,signal)=>resolve({code,signal})));
      process.kill(-worker.processGroup,'SIGKILL');const result=await exited;
      assert.equal(result.signal,'SIGKILL');await lab.stopStream();return result;
    }
    async function holdNext(worker,value) {
      await worker.call('arm');let entered=false;worker.held().then(()=>{entered=true;});
      await write(value);const stamp=(await lab.clock()).stamp;
      await wait(()=>entered,5000,'ACTUAL_CLINICAL_CYCLE_MUST_REACH_HOLD');
      const held=await state();assert(BigInt(held.observed.clock)>=BigInt(stamp),'RECEIPT_DURABLE_BEFORE_CLINICAL_HOLD');
      assert(BigInt(held.completed.clock)<BigInt(stamp),'HELD_CYCLE_MUST_NOT_COMPLETE');
      return stamp;
    }
    function completed(row, stamp) {
      return row && BigInt(require('../lib/pgstream/work-state').map(row.work_completed).clock || '0') >= BigInt(stamp);
    }
    it('keeps the SAME evaluator alive across external stream outage and resumes exact durable output after explicit fixture restart',async function(){
      await write(110);const config=lab.configure(),worker=await lab.worker(config,{detached:true});assert.equal(worker.startup.ready,true);
      const evaluator=identity(worker.child.pid),producer=lab.stream(),original=producer.identity(),before=await lab.previewCompleted();assert(original,'INDEPENDENT_PRODUCER_RUNNING');assert.notEqual(original.group,evaluator.group,'PRODUCER_NOT_IN_EVALUATOR_GROUP');
      const began=performance.now();await lab.stopStream();assert.equal(producer.state().running,false);
      await write(149);const stamp=(await lab.clock()).stamp;
      await wait(async()=>!(await worker.call('health')).pgstream.healthy,config.document.pgstream.bounds.stallMs+config.document.pgstream.bounds.stepMs,'STALE_EXTERNAL_STREAM_MUST_WITHDRAW_READINESS');
      const unavailable=(await worker.call('health')).pgstream;assert.equal(unavailable.terminal,false,'EXTERNAL_STREAM_OUTAGE_MUST_NOT_TERMINATE_ROLE');assert.equal(unavailable.code,'PGSTREAM_HEARTBEAT_STALLED');assert.deepEqual(identity(worker.child.pid),evaluator,'SAME_EVALUATOR_SURVIVES_STREAM_OUTAGE');
      assert.equal(producer.state().starts,1,'NO_FIXTURE_AUTOMATIC_RESTART');
      await lab.startStream();assert.notEqual(producer.identity().pid,original.pid,'EXPLICIT_EXTERNAL_PRODUCER_REPLACEMENT');
      const recovered=await wait(async()=>{const health=(await worker.call('health')).pgstream,output=await lab.previewCompleted();return health.healthy&&completed(output,stamp)&&BigInt(output.output_revision)>BigInt(before.output_revision)?{health,output}:null;},config.document.pgstream.bounds.recoveryMs,'EXTERNAL_STREAM_MUST_RECOVER_COMMITTED_OUTPUT');
      assert.equal(recovered.output.projection[0].output.frame.sgvs.find(row=>row._id==='synthetic-recovery').mgdl,149,'EXACT_COMMITTED_FRAME_AFTER_STREAM_RESUME');assert.deepEqual(identity(worker.child.pid),evaluator);
      lab.tracePreview('independent-stream-fixture-stop-and-resume',{elapsedMs:performance.now()-began,evaluator,producerBefore:original,producerAfter:producer.identity(),unavailable,recoveredHealth:recovered.health,completed:recovered.output.work_completed,scope:'Fixture-controlled standalone producer, not platform restart-policy qualification'});
      await lab.stopWorker(worker);
    });
    it('retains a newer observation across held completion and recovers pending clinical work after actual role process-group death',async function(){
      await write(110);const config=lab.configure(),worker=await lab.worker(config,{detached:true});assert.equal(worker.startup.ready,true);
      await holdNext(worker,130);await write(149);const newer=(await lab.clock()).stamp;
      await wait(async()=>BigInt((await state()).observed.clock)>=BigInt(newer),5000,'NEWER_RECEIPT_MUST_COMMIT_WHILE_OLDER_CYCLE_HELD');
      await worker.call('release');
      await wait(async()=>BigInt((await state()).completed.clock)>=BigInt(newer),10000,'NEWER_GENERATION_MUST_REMAIN_PENDING_UNTIL_COMPLETED');
      assert.equal((await lab.previewCompleted()).projection[0].output.frame.sgvs.find(row=>row._id==='synthetic-recovery').mgdl,149);
      const pending=await holdNext(worker,171),held=await state();
      const death=await killWorker(worker);
      const next=await lab.worker(config,{detached:true});assert.equal(next.startup.ready,true,'RESTARTED_ACTUAL_ROLE_READY');
      await wait(async()=>BigInt((await state()).completed.clock)>=BigInt(pending),10000,'PROCESS_LOSS_MUST_RECOVER_DURABLE_PENDING');
      const recovered=await lab.previewCompleted();assert.equal(recovered.projection[0].output.frame.sgvs.find(row=>row._id==='synthetic-recovery').mgdl,171);
      assert.equal((await lab.clock()).stamp,pending,'RESTART_RECOVERY_NEEDS_NO_INPUT_WRITE');
      lab.tracePreview('actual-role-held-generation-and-pending-crash-recovery',{death,held,newer,pending,recoveredCompleted:recovered.work_completed});
      await lab.stopWorker(next);
    });
    it('preserves completed output across process death and fires recovered future clinical due work without a new input write',async function(){
      await lab.setSettings({enable:['bgnow','delta','direction','simplealarms']});
      await write(50,'synthetic-recovery',600000-15000);
      const config=lab.configure(),worker=await lab.worker(config,{detached:true});assert.equal(worker.startup.ready,true);
      const before=await state(),outputBefore=await lab.previewCompleted(),clockBefore=(await lab.clock()).stamp;
      assert(Number(before.due_at)>Date.now(),'FUTURE_DUE_MUST_BE_DURABLE_BEFORE_DEATH');
      assert(Number(before.due_at)-Date.now()<20000,'BOUNDED_SYNTHETIC_DUE_REQUIRED');
      const death=await killWorker(worker),next=await lab.worker(config,{detached:true});assert.equal(next.startup.ready,true);
      const resumed=await state(),outputResumed=await lab.previewCompleted();
      assert.equal(outputResumed.output_revision,outputBefore.output_revision,'SAME_COMMITTED_CONTENT_MUST_NOT_DUPLICATE_REVISION_AFTER_DEATH');
      assert.deepEqual(outputResumed.work_completed,outputBefore.work_completed);
      await wait(async()=>{const current=await state();return Number(current.completed_at)>Number(resumed.completed_at)&&Number(current.completed_at)>=Number(before.due_at);},25000,'RESTARTED_DUE_MUST_FIRE_WITHOUT_INPUT');
      const after=await state(),outputAfter=await lab.previewCompleted();
      assert.equal((await lab.clock()).stamp,clockBefore,'TIME_WORK_MUST_NOT_REQUIRE_OR_CREATE_INPUT_WRITE');
      assert.equal(outputAfter.projection[0].output.trigger,'time-only','ACTUAL_DUE_CLINICAL_COMPLETION_REQUIRED');
      assert.equal(after.work_pending_at,null);
      lab.tracePreview('actual-role-completed-output-and-future-due-recovery',{death,before,resumed,after,clockBefore,outputRevision:outputAfter.output_revision});
      await lab.stopWorker(next);
    });
    it('preserves durable ACK refusal during an injected exact receiver grant failure and recovers without evaluator replacement',async function(){
      await write(110);const config=lab.configure(),worker=await lab.worker(config,{detached:true});assert.equal(worker.startup.ready,true);const evaluator=identity(worker.child.pid);
      const table='"'+lab.replayNamespace+'".tenant_consumer_checkpoint',role='"'+lab.previewRole+'"';
      const grants=async()=>(await lab.admin.query("SELECT grantor,grantee,is_grantable FROM information_schema.column_privileges WHERE table_schema=$1 AND table_name='tenant_consumer_checkpoint' AND column_name='work_observed' AND grantee=$2 AND privilege_type='UPDATE' ORDER BY grantor",[lab.replayNamespace,lab.previewRole])).rows;
      const canUpdate=async()=>(await lab.admin.query("SELECT has_column_privilege($1,$2,'work_observed','UPDATE') AS allowed",[lab.previewRole,lab.replayNamespace+'.tenant_consumer_checkpoint'])).rows[0].allowed;
      const prior=await grants();assert.equal(prior.length,1,'EXACT_PRIOR_COLUMN_GRANT_REQUIRED');assert.equal(prior[0].is_grantable,'NO');assert.equal(await canUpdate(),true);let stamp,producerState;
      try{
        await lab.admin.query('REVOKE UPDATE(work_observed) ON '+table+' FROM '+role);assert.equal(await canUpdate(),false);
        await write(149);stamp=(await lab.clock()).stamp;await new Promise(resolve=>setTimeout(resolve,2000));
        assert(BigInt((await state()).observed.clock)<BigInt(stamp),'FAILED_RECEIPT_MUST_NOT_BE_DURABLY_ACKNOWLEDGED');producerState=lab.stream().state();
      }finally{
        await lab.admin.query('GRANT UPDATE(work_observed) ON '+table+' TO '+role);assert.deepEqual(await grants(),prior,'EXACT_PRIOR_GRANT_RESTORED');assert.equal(await canUpdate(),true);
      }
      // Explicit test action, independent of the evaluator. The platform-owned
      // restart policy has its own canonical component witness.
      await lab.stopStream();await lab.startStream();
      await wait(async()=>{const health=(await worker.call('health')).pgstream;return health.healthy&&BigInt((await state()).completed.clock)>=BigInt(stamp);},30000,'GRANT_FAULT_DURABLE_RESUME');
      assert.deepEqual(identity(worker.child.pid),evaluator,'RECEIVER_GRANT_RECOVERY_KEEPS_SAME_ROLE');assert.equal((await lab.previewCompleted()).projection[0].output.frame.sgvs.find(row=>row._id==='synthetic-recovery').mgdl,149);
      lab.tracePreview('independent-stream-injected-receiver-grant-refusal',{priorGrant:prior,producerState,evaluator,stamp,scope:'Injected grant fault; observed producer exit state does not establish permanent wedging or production frequency'});await lab.stopWorker(worker);
    });
  });
