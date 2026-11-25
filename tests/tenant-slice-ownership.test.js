'use strict';
// Every tenant is owned exactly once at K = 1, 2, 4, 8, 9, 16, 20 and 32, in the evaluator and in realtime
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

// K above 8 is the evaluator range the deployment renders (1..32); the rule itself allows 1..1024.
const KS = [1, 2, 4, 8, 9, 16, 20, 32];
const SMALL = KS.filter(k => k <= 8), LARGE = KS.filter(k => k > 8);
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

function exactlyOnce (owner, label, ks = KS) {
  for (const k of ks) {
    const owns = Array.from({ length: k }, (_, ordinal) => owner(k, ordinal));
    const counts = new Array(k).fill(0);
    for (const tenant of TENANTS) {
      const owners = owns.map((own, ordinal) => own(tenant) ? ordinal : -1).filter(ordinal => ordinal >= 0);
      assert.equal(owners.length, 1, label + ' K=' + k + ': every tenant has exactly one owner');
      counts[owners[0]]++;
    }
    assert(counts.every(n => n > 0), label + ' K=' + k + ': every ordinal owns tenants ' + JSON.stringify(counts));
    // A process at or above K owns nothing (statefulset-ordinal-scaling).
    for (const extra of [k, k + 3, slice.MAX_MEMBERS - 1]) {
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

describe('tenant slice ownership at K = 1, 2, 4, 8, 9, 16, 20, 32', function () {
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
  // sha256-modulo-v1 as fixed values: the alignment harness holds the same table
  // (tools/mt-bench/kubernetes/test_evaluator_slices.py CORE_BUCKETS), so a change on either side is red.
  const VECTOR_KS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 16, 20, 32];
  const VECTORS = {
    '11111111-1111-4111-8111-111111111111': [0, 0, 1, 0, 0, 4, 0, 4, 1, 4, 0, 20],
    '22222222-2222-4222-8222-222222222222': [0, 1, 0, 3, 2, 3, 0, 3, 6, 11, 7, 11],
    '33333333-3333-4333-8333-333333333333': [0, 1, 1, 3, 1, 1, 3, 7, 7, 15, 11, 15],
    '44444444-4444-4444-8444-444444444444': [0, 0, 0, 0, 4, 0, 3, 4, 6, 4, 4, 4],
    '55555555-5555-4555-8555-555555555555': [0, 1, 0, 1, 2, 3, 1, 5, 3, 5, 17, 21],
    '66666666-6666-4666-8666-666666666666': [0, 1, 0, 1, 3, 3, 5, 5, 0, 5, 13, 5],
    '0f0e0d0c-0b0a-4908-8706-050403020100': [0, 0, 1, 0, 1, 4, 6, 4, 4, 4, 16, 4],
    'ffffffff-ffff-4fff-bfff-ffffffffffff': [0, 0, 1, 0, 0, 4, 5, 0, 4, 0, 0, 0]
  };
  const vectors = rule => { for (const [tenant, expected] of Object.entries(VECTORS)) assert.deepEqual(VECTOR_KS.map(k => rule.bucket(tenant, k)), expected, 'vector ' + tenant); };
  it('sha256-modulo-v1 fixed vectors at K = 1..8, 9, 16, 20, 32; a little-endian prefix is red', function () {
    assert.equal(slice.RULE, 'sha256-modulo-v1');
    // Independent of slice.js: the first 16 hex digits of sha256(id) as an unsigned integer, modulo K.
    for (const tenant of TENANTS.slice(0, 500)) for (const k of LARGE) {
      assert.equal(slice.bucket(tenant, k), Number(BigInt('0x' + crypto.createHash('sha256').update(tenant).digest('hex').slice(0, 16)) % BigInt(k)), 'K=' + k);
    }
    assert.throws(() => vectors(mutated('../lib/pool-membership/slice', 'readBigUInt64BE(0)', 'readBigUInt64LE(0)')), /vector/);
    vectors(slice);
  });
  it('control: a rule that folds K above 8 onto 8 ordinals passes K <= 8 and is red at K = 9, 16, 20, 32', function () {
    const folded = mutated('../lib/pool-membership/slice', 'return Number(prefix % BigInt(members));', 'return Number(prefix % BigInt(Math.min(members, 8)));');
    const owner = (k, ordinal) => folded.predicate(k, ordinal);
    exactlyOnce(owner, 'folded', SMALL);
    for (const k of LARGE) assert.throws(() => exactlyOnce(owner, 'folded', [k]), /every ordinal owns tenants/, 'K=' + k);
    for (const [role, shipping] of Object.entries(roles)) exactlyOnce(shipping, role, LARGE);
  });
  it('control: a slice bound of 8 members refuses K = 9, 16, 20, 32 at configuration; the shipping bound admits them', function () {
    const bounded = mutated('../lib/pool-membership/slice', 'const MAX_MEMBERS = 1024;', 'const MAX_MEMBERS = 8;');
    for (const k of LARGE) {
      assert.throws(() => bounded.fromEnvironment({ NS_SLICE_COUNT: String(k), NS_SLICE_ORDINAL: '0' }), /members <= 8/, 'K=' + k);
      assert.deepEqual({ ...slice.fromEnvironment({ NS_SLICE_COUNT: String(k), NS_SLICE_ORDINAL: String(k - 1) }) }, { count: k, ordinal: k - 1 });
      assert.deepEqual({ ...assigned.hostAssignment({ NS_EVALUATOR_SLICES: String(k) }, 'evaluator-' + (k - 1)) }, { count: k, ordinal: k - 1 });
    }
    assert.throws(() => assigned.hostAssignment({ NS_EVALUATOR_SLICES: '1025' }, 'evaluator-0'), /EVALUATOR_PROCESS_ASSIGNMENT_CONFIG/);
  });
});
