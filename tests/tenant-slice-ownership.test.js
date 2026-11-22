'use strict';
// Every tenant is owned exactly once at K = 1, 2, 4 and 8, in the evaluator and in realtime
// (decision evaluator-k-planned-restart; the capacity campaign plans K from tenants and rate).
// Replaces the K = 2 ownership assertions of the retired native sharding fixture (E6).
// covers: lib/pool-membership/slice.js, lib/pgstream/assigned-worker.js, lib/realtime-ownership/index.js
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const slice = require('../lib/pool-membership/slice');
const assigned = require('../lib/pgstream/assigned-worker');
const realtime = require('../lib/realtime-ownership');

const KS = [1, 2, 4, 8];
const uuid = i => crypto.createHash('sha256').update('slice-ownership-' + i).digest('hex').slice(0, 32)
  .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
const TENANTS = Array.from({ length: 4000 }, (_, i) => uuid(i));

// Owners of a tenant among the K processes of one role, as that role configures its own process.
const evaluatorOwns = (k, ordinal, rule = assigned) => {
  const selected = rule.hostAssignment({ NS_EVALUATOR_SLICES: String(k) }, 'evaluator-' + ordinal);
  // K = 1 is unsliced: the one evaluator owns every tenant.
  return selected ? slice.predicate(selected.count, selected.ordinal) : () => true;
};
const realtimeOwns = (k, ordinal, ownership = realtime) => ownership.load({ NS_SLICE_COUNT: String(k), NS_SLICE_ORDINAL: String(ordinal) }).owns;
const roles = { evaluator: evaluatorOwns, realtime: realtimeOwns };

function exactlyOnce (owner, label) {
  for (const k of KS) {
    const owns = Array.from({ length: k }, (_, ordinal) => owner(k, ordinal));
    const counts = new Array(k).fill(0);
    for (const tenant of TENANTS) {
      const owners = owns.map((own, ordinal) => own(tenant) ? ordinal : -1).filter(ordinal => ordinal >= 0);
      assert.equal(owners.length, 1, label + ' K=' + k + ': every tenant has exactly one owner');
      counts[owners[0]]++;
    }
    assert(counts.every(n => n > 0), label + ' K=' + k + ': every ordinal owns tenants ' + JSON.stringify(counts));
    // A process at or above K owns nothing (statefulset-ordinal-scaling).
    for (const extra of [k, k + 3]) {
      if (k === 1 && label === 'evaluator') continue; // unsliced evaluator has no ordinal
      assert.equal(TENANTS.filter(owner(k, extra)).length, 0, label + ' K=' + k + ': ordinal ' + extra + ' owns nothing');
    }
  }
}

// The same module source with one statement changed, loaded in the real module's context.
function mutated (file, from, to, extra = {}) {
  const source = fs.readFileSync(require.resolve(file), 'utf8');
  assert.equal(source.split(from).length, 2, 'control seam must occur once: ' + from);
  const module = { exports: {} }, filename = require.resolve(file);
  vm.runInThisContext('(function(require,module,exports){' + source.replace(from, to) + '\n})', { filename })(createRequire(filename), module, module.exports);
  return Object.assign(module.exports, extra);
}

describe('tenant slice ownership at K = 1, 2, 4, 8', function () {
  // A process at or above K logs its own warning; the cases below build such processes on purpose.
  let warn;
  before(() => { warn = console.warn; console.warn = () => {}; });
  after(() => { console.warn = warn; });
  for (const [role, owner] of Object.entries(roles)) {
    it(role + ': every tenant is owned by exactly one ordinal and an ordinal at or above K owns nothing', function () {
      exactlyOnce(owner, role);
    });
  }
  it('the evaluator and realtime share one canonical rule (tenant to ordinal)', function () {
    for (const k of KS.filter(k => k > 1)) for (const tenant of TENANTS.slice(0, 500)) {
      const ordinal = slice.bucket(tenant, k);
      assert(evaluatorOwns(k, ordinal)(tenant) && realtimeOwns(k, ordinal)(tenant), 'K=' + k);
    }
  });
  it('control: an ownership rule that lets two ordinals own one tenant is red; the shipping rule is green', function () {
    const overlap = mutated('../lib/pool-membership/slice', 'return Object.freeze(tenant => bucket(tenant, members) === ordinal);',
      'return Object.freeze(tenant => bucket(tenant, members) >= ordinal);');
    assert.throws(() => exactlyOnce((k, ordinal) => {
      const selected = assigned.hostAssignment({ NS_EVALUATOR_SLICES: String(k) }, 'evaluator-' + ordinal);
      return selected ? overlap.predicate(selected.count, selected.ordinal) : () => true;
    }, 'evaluator'), /exactly one owner/);
    const orphan = mutated('../lib/realtime-ownership/index.js', 'owns: tenant => slice.bucket(tenant, shape.count) === shape.ordinal,',
      'owns: tenant => slice.bucket(tenant, shape.count) === shape.ordinal && slice.bucket(tenant, shape.count) !== 0,');
    assert.throws(() => exactlyOnce((k, ordinal) => realtimeOwns(k, ordinal, orphan), 'realtime'), /exactly one owner/);
    exactlyOnce(evaluatorOwns, 'evaluator'); exactlyOnce(realtimeOwns, 'realtime');
  });
});
