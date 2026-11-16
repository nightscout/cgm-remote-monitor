'use strict';
// Actual evaluator role and canonical maintained producer, two synthetic tenants.
// Does not exercise selected partition topology, cold API, or restore acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { optInSuite } = require('./support/opt-in');
const stream = require('./fixtures/pgstream-native');
const enabled = process.env.NS_PGSTREAM_RECOVERY_TEST === '1' && !!process.env.NS_TEST_POSTGRES_ADMIN_URI;
optInSuite(enabled, 'NS_PGSTREAM_RECOVERY_TEST=1 and owned disposable PostgreSQL plus canonical pgstream fixture inputs')(
  'actual role maintained-stream recovery fault points', function () {
    this.timeout(60000);
    const lab = require('./fixtures/evaluator-preview-registry-lab')();
    let stopped;
    before(() => lab.open());
    beforeEach(() => lab.reset());
    after(async () => {
      // Resume only our exact still-current stopped child so normal fixture
      // cleanup can drain it. The supervisor may already have replaced it.
      if (stopped && sameProcess(stopped)) process.kill(stopped.pid, 'SIGCONT');
      await lab.close();
    });
    function identity(pid) {
      const stat = fs.readFileSync('/proc/'+pid+'/stat', 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/);
      return { pid, parent:Number(fields[1]), group:Number(fields[2]), session:Number(fields[3]), birth:fields[19], executable:fs.readlinkSync('/proc/'+pid+'/exe') };
    }
    function sameProcess(record) {
      try { return JSON.stringify(identity(record.pid)) === JSON.stringify(record); } catch { return false; }
    }
    function notifier(worker) {
      const selected = stream.capability(process.env);
      const children = fs.readFileSync('/proc/'+worker.child.pid+'/task/'+worker.child.pid+'/children', 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
      const matches = children.map(identity).filter(row => row.executable === selected.binary);
      assert.equal(matches.length, 1, 'ONE_OWNED_MAINTAINED_NOTIFIER');
      const record = matches[0]; assert.equal(record.parent, worker.child.pid);
      assert.equal(crypto.createHash('sha256').update(fs.readFileSync('/proc/'+record.pid+'/exe')).digest('hex'), selected.sha256);
      assert(sameProcess(record), 'NOTIFIER_IDENTITY_BEFORE_SIGNAL'); return record;
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
      assert.equal(result.signal,'SIGKILL');return result;
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
    it('commits a clinical write with a stopped notifier, withdraws stale transport and recovers durable output within fixed bounds', async function () {
      await write(110); const config = lab.configure();
      const worker = await lab.worker(config); assert.equal(worker.startup.ready, true);
      const initial = await worker.call('health'); assert.equal(initial.pgstream.healthy, true);
      const before = await lab.previewCompleted();
      const record = notifier(worker); stopped = record;
      const began = performance.now(); process.kill(record.pid, 'SIGSTOP');
      // The storage transaction has no notifier/webhook dependency.
      await write(149);
      const committed = await lab.clock();
      const stamp = committed.stamp;
      assert(stamp !== undefined, 'CANONICAL_COMMITTED_CLOCK_REQUIRED');
      await wait(async () => {
        const health = (await worker.call('health')).pgstream;
        return !health.healthy || health.starts > initial.pgstream.starts;
      }, config.document.pgstream.bounds.stallMs+config.document.pgstream.bounds.heartbeatMs+config.document.pgstream.bounds.stepMs+config.document.pgstream.bounds.stopMs,
      'STOPPED_NOTIFIER_MUST_CHANGE_HEALTH_WITHIN_BOUND');
      const observed = await wait(async () => {
        const health = (await worker.call('health')).pgstream;
        assert.equal(health.terminal, false, health.code || 'NOTIFIER_RECOVERY_TERMINAL');
        const output = await lab.previewCompleted();
        return health.healthy && health.starts > initial.pgstream.starts && completed(output, stamp) && BigInt(output.output_revision)>BigInt(before.output_revision) ? { health, output } : null;
      }, config.document.pgstream.bounds.recoveryMs, 'NOTIFIER_MUST_RECOVER_COMMITTED_OUTPUT');
      assert(!sameProcess(record), 'STOPPED_NOTIFIER_REPLACED'); stopped = null;
      const output = observed.output.projection?.[0]?.output;
      assert(output, 'DURABLE_OUTPUT_REQUIRED');
      assert.equal(output.frame.sgvs.find(row => row._id === 'synthetic-recovery')?.mgdl, 149, 'RECOVERED_OUTPUT_CONTAINS_EXACT_COMMITTED_READING');
      lab.tracePreview('stopped-maintained-notifier-recovered', { elapsedMs:performance.now()-began, bounds:config.document.pgstream.bounds,
        health:observed.health, completed:observed.output.work_completed, outputRevision:observed.output.output_revision });
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
    it('classifies maintained notifier exit versus live no-progress after an injected exact receiver grant failure',async function(){
      await write(110);const config=lab.configure(),worker=await lab.worker(config,{detached:true});assert.equal(worker.startup.ready,true);
      const original=notifier(worker),initial=(await worker.call('health')).pgstream;
      const table='"'+lab.replayNamespace+'".tenant_consumer_checkpoint',role='"'+lab.previewRole+'"';
      const grants=async()=>(await lab.admin.query("SELECT grantor,grantee,is_grantable FROM information_schema.column_privileges WHERE table_schema=$1 AND table_name='tenant_consumer_checkpoint' AND column_name='work_observed' AND grantee=$2 AND privilege_type='UPDATE' ORDER BY grantor",[lab.replayNamespace,lab.previewRole])).rows;
      const canUpdate=async()=>(await lab.admin.query("SELECT has_column_privilege($1,$2,'work_observed','UPDATE') AS allowed",[lab.previewRole,lab.replayNamespace+'.tenant_consumer_checkpoint'])).rows[0].allowed;
      const prior=await grants();assert.equal(prior.length,1,'EXACT_PRIOR_COLUMN_GRANT_REQUIRED');assert.equal(prior[0].is_grantable,'NO');assert.equal(await canUpdate(),true);
      const began=performance.now(),samples=[];let stamp;
      try{
        await lab.admin.query('REVOKE UPDATE(work_observed) ON '+table+' FROM '+role);assert.equal(await canUpdate(),false,'EXACT_RECEIVER_GRANT_WITHDRAWN');
        await write(149);stamp=(await lab.clock()).stamp;
        const end=performance.now()+2000;
        while(performance.now()<end){const health=(await worker.call('health')).pgstream;let child=null,childState=null;try{child=identity(original.pid);const stat=fs.readFileSync('/proc/'+original.pid+'/stat','utf8');childState=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/)[0];}catch(error){if(!['ENOENT','ESRCH'].includes(error.code))throw error;child=null;}
          samples.push({atMs:performance.now()-began,sameChild:child!==null&&JSON.stringify(child)===JSON.stringify(original),childState,received:health.received,pulses:health.pulses,starts:health.starts,terminal:health.terminal});
          await new Promise(resolve=>setTimeout(resolve,50));
        }
      }finally{
        await lab.admin.query('GRANT UPDATE(work_observed) ON '+table+' TO '+role);assert.deepEqual(await grants(),prior,'EXACT_PRIOR_GRANT_RESTORED');assert.equal(await canUpdate(),true);
      }
      const recovered=await wait(async()=>{const health=(await worker.call('health')).pgstream;assert.equal(health.terminal,false,health.code||'GRANT_FAULT_RECOVERY_TERMINAL');return health.healthy&&health.starts>initial.starts&&BigInt((await state()).completed.clock)>=BigInt(stamp)?health:null;},30000,'GRANT_FAILURE_MUST_RECOVER_AFTER_EXACT_RESTORATION');
      const details=worker.logs().stderr.split('\n').filter(line=>line.startsWith('Pgstream unavailable ')).map(line=>JSON.parse(line.slice('Pgstream unavailable '.length)));
      assert(details.some(row=>row.receiver?.receiverRefusals>0),'ACTUAL_RECEIVER_REFUSAL_REQUIRED');assert(details.some(row=>row.code==='PGSTREAM_HEARTBEAT_STALLED'),'EXPECTED_TRANSPORT_FAILURE_CLASSIFICATION');
      const exited=details.find(row=>row.lastChildExit?.pid===original.pid)?.lastChildExit;
      const classification=exited&&exited.signal===null&&Number.isInteger(exited.code)?'natural-nonzero-child-exit':'live-until-bounded-supervisor-intervention';
      if(classification==='natural-nonzero-child-exit')assert.notEqual(exited.code,0,'FAILED_CHILD_MUST_EXIT_NONZERO');
      else assert(details.some(row=>row.childLogs.some(log=>log.message==='stop processing, notify has stopped')),'ENDED_NOTIFY_EVIDENCE_REQUIRED_BEFORE_CALLING_IT_STALLED');
      assert.equal((await lab.previewCompleted()).projection[0].output.frame.sgvs.find(row=>row._id==='synthetic-recovery').mgdl,149);
      lab.tracePreview('injected-grant-fault-upstream-exit-classification',{fault:'injected-column-grant-withdrawal',classification,original,priorGrant:prior,samples,details,recovered,elapsedMs:performance.now()-began,claim:'Observed behavior for this injected fault, not production failure frequency or proof of permanent wedging'});
      await lab.stopWorker(worker);
    });
  });
