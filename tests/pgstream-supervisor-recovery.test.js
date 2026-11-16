'use strict';
// Source/protocol fault discrimination. The real OS child is a synthetic sleep
// process; these controls do not qualify the maintained pgstream notifier.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const supervisor = require('../lib/pgstream/supervisor');
const file = require.resolve('../lib/pgstream/supervisor');
const source = fs.readFileSync(file, 'utf8');
const bounds = { heartbeatMs:10000, stallMs:20000, stepMs:20, stopMs:100,
  recoveryMs:100000, pendingMs:5000, maxRestarts:2 };
function mutant(needle, replacement) {
  assert.equal(source.split(needle).length, 2, 'control must change exactly one production boundary');
  const target = { exports:{} };
  vm.runInThisContext('(function(require,module,exports){'+source.replace(needle, replacement)+'\n})', { filename:file })(createRequire(file), target, target.exports);
  return target.exports.start;
}
async function exercise(start, criterion, extra = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-recovery-control-'));
  fs.writeFileSync(path.join(directory, 'child'), '#!/bin/sh\nexec sleep 60\n', { mode:0o700 });
  fs.writeFileSync(path.join(directory, 'config'), 'synthetic');
  let owner, clock = 100000;
  const unavailable = [];
  try {
    owner = await start({ binary:path.join(directory, 'child'), configFile:path.join(directory, 'config'), bounds,
      inspect:async () => ({ identity:true, grants:true, slot:'valid' }), pulse:async () => {},
      pending:async () => ({ pending:false }), onUnavailable:async code => { unavailable.push(code); },
      now:() => clock, ...extra });
    await criterion({ owner, unavailable, advance:ms => { clock += ms; } });
  } finally {
    await owner?.close();
    fs.rmSync(directory, { recursive:true, force:true });
  }
}
describe('pgstream recovery boundaries with broken and restored source', function () {
  this.timeout(5000);
  it('detects a live child with no end-to-end receipts even when source probes succeed', async function () {
    const criterion = async ({ owner, advance, unavailable }) => {
      owner.receipt(1); await owner.check(); assert.equal(owner.health().healthy, true);
      advance(bounds.stallMs); await owner.check();
      assert.equal(owner.health().healthy, false, 'LIVE_NOTIFIER_WITHOUT_RECEIPTS_MUST_WITHDRAW');
      assert.equal(owner.health().starts, 2);
      assert.deepEqual(unavailable, ['PGSTREAM_HEARTBEAT_STALLED']);
      owner.receipt(owner.health().sequence); await owner.check();
      assert.equal(owner.health().healthy, true);
    };
    const broken = mutant(' || age >= bounds.stallMs', '');
    await assert.rejects(exercise(broken, criterion), /LIVE_NOTIFIER_WITHOUT_RECEIPTS_MUST_WITHDRAW/);
    await exercise(supervisor.start, criterion);
  });
  it('exhausts the declared restart budget instead of repeatedly replacing live stopped children', async function () {
    const criterion = async ({ owner, advance }) => {
      for (let i=0; i<3; i++) { advance(bounds.stallMs); await owner.check(); }
      assert.equal(owner.health().terminal, true, 'RESTART_BUDGET_MUST_TERMINATE');
      assert.equal(owner.health().code, 'PGSTREAM_RECOVERY_EXHAUSTED');
      assert.equal(owner.health().starts, 3);
    };
    const broken = mutant(' || restarts >= bounds.maxRestarts', '');
    await assert.rejects(exercise(broken, criterion), /RESTART_BUDGET_MUST_TERMINATE/);
    await exercise(supervisor.start, criterion);
  });
  it('requires explicit lost-slot rebootstrap even when identity and grants are valid', async function () {
    const criterion = async ({ owner }) => {
      assert.equal(owner.health().terminal, true, 'LOST_SLOT_MUST_REFUSE');
      assert.equal(owner.health().code, 'PGSTREAM_REBOOTSTRAP_REQUIRED');
      assert.equal(owner.health().starts, 1);
    };
    const options = { inspect:async () => ({ identity:true, grants:true, slot:'lost' }) };
    const broken = mutant(" || source.slot !== 'valid'", '');
    await assert.rejects(exercise(broken, criterion, options), /LOST_SLOT_MUST_REFUSE/);
    await exercise(supervisor.start, criterion, options);
  });
  it('terminally refuses an unresolved physical step and cannot start a second attempt', async function () {
    async function criterion(start) {
      let calls = 0;
      await exercise(start, async ({ owner }) => {
        assert.equal(owner.health().terminal, true, 'HUNG_STEP_MUST_TERMINATE');
        assert.equal(owner.health().code, 'PGSTREAM_STEP_TIMEOUT');
        assert.equal(owner.diagnostics().lastStepFailure.phase, 'inspect');
        await owner.check(); assert.equal(calls, 1, 'UNFINISHED_STEP_MUST_NOT_OVERLAP');
      }, { inspect:() => { calls++; return new Promise(() => {}); } });
    }
    const broken = mutant("if (abort.signal.aborted) terminal = 'PGSTREAM_STEP_TIMEOUT';", '');
    await assert.rejects(criterion(broken), /HUNG_STEP_MUST_TERMINATE/);
    await criterion(supervisor.start);
  });
});

describe('owned evaluator crash fixture source controls', function () {
  function worker(change = text => text) {
    const filename = require.resolve('./fixtures/evaluator-preview-registry-lab');
    const text = change(fs.readFileSync(filename, 'utf8'));
    const begin = text.indexOf('  lab.worker = async'), end = text.indexOf('  lab.stopWorker = async');
    assert(begin >= 0 && end > begin);
    const { EventEmitter } = require('node:events');
    const calls = [], fields = Array(24).fill('0');
    Object.assign(fields, { 0:'S', 1:'4000', 2:'4242', 3:'4242', 19:'123' });
    const lab = { prepareProduct:async () => {}, tracePreview:() => {} };
    const fork = (file, args, options) => {
      calls.push(options);
      const child = Object.assign(new EventEmitter(), { pid:4242, exitCode:null, signalCode:null, stdout:new EventEmitter(), stderr:new EventEmitter() });
      queueMicrotask(() => child.emit('message', { ready:true })); return child;
    };
    const read = { readFileSync(file) { assert.equal(file, '/proc/4242/stat'); return '4242 (synthetic worker) '+fields.join(' '); } };
    const build = new Function('lab','fork','fs','path','assert','env','children','__dirname',text.slice(begin,end)+'\nreturn lab.worker;');
    return { run:build(lab,fork,read,path,assert,() => ({}),new Set(),path.dirname(filename)), calls };
  }
  async function criterion(change) {
    const f = worker(change), actual = await f.run({ file:'/synthetic/config' }, { detached:true });
    assert.equal(f.calls[0].detached,true,'DETACHED_MUST_FORWARD');
    assert.equal(actual.birth,'123','CRASH_FIXTURE_MUST_CAPTURE_BIRTH');
    assert.equal(actual.processGroup,4242,'CRASH_FIXTURE_MUST_CAPTURE_GROUP');
  }
  it('preserves default spawn behavior and refuses a malformed opt-in before creating a child', async function () {
    const f = worker();
    await f.run({ file:'/synthetic/config' }); assert.equal(f.calls[0].detached,false);
    await assert.rejects(f.run({ file:'/synthetic/config' }, { detached:'true' }), /Explicit worker detached boolean/);
    assert.equal(f.calls.length,1);
  });
  it('missing detached forwarding or birth capture is red and the exact restored fixture passes', async function () {
    await assert.rejects(criterion(text => text.replace('silent: true, detached','silent: true')), /DETACHED_MUST_FORWARD/);
    await assert.rejects(criterion(text => text.replace('owned = { birth: fields[19], processGroup: child.pid };','owned = {};')), /CRASH_FIXTURE_MUST_CAPTURE_BIRTH/);
    await criterion(text => text);
  });
});

describe('durable pending and due reconstruction discriminators', function () {
  const schedulerFile = require.resolve('../lib/pgstream/activity-scheduler');
  const schedulerText = fs.readFileSync(schedulerFile,'utf8');
  function start(change) {
    const target={exports:{}};
    vm.runInThisContext('(function(require,module,exports){'+change(schedulerText)+'\n})',{filename:schedulerFile})(createRequire(schedulerFile),target,target.exports);
    return target.exports.start;
  }
  async function criterion(change, due) {
    let now=100, runs=0, timerId=0, pending=!due;
    const timers=new Map();
    const store={ async work(){return pending||due&&now>=200?[{tenant:'synthetic',pendingAt:pending?1:null}]:[];},async nextDue(){return due&&runs===0?200:null;} };
    const value=start(change)({store,scan:async()=>{},run:async()=>{runs++;pending=false;},send:async()=>{},now:()=>now,
      setTimer(fn,ms){const id=++timerId;timers.set(id,{fn,at:now+ms});return id;},clearTimer:id=>timers.delete(id)});
    try{
      await value.recover();
      if(due){assert([...timers.values()].some(row=>row.at===200),'DUE_MUST_RECONSTRUCT_TIMER');now=200;for(const [id,timer]of [...timers])if(timer.at<=now){timers.delete(id);await timer.fn();}await new Promise(resolve=>setImmediate(resolve));}
      assert.equal(runs,1,due?'DUE_MUST_RUN_WITHOUT_INPUT':'RECOVERED_PENDING_MUST_RUN');
    }finally{await value.close();}
  }
  it('detects dropping recovered pending work before clinical execution',async function(){
    await assert.rejects(criterion(text=>text.replace("queued.set(row.tenant,row.pendingAt!==null?'clock':'due');",''),false),/RECOVERED_PENDING_MUST_RUN/);
    await criterion(text=>text,false);
  });
  it('detects omitting durable due reconstruction without another input wake',async function(){
    await assert.rejects(criterion(text=>text.replace('if(at!==null){dueTimer=setTimer','if(false){dueTimer=setTimer'),true),/DUE_MUST_RECONSTRUCT_TIMER/);
    await criterion(text=>text,true);
  });
});
