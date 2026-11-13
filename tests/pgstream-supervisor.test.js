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
  async function open(extra={}) { owner=await start({binary:path.join(directory,'child'),configFile:path.join(directory,'config'),bounds,
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
  it('refuses stalled durable work even while fresh heartbeats arrive', async function () {
    await open();owner.receipt(1);await owner.check();
    work={pending:true,oldestPendingAt:clock};
    clock+=bounds.pendingMs;owner.receipt(owner.health().sequence);await owner.check();
    assert.equal(owner.health().code,'PGSTREAM_CLINICAL_PROGRESS_STALLED');assert.equal(owner.health().terminal,true);
    assert.equal(owner.health().starts,1);assert.equal(owner.health().healthy,false);
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
  });
  it('terminally refuses a timed-out physical step and never overlaps it', async function () {
    let calls=0;await open({inspect:()=>{calls++;return new Promise(()=>{});}});
    assert.equal(owner.health().code,'PGSTREAM_STEP_TIMEOUT');await owner.check();assert.equal(calls,1);
  });
  it('retains terminal refusal if withdrawal itself hangs', async function () {
    await open({onUnavailable:()=>new Promise(()=>{})});source.grants=false;await owner.check();
    assert.equal(owner.health().terminal,true);assert.equal(owner.health().healthy,false);
  });
  it('rejects malformed or future heartbeat acknowledgements', async function () {
    await open();assert.throws(()=>owner.receipt(2),{code:'PGSTREAM_HEARTBEAT_INVALID'});assert.throws(()=>owner.receipt('1'),{code:'PGSTREAM_HEARTBEAT_INVALID'});
  });
});
