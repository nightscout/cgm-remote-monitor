'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');

describe('owned evaluator crash fixture source controls', function () {
  function worker(change = text => text) {
    const filename = require.resolve('./fixtures/evaluator-preview-registry-lab');
    const text = change(fs.readFileSync(filename, 'utf8'));
    const begin = text.indexOf('  lab.worker = async'), end = text.indexOf('  lab.stopWorker = async');
    assert(begin >= 0 && end > begin);
    const { EventEmitter } = require('node:events');
    const calls = [], fields = Array(24).fill('0');
    Object.assign(fields, { 0:'S', 1:'4000', 2:'4242', 3:'4242', 19:'123' });
    const lab = { prepareProduct:async () => {}, startStream:async()=>{}, tracePreview:() => {} };
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
