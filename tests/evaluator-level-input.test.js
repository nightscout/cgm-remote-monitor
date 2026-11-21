'use strict';

// Differential check of the evaluator's level-window input preparation.
//
// A level window's rows go straight into each domain's in-process source
// (postgres-projection-read prepareEncoded). The reference is the evaluator's
// other input path (replay.reconcile), which still takes every row through
// encode, a JSON round trip, decode and prepare. Given the same recovered
// rows, both must give the same cycle result, byte for byte: every clinical
// field, the browser frame and the due instant. The durable output and its
// content digest (typed-checkpoint complete) are functions of exactly these
// fields, so they are equal too. Only the reference's legacy `encodedRows`
// differ, which a level window never publishes.
//
// The windows are the synthetic views-equality scenarios (no record from a
// person), with both typed identity kinds, insertion ordinals, documents
// whose keys are not in jsonb order, and readings that tie on time so the
// ordinal tie-break decides their order. Each case runs an acquisition, a
// time-only cycle and a second acquisition; a byte bound just under and just
// over the input's size must refuse and admit on both paths alike. Controls:
// deliberately wrong level preparations (ordinals lost, a row lost, the byte
// bound skipped) must each be detected here.
const assert = require('node:assert/strict');
const { ObjectId } = require('mongodb');
const scope = require('../lib/storage/tenant-scope');
const evaluator = require('../lib/data/tenant-projection-evaluator');
const { canonical } = require('../lib/server/serve/evaluator-runtime');
const { decodeDocument } = require('../lib/storage/postgres-identity');
const { SCENARIOS, MIN } = require('./lib/views-equality/fixtures');
const brokenModule = require('./lib/clinical-working-set/control');
const environment = require('../lib/server/tenant-app/environment');

const TENANT = '11111111-1111-4111-8111-111111111111';
const DOMAINS = ['entries', 'treatments', 'devicestatus', 'profile'];
const THRESHOLDS = { bgHigh: 200, bgTargetTop: 180, bgTargetBottom: 80, bgLow: 55 };
const ENVS = {
  loop: () => environment({ settings: { enable: ['bgnow', 'delta', 'direction', 'rawbg', 'iob', 'cob', 'profile', 'basal', 'pump',
    'openaps', 'loop', 'timeago', 'simplealarms', 'devicestatus', 'careportal', 'bwp', 'ar2', 'sage', 'cage', 'iage', 'bage', 'upbat'], thresholds: THRESHOLDS } }),
  defaults: () => environment({ settings: { thresholds: THRESHOLDS } })
};

// The rows a level window returns: { domain, document, ordinal }, each
// document a JSON value as parsed from PostgreSQL's text, decoded to its typed
// identity. A fresh copy per call (the evaluator owns what it is given).
function windowOf (fx, extra = []) {
  const rows = [];
  let ordinal = 0;
  for (const domain of DOMAINS) {
    for (const [i, doc] of fx[domain].entries()) {
      const hex = (domain.charCodeAt(0).toString(16) + i.toString(16)).padStart(24, '0');
      // Keys in reverse insertion order: jsonb order is not the source's.
      const reversed = Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(doc))).reverse());
      const stored = { ...reversed, _id: i % 2 ? domain + '-' + i : hex };
      rows.push({ domain, id_kind: i % 2 ? 'string' : 'objectid', doc: stored, ordinal: ++ordinal });
    }
  }
  // Two readings at the newest reading's instant: the higher ordinal has the
  // lower _id, so only the ordinal tie-break orders them as stored.
  const newest = fx.entries.reduce((a, b) => (b.date > a.date ? b : a));
  for (const [k, sgv] of [[1, 141], [2, 77]]) {
    rows.push({ domain: 'entries', id_kind: 'string', doc: { ...JSON.parse(JSON.stringify(newest)), sgv, _id: 'tie-' + (3 - k) }, ordinal: ++ordinal });
  }
  for (const row of extra) rows.push({ ...row, ordinal: ++ordinal });
  return () => rows.map(row => ({ domain: row.domain, document: decodeDocument({ id_kind: row.id_kind, doc: JSON.parse(JSON.stringify(row.doc)) }), ordinal: row.ordinal }));
}

function recoveredOf (rows, at, generation) {
  return { checkpoint: at - 1000, progress: 'level-window', signature: { stamp: at - 1000, deleted: 0 }, generation,
    policy: {}, expiresAt: at + 3600000, rows: rows() };
}

// One component per path. Level: replay.window, the path under test.
// Reference: replay.reconcile, the encode/round-trip/decode/prepare path.
function component (level, state, env, factory = evaluator, bounds = {}) {
  const replay = level
    ? { level: true, async window () { return recoveredOf(state.rows, state.at, state.generation); }, async reconcile () { throw new Error('A level component reads its window'); } }
    : { async reconcile () { return recoveredOf(state.rows, state.at, state.generation); } };
  const language = require('../lib/language')();
  return factory({ tenant: TENANT, replay, env, language, includeFrame: true,
    connection: { async query () { throw new Error('No SQL: the views read in process'); } },
    dbstats: async () => ({ dataSize: 123456, indexSize: 7890, fileSize: 135000 }), maxRows: 10000, maxBytes: 8388608, ...bounds });
}

// The bound's measure on both paths: the whole input's text.
function inputSize (state, at) {
  const { encodeDocument } = require('../lib/storage/postgres-identity');
  const recovered = recoveredOf(state.rows, at, state.generation);
  return Buffer.byteLength(JSON.stringify({ checkpoint: recovered.checkpoint, progress: recovered.progress,
    rows: recovered.rows.map(row => ({ domain: row.domain, ...encodeDocument(row.document), ordinal: row.ordinal })),
    // The loop plugin set has no dbsize, so no statistics are read: {}.
    stats: {}, signature: recovered.signature, expiresAt: recovered.expiresAt, generation: state.generation }));
}

// The published cycle result: every field the durable output is made of.
function published (result) {
  const value = { ...result };
  delete value.encodedRows;
  return value;
}
function same (a, b, label) {
  const x = published(a), y = published(b);
  assert.equal(JSON.stringify(x), JSON.stringify(y), label + ': cycle result text');
  assert.equal(canonical(x), canonical(y), label + ': canonical content');
  assert.ok(x.frame && x.frame.sgvs && x.frame.sgvs.length > 0, label + ': a frame with readings');
}

async function cycles (scenario, envName, factory = evaluator) {
  const now = Math.floor(Date.now() / MIN) * MIN;
  const fx = SCENARIOS[scenario](now);
  const env = ENVS[envName]();
  const state = { at: now, generation: '7', rows: windowOf(fx) };
  const level = component(true, state, env, factory), reference = component(false, state, env);
  const out = [];
  try {
    await scope.withTenant(TENANT, async () => {
      out.push([await level.evaluate({ at: now }), await reference.evaluate({ at: now }), 'acquisition']);
      out.push([await level.evaluateTime({ at: now + 61000 }), await reference.evaluateTime({ at: now + 61000 }), 'time-only']);
      state.at = now + 2 * MIN;
      state.rows = windowOf(fx, [{ domain: 'entries', id_kind: 'string', doc: { _id: 'new-reading', type: 'sgv', sgv: 222, date: now + 2 * MIN - 5000,
        dateString: new Date(now + 2 * MIN - 5000).toISOString(), direction: 'SingleUp', device: 'views-equality' } }]);
      out.push([await level.evaluate({ at: state.at }), await reference.evaluate({ at: state.at }), 'second acquisition']);
    });
  } finally { level.close(); reference.close(); }
  return out;
}

describe('evaluator level-window input preparation (differential)', function () {
  this.timeout(120000);
  let previous;
  beforeEach(() => { previous = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(previous));

  const cases = [...Object.keys(SCENARIOS).map(name => [name, 'loop']), ['steady', 'defaults'], ['crowdedStatus', 'defaults'], ['noDeviceStatus', 'defaults']];
  for (const [scenario, envName] of cases) {
    it('gives the reference result for ' + scenario + ' (' + envName + ' plugins)', async function () {
      for (const [level, reference, kind] of await cycles(scenario, envName)) same(level, reference, scenario + ' ' + kind);
    });
  }

  it('refuses and admits at the byte bound exactly as the reference does', async function () {
    const now = Math.floor(Date.now() / MIN) * MIN;
    const fx = SCENARIOS.steady(now), env = ENVS.loop();
    const state = { at: now, generation: '7', rows: windowOf(fx) };
    const size = inputSize(state, now);
    for (const [maxBytes, admitted] of [[size - 1, false], [size, true]]) {
      const outcomes = [];
      for (const level of [true, false]) {
        const c = component(level, state, env, evaluator, { maxBytes });
        try {
          outcomes.push(await scope.withTenant(TENANT, () => c.evaluate({ at: now })).then(() => 'admitted', error => /byte bound/.test(error.message) ? 'refused' : error.message));
        } finally { c.close(); }
      }
      assert.deepEqual(outcomes, admitted ? ['admitted', 'admitted'] : ['refused', 'refused'], 'bound ' + maxBytes + ' of ' + size);
    }
  });

  // Controls: each deliberately wrong level preparation must be detected.
  const LEVEL_GROUPING = 'for (const row of input.rows) groups[row.domain].push(row);';
  const controls = [
    ['ordinals lost', LEVEL_GROUPING, 'for (const row of input.rows) groups[row.domain].push({ ...row, ordinal: null });', 'differs'],
    ['a row lost', LEVEL_GROUPING, 'for (const row of input.rows.slice(0, -1)) groups[row.domain].push(row);', 'differs'],
    ['byte bound skipped', "          if (Buffer.byteLength(text) > maxBytes) throw new Error('Evaluator retained input byte bound exceeded');\n          const groups",
      '          const groups', 'bound']
  ];
  for (const [name, needle, replacement, kind] of controls) {
    it('detects a level preparation with ' + name, async function () {
      const broken = brokenModule('../lib/data/tenant-projection-evaluator', needle, replacement);
      if (kind === 'differs') {
        const results = await cycles('steady', 'loop', broken);
        assert.throws(() => { for (const [level, reference, label] of results) same(level, reference, label); }, assert.AssertionError, name + ' must be detected');
        return;
      }
      const now = Math.floor(Date.now() / MIN) * MIN;
      const state = { at: now, generation: '7', rows: windowOf(SCENARIOS.steady(now)) };
      const c = component(true, state, ENVS.loop(), broken, { maxBytes: inputSize(state, now) - 1 });
      try {
        await assert.doesNotReject(scope.withTenant(TENANT, () => c.evaluate({ at: now })), 'the broken build admits an over-bound input');
      } finally { c.close(); }
    });
  }
});
