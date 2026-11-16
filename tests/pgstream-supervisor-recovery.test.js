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
