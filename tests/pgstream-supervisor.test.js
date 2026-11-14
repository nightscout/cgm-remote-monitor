'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { start } = require('../lib/pgstream/supervisor');
const bounds = { heartbeatMs: 10000, stallMs: 20000, stepMs: 100, stopMs: 100, recoveryMs: 100000, pendingMs: 5000, maxRestarts: 2 };
describe('targeted pgstream child supervisor (simulated health ports, real OS child)', function () {
  this.timeout(5000);
  let directory, owner, clock, source, work, unavailable;
  beforeEach(function () {
    directory=fs.mkdtempSync(path.join(os.tmpdir(),'ns-pgstream-supervisor-'));
    fs.writeFileSync(path.join(directory,'child'),'#!/bin/sh\nexec sleep 60\n',{mode:0o700});
    fs.writeFileSync(path.join(directory,'config'),'fixture');
    clock=100000; source={identity:true,grants:true,slot:'valid'}; work={pending:false}; unavailable=[];
  });
  afterEach(async function () { await owner?.close();fs.rmSync(directory,{recursive:true,force:true});owner=null; });
  async function open(extra={}, implementation=start) { owner=await implementation({binary:path.join(directory,'child'),configFile:path.join(directory,'config'),bounds,
    pulse:async()=>{},inspect:async()=>source,pending:async()=>work,onUnavailable:async code=>{unavailable.push(code);},now:()=>clock,...extra});return owner; }
  it('requires end-to-end receipt; source health alone is never healthy', async function () {
    await open();assert.equal(owner.health().healthy,false);
    owner.receipt(1);await owner.check();assert.equal(owner.health().healthy,true);
    clock+=1000;await owner.check();assert.equal(owner.health().starts,1);assert.equal(owner.health().healthy,true);
  });
  it('restarts a live child when its notifier has stopped, within declared bounds', async function () {
    await open();owner.receipt(1);await owner.check();
    clock+=bounds.stallMs;await owner.check();
    assert.equal(owner.health().starts,2);assert.equal(owner.health().healthy,false);
    assert.deepEqual(unavailable,['PGSTREAM_HEARTBEAT_STALLED']);
    owner.receipt(owner.health().sequence);await owner.check();assert.equal(owner.health().healthy,true);
  });
  it('reports stalled clinical work while healthy heartbeats keep the shared stream running', async function () {
    await open();owner.receipt(1);await owner.check();
    work={pending:true,oldestPendingAt:clock};
    clock+=bounds.pendingMs;owner.receipt(owner.health().sequence);await owner.check();
    assert.equal(owner.health().clinicalCode,'PGSTREAM_CLINICAL_PROGRESS_STALLED');assert.equal(owner.health().terminal,false);
    assert.equal(owner.health().starts,1);assert.equal(owner.health().healthy,true);assert.deepEqual(unavailable,[]);
  });
  it('gives recovered pending work one bounded owner recovery window', async function () {
    work={pending:true,oldestPendingAt:clock-bounds.pendingMs*2};
    await open();assert.equal(owner.health().terminal,false);
    owner.receipt(1);await owner.check();assert.equal(owner.health().healthy,true);
    clock+=bounds.pendingMs;owner.receipt(owner.health().sequence);await owner.check();
    assert.equal(owner.health().clinicalCode,'PGSTREAM_CLINICAL_PROGRESS_STALLED');
    assert.equal(owner.health().terminal,false);assert.equal(owner.health().healthy,true);
  });
  // Production deadlines from the bounded actual-role recovery fixture. A
  // recovered transport and outstanding clinical work have separate clocks.
  const recoveryBounds = { heartbeatMs: 1000, stallMs: 5000, stepMs: 5000, stopMs: 2000,
    recoveryMs: 30000, pendingMs: 30000, maxRestarts: 3 };
  async function recoverWithPending () {
    await open({ bounds: recoveryBounds }); owner.receipt(owner.health().sequence); await owner.check();
    clock=105001; await owner.check();
    assert.equal(owner.health().code,'PGSTREAM_HEARTBEAT_STALLED');
    assert.equal(owner.health().restarts,1);
    clock=110000; work={pending:true,oldestPendingAt:clock};
    owner.receipt(owner.health().sequence); await owner.check();
    assert.equal(owner.health().healthy,true,'fresh receipt and completed recovery restore transport');
  }
  it('keeps recovered transport healthy past its old failure deadline while pending work is within its own bound', async function () {
    await recoverWithPending();
    clock=135002; owner.receipt(owner.health().sequence); await owner.check();
    assert.equal(clock-work.oldestPendingAt,25002);
    assert.equal(owner.health().terminal,false,'a recovered transport must not retain its old recovery deadline');
    assert.equal(owner.health().healthy,true);
    assert.equal(owner.health().code,null);
    assert.equal(owner.health().restarts,0);
    assert.equal(owner.health().starts,2,'fresh recovered receipts must not restart the child');
  });
  it('keeps recovered transport healthy and exposes the independent clinical deadline', async function () {
    await recoverWithPending();
    clock=135002; owner.receipt(owner.health().sequence); await owner.check();
    assert.equal(owner.health().healthy,true,'pending work remains within its own deadline');
    clock=140001; owner.receipt(owner.health().sequence); await owner.check();
    assert.equal(clock-work.oldestPendingAt,30001);
    assert.equal(owner.health().healthy,true);
    assert.equal(owner.health().terminal,false);
    assert.equal(owner.health().clinicalCode,'PGSTREAM_CLINICAL_PROGRESS_STALLED');
    assert.equal(owner.health().starts,2,'expired clinical work must not restart transport');
  });
  // Clinical expiry no longer terminally stops shared transport: affected
  // tenant effects remain fenced by the evaluator runtime's pending deadline.
  it('control: restored global clinical-terminal coupling stops a healthy stream, while the split preserves it',async function(){
    const vm=require('node:vm'),file=require.resolve('../lib/pgstream/supervisor'),sourceText=fs.readFileSync(file,'utf8'),needle='clinicalStalled = pendingSince !== null && now() - Math.max(pendingSince, recoveryStartedAt) >= bounds.pendingMs;';assert(sourceText.includes(needle));const broken=sourceText.replace(needle,needle+"if(clinicalStalled){terminal='PGSTREAM_CLINICAL_PROGRESS_STALLED';throw fail(terminal);}"),module={exports:{}};
    vm.runInThisContext('(function(require,module,exports){'+broken+'\n})',{filename:file})(require,module,module.exports);
    async function criterion(implementation){work={pending:false};clock=100000;await open({},implementation);owner.receipt(1);await owner.check();work={pending:true,oldestPendingAt:clock};clock+=bounds.pendingMs;owner.receipt(owner.health().sequence);await owner.check();const observed=owner.health();await owner.close();owner=null;assert.equal(observed.healthy,true,'POISON_MUST_NOT_STOP_SHARED_HEARTBEAT');assert.equal(observed.clinicalStalled,true);}
    await assert.rejects(criterion(module.exports.start),/POISON_MUST_NOT_STOP_SHARED_HEARTBEAT/);await criterion(start);
  });
  it('requires explicit rebootstrap after slot loss; it never recreates the slot', async function () {
    source={identity:true,grants:true,slot:'lost'};await open();
    assert.equal(owner.health().code,'PGSTREAM_REBOOTSTRAP_REQUIRED');assert.equal(owner.health().terminal,true);
  });
  it('refuses identity or grant loss instead of restarting on another source', async function () {
    await open();source.grants=false;await owner.check();
    assert.equal(owner.health().code,'PGSTREAM_SOURCE_REFUSED');assert.equal(owner.health().starts,1);
  });
  it('ends bounded recovery rather than endlessly replacing live stopped children', async function () {
    await open();clock+=bounds.stallMs;await owner.check();clock+=bounds.stallMs;await owner.check();clock+=bounds.stallMs;await owner.check();
    assert.equal(owner.health().code,'PGSTREAM_RECOVERY_EXHAUSTED');assert.equal(owner.health().starts,3);
    assert.equal(owner.diagnostics().lastFailure.code,'PGSTREAM_HEARTBEAT_STALLED','terminal refusal must retain its underlying cause');
    assert(owner.diagnostics().lastChildExit?.pid,'actual child exit retained');
  });
  it('terminally refuses a timed-out physical step and never overlaps it', async function () {
    let calls=0;await open({inspect:()=>{calls++;return new Promise(()=>{});}});
    assert.equal(owner.health().code,'PGSTREAM_STEP_TIMEOUT');assert.equal(owner.diagnostics().lastStepFailure.phase,'inspect');assert.equal(owner.diagnostics().lastFailure.code,'PGSTREAM_STEP_TIMEOUT');await owner.check();assert.equal(calls,1);
  });
  it('retains terminal refusal if withdrawal itself hangs', async function () {
    await open({onUnavailable:()=>new Promise(()=>{})});source.grants=false;await owner.check();
    assert.equal(owner.health().terminal,true);assert.equal(owner.health().healthy,false);
  });
  it('retains bounded classified child stderr without payloads or arbitrary text in private diagnostics', async function () {
    const row = JSON.stringify({level:'error',message:'sending webhook event',error:'HTTP status code 503: timeout SYNTHETIC_PRIVATE_TEXT',payload:'SYNTHETIC_CLINICAL_PAYLOAD',secret:'SYNTHETIC_SECRET'});
    fs.writeFileSync(path.join(directory,'child'),'#!/bin/sh\n'+Array.from({length:12},()=>"printf '%s\\n' '"+row+"' >&2\n").join('')+'exec sleep 60\n',{mode:0o700});
    await open();
    const end = Date.now()+1000;
    while(owner.diagnostics().childLogs.length<8 && Date.now()<end) await new Promise(resolve=>setTimeout(resolve,5));
    const details=owner.diagnostics();assert.equal(details.childLogs.length,8,'CHILD_LOG_BOUND');
    assert(details.childLogs.every(line=>line.stream==='stderr'&&line.httpStatus==='503'&&line.errors.includes('timeout')),'ACTUAL_CHILD_STDERR_CLASSIFICATION');
    assert(!JSON.stringify(details).includes('SYNTHETIC_'),'NO_PAYLOAD_OR_ARBITRARY_ERROR_TEXT');
    assert.equal(Object.hasOwn(owner.health(),'childLogs'),false,'PRIVATE_DIAGNOSTICS_NOT_HEALTH_WIRE');
  });
  it('rejects malformed or future heartbeat acknowledgements', async function () {
    await open();assert.throws(()=>owner.receipt(2),{code:'PGSTREAM_HEARTBEAT_INVALID'});assert.throws(()=>owner.receipt('1'),{code:'PGSTREAM_HEARTBEAT_INVALID'});
  });
});
