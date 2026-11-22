'use strict';

// Resident window (decision stateful-evaluator-resident-window), without a
// database: the writer's notes and mark, the plan's refusals, the tail merge,
// and the shipping level component reading through a resident against the
// same component reading in full (tests/lib/resident-window/memory-replay.js
// applies the mark as its UPDATE does and reads through the product's
// resident-window read). The PostgreSQL statements are exercised in
// tests/resident-window.integration.test.js.
const assert = require('node:assert/strict');
const windowMark = require('../lib/writer-driven/window-mark');
const residentWindow = require('../lib/storage/resident-window');
const windowPolicy = require('../lib/storage/clinical-working-set-policy');
const memory = require('./lib/resident-window/memory-replay');
const scope = require('../lib/storage/tenant-scope');
const clock = require('./lib/views-replay/clock');
const { SCENARIOS, MIN, HOUR, DAY } = require('./lib/views-equality/fixtures');
const environment = require('../lib/server/tenant-app/environment');

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const iso = ms => new Date(ms).toISOString();

describe('resident window marks (writer side)', function () {
  it('reads its switch strictly', function () {
    assert.equal(windowMark.enabled({}), false);
    assert.equal(windowMark.enabled({ NS_EVALUATOR_RESIDENT_WINDOW: '' }), false);
    assert.equal(windowMark.enabled({ NS_EVALUATOR_RESIDENT_WINDOW: '0' }), false);
    assert.equal(windowMark.enabled({ NS_EVALUATOR_RESIDENT_WINDOW: '1' }), true);
    assert.throws(() => windowMark.enabled({ NS_EVALUATOR_RESIDENT_WINDOW: 'true' }), /0 or 1 is required/);
  });

  it('notes the lowest window time per domain, and anything inexact as unbounded', async function () {
    const noted = async fn => windowMark.values((await windowMark.collect(fn)).window);
    assert.deepEqual(await noted(async () => {}), [true, false, null, null, null], 'a transaction that notes nothing is unbounded');
    assert.deepEqual(await noted(async () => { windowMark.touch(); }), [false, false, null, null, null], 'a statement that changed no row');
    assert.deepEqual(await noted(async () => {
      windowMark.note('entries', '1700000300000'); windowMark.note('entries', '1700000000000'); windowMark.note('entries', '1700000600000');
      windowMark.note('treatments', '2026-01-02T00:00:00.000Z'); windowMark.note('treatments', '2026-01-01T00:00:00.000Z');
      windowMark.note('devicestatus', '2026-01-03T00:00:00.000Z'); windowMark.note('food', null); windowMark.note('activity', null);
    }), [false, false, '1700000000000', '2026-01-03T00:00:00.000Z', '2026-01-01T00:00:00.000Z']);
    assert.deepEqual(await noted(async () => { windowMark.note('profile', null); windowMark.note('entries', '-5'); }), [false, true, '-5', null, null]);
    for (const [domain, value] of [['entries', null], ['entries', '1.5'], ['entries', 17], ['treatments', undefined], ['settings', 'x'], ['unknown', '1']]) {
      assert.deepEqual(await noted(async () => { windowMark.note('entries', '5'); windowMark.note(domain, value); }), [true, false, null, null, null], domain + ' ' + value);
    }
    assert.deepEqual(await noted(async () => { windowMark.note('entries', '5'); windowMark.unbounded(); }), [true, false, null, null, null]);
    // Text marks compare as PostgreSQL's "C" collation does (code points), not as UTF-16.
    assert.ok(windowMark.compareC('～', '😀') < 0);
    // Outside a collection nothing is recorded and nothing throws.
    windowMark.note('entries', '1'); windowMark.unbounded(); windowMark.touch();
    // Concurrent transactions keep separate notes.
    const [x, y] = await Promise.all([noted(async () => { await null; windowMark.note('entries', '10'); }), noted(async () => { await null; windowMark.note('entries', '20'); })]);
    assert.deepEqual([x[2], y[2]], ['10', '20']);
  });

  it('marks with the unchanged statement when the switch is off, and with the window columns when it is on', async function () {
    const writerDriven = require('../lib/writer-driven');
    const selected = { table: '"work"."tenant_consumer_checkpoint"', consumer: 'evaluator-x-completed' };
    const calls = [], query = async (text, values) => { calls.push({ text, values }); return { rowCount: 1 }; };
    const previous = process.env[windowMark.SWITCH];
    try {
      delete process.env[windowMark.SWITCH];
      await writerDriven.mark(query, selected, A, { floor: 7, at: 1000, window: { touched: true, full: false, profile: false, entries: '5', devicestatus: null, treatments: null } });
      process.env[windowMark.SWITCH] = '1';
      await writerDriven.mark(query, selected, A, { floor: 7, at: 1000, window: { touched: true, full: false, profile: false, entries: '5', devicestatus: null, treatments: null } });
      await writerDriven.mark(query, selected, A, { floor: 7, at: 1000 });
      await writerDriven.mark(query, selected, A, { source: 'settings', at: 1000, window: { touched: true, full: false, profile: false, entries: '5', devicestatus: null, treatments: null } });
    } finally { if (previous === undefined) delete process.env[windowMark.SWITCH]; else process.env[windowMark.SWITCH] = previous; }
    assert.equal(calls[0].text, 'UPDATE "work"."tenant_consumer_checkpoint" SET /* writer-pending-mark */ work_observed[1]=GREATEST(COALESCE(work_observed[1],0)+1,$3::bigint),' +
      'work_observed_at[1]=$4::bigint,work_pending_at=COALESCE(work_pending_at,$4::bigint) WHERE tenant_id=$1 AND consumer=$2 AND work_version=2');
    assert.deepEqual(calls[0].values, [A, 'evaluator-x-completed', 7, 1000]);
    assert.ok(calls[1].text.startsWith(calls[0].text.split(' WHERE ')[0] + ',window_mark_version=') && calls[1].text.endsWith(' WHERE tenant_id=$1 AND consumer=$2 AND work_version=2'));
    for (const column of windowMark.COLUMNS) assert.ok(calls[1].text.includes(',' + column + '='), column);
    assert.deepEqual(calls[1].values, [A, 'evaluator-x-completed', 7, 1000, false, false, '5', null, null]);
    assert.deepEqual(calls[2].values.slice(4), [true, false, null, null, null], 'a mark without notes is unbounded');
    assert.deepEqual(calls[3].values.slice(4), [true, false, null, null, null], 'a mark of another source is unbounded');
    assert.deepEqual(writerDriven.MARK_COLUMNS.update, ['work_observed', 'work_observed_at', 'work_pending_at', ...windowMark.COLUMNS]);
  });
});

describe('resident window plan and merge', function () {
  const policy = at => windowPolicy.create({ extendedSettings: {} }, at);
  const T = Date.UTC(2026, 10, 21, 6, 0);
  const none = [null, null, null, null, null, null];
  const row = (domain, id, time, extra = {}) => { const doc = { _id: id, ...(domain === 'entries' ? { type: 'sgv', sgv: 100, date: time } : { created_at: iso(time) }), ...extra };
    return { domain, id_kind: 'string', doc, ordinal: null, wt: memory.windowTime(domain, doc), bytes: Buffer.byteLength(JSON.stringify(doc)) }; };
  const mark = (observed, completed, extra = {}) => ({ observed, completed, version: String(observed.reduce((t, v) => t + BigInt(v ?? 0), 0n)),
    full: false, profile: false, entries: null, devicestatus: null, treatments: null, ...extra });
  const resident = (rows, seen = ['5', null, null, null, null, '1'], at = T) => residentWindow.build({ rows, tenant: A, generation: '3', policy: policy(at),
    mark: mark(seen, seen), membership: windowPolicy.membership(policy(at)), checkAt: at + HOUR });
  const planned = (r, m, extra = {}) => residentWindow.plan({ resident: r, tenant: A, generation: '3', policy: policy(T + MIN), mark: m,
    membership: windowPolicy.membership(policy(T + MIN)), ...extra });

  it('refuses a resident it cannot prove current, each for its own reason', function () {
    const r = resident([row('entries', 'e1', T - HOUR)]);
    const seen = ['5', null, null, null, null, '1'], next = ['6', null, null, null, null, '1'];
    const reason = (m, extra) => { const p = planned(extra && 'resident' in extra ? extra.resident : r, m, extra); assert.equal(p.full, true); return p.reason; };
    assert.equal(reason(mark(next, seen), { resident: null }), 'no-resident');
    assert.equal(reason(mark(next, seen), { tenant: B }), 'tenant');
    assert.equal(reason(mark(next, seen), { generation: '4' }), 'generation');
    assert.equal(reason(mark(next, seen), { policy: policy(T - MIN) }), 'policy', 'an instant before the resident\'s');
    assert.equal(reason(mark(next, seen), { policy: { ...policy(T + MIN), devicestatusMs: 172800000 } }), 'policy');
    assert.equal(reason(mark(next, seen), { membership: null }), 'policy-not-bounded');
    assert.equal(reason(null), 'no-work-row');
    assert.equal(reason(mark(next, seen, { version: null })), 'marks-not-current');
    assert.equal(reason(mark(next, seen, { version: '6' })), 'marks-not-current', 'a mark that did not maintain the version');
    assert.equal(reason(mark(['4', null, null, null, null, '1'], none)), 'work-row-replaced');
    assert.equal(reason(mark(['7', null, null, null, null, '1'], ['6', null, null, null, null, '1'])), 'completed-beyond-resident');
    assert.equal(reason(mark(['6', null, '1', null, null, '1'], ['5', null, '1', null, null, '1'])), 'completed-beyond-resident', 'a source the resident never read');
    assert.equal(reason(mark(next, seen, { full: true })), 'unbounded-change');
    assert.equal(reason(mark(next, seen, { entries: '1.5' })), 'mark-invalid');
    // Everything observed is completed and the resident read all of it: nothing to read, whatever the marks say.
    assert.deepEqual(planned(r, mark(seen, seen, { full: true, entries: '1' })), { full: false, from: {}, profile: false, consumed: true });
    assert.deepEqual(planned(r, mark(next, seen, { entries: String(T), profile: true })), { full: false, from: { entries: String(T) }, profile: true, consumed: false });
    assert.deepEqual(planned(r, mark(next, seen)), { full: false, from: {}, profile: false, consumed: false }, 'pending with no window change');
  });

  it('replaces the marked tail, keeps the rest, and drops what left the window by time', function () {
    const rows = [row('devicestatus', 'd1', T - 2 * HOUR), row('devicestatus', 'd2', T - 23 * HOUR - 59 * MIN - 30000),
      row('entries', 'e1', T - 2 * DAY + 30000), row('entries', 'e2', T - HOUR), row('entries', 'e3', T - 5 * MIN),
      row('profile', 'p1', T - 30 * DAY, { startDate: iso(T - 30 * DAY) }),
      row('treatments', 't-old-note', T - 59 * HOUR - 59 * MIN - 30000, { eventType: 'Note' }), row('treatments', 't-old-site', T - 20 * DAY, { eventType: 'Site Change' }),
      row('treatments', 't1', T - HOUR, { eventType: 'Temp Basal', duration: 30 })];
    const r = resident(rows);
    assert.deepEqual(r.rows.map(x => x.id), ['d1', 'd2', 'e1', 'e2', 'e3', 'p1', 't-old-note', 't-old-site', 't1']);
    const seen = ['5', null, null, null, null, '1'], next = ['6', null, null, null, null, '1'], at = T + MIN, p = policy(at), membership = windowPolicy.membership(p);
    const m = mark(next, seen, { entries: String(T - HOUR) });
    const selected = residentWindow.plan({ resident: r, tenant: A, generation: '3', policy: p, mark: m, membership });
    // e2 was edited, e3 deleted, e4 added; e1, d2 and the old note left their windows by time; the old site change stays (an event look-back).
    const out = residentWindow.apply({ resident: r, plan: selected, delta: [row('entries', 'e2', T - HOUR, { sgv: 55 }), row('entries', 'e4', T)], generation: '3', policy: p, mark: m, membership });
    assert.deepEqual(out.rows.map(x => x.id), ['d1', 'e2', 'e4', 'p1', 't-old-site', 't1']);
    assert.equal(out.rows.find(x => x.id === 'e2').doc.sgv, 55);
    assert.deepEqual(out.seen, next); assert.equal(out.tenant, A); assert.equal(out.checkAt, r.checkAt);
    // What does not fit is refused, never guessed.
    const refuse = delta => assert.equal(residentWindow.apply({ resident: r, plan: selected, delta, generation: '3', policy: p, mark: m, membership }), null);
    refuse([row('entries', 'e0', T - 2 * HOUR)]); // below its domain's mark
    refuse([row('treatments', 't9', T)]); // a domain that was not marked
    refuse([row('profile', 'p2', T, { startDate: iso(T) })]); // the profile was not marked
    refuse([row('entries', 'e1', T)]); // an identity on both sides of the mark
    assert.equal(residentWindow.compare(out.rows, [row('devicestatus', 'd1', T - 2 * HOUR), row('entries', 'e2', T - HOUR, { sgv: 55 }), row('entries', 'e4', T),
      row('profile', 'p1', T - 30 * DAY, { startDate: iso(T - 30 * DAY) }), row('treatments', 't-old-site', T - 20 * DAY, { eventType: 'Site Change' }),
      row('treatments', 't1', T - HOUR, { eventType: 'Temp Basal', duration: 30 })]), 0);
    assert.equal(residentWindow.compare(out.rows, [row('devicestatus', 'd1', T - 2 * HOUR), row('entries', 'e2', T - HOUR, { sgv: 56 }), row('entries', 'e5', T)]), 6,
      'one unequal, one extra, one missing and three absent rows');
    assert.equal(residentWindow.build({ rows: [rows[2], rows[0]], tenant: A, generation: '3', policy: p, mark: m, membership, checkAt: 0 }), null, 'rows out of read order keep no resident');
  });
});

describe('resident window: what a resident row computes once', function () {
  const T = Date.UTC(2026, 10, 21, 6, 0);
  // A deterministic spread of rows: canonical and non-canonical times, arrays, invalid rows, both identity kinds.
  function rows () {
    const out = [];
    let seed = 7;
    const next = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let i = 0; i < 400; i++) {
      const domain = ['entries', 'devicestatus', 'treatments', 'profile'][next(4)], t = T - next(400 * DAY) + next(3 * DAY);
      const time = [t, iso(t), iso(t).replace('Z', '+00:00'), [t - 5, t], [iso(t - 5), iso(t)], 'not a time', null][next(7)];
      const doc = { _id: next(2) ? 'row-' + i : i.toString(16).padStart(24, '0'), note: 'caf\u00e9 \u2603 ' + i, nested: { b: [1, { c: i }], a: null },
        ...(domain === 'entries' ? { date: time } : { created_at: time }), ...(next(9) === 0 ? { isValid: false } : {}),
        ...(domain === 'treatments' ? { eventType: ['Temp Basal', 'Site Change', 'Profile Switch'][next(3)], duration: 0 } : {}) };
      out.push({ domain, id_kind: doc._id.startsWith('row-') ? 'string' : 'objectid', doc, ordinal: next(3) ? String(i + 1) : null,
        wt: memory.windowTime(domain, doc), bytes: Buffer.byteLength(JSON.stringify(doc)) });
    }
    return out;
  }
  const policyAt = at => windowPolicy.create({ extendedSettings: {} }, at);
  const prepare = list => { const m = { observed: ['1', null, null, null, null, null], completed: ['1', null, null, null, null, null], version: '1' };
    // No membership rule (every row kept), sorted as a read returns them.
    const sorted = list.map(row => ({ ...row, id: row.doc._id })).sort(residentWindow.compareRows);
    return residentWindow.build({ rows: sorted, tenant: A, generation: '1', policy: policyAt(T), mark: m, membership: {}, checkAt: 0 }).rows; };

  it('gives the policy\'s next expiry at every instant', function () {
    const list = prepare(rows());
    for (const at of [T - 500 * DAY, T - 372 * DAY, T - 62 * DAY, T - 60 * HOUR, T - 2 * DAY, T - DAY, T - 1, T, T + 1, T + DAY, T + 400 * DAY]) {
      for (const devicestatusMs of [86400000, 172800000]) {
        const policy = { ...policyAt(at), devicestatusMs }, visible = list.filter(row => row.doc.isValid !== false);
        for (const row of list) row.exp = null; // the cache belongs to one device-status window
        assert.equal(residentWindow.nextExpiry(list, policy), windowPolicy.nextExpiry(visible, policy), 'at ' + iso(at) + ' with ' + devicestatusMs);
        assert.equal(residentWindow.nextExpiry(list, policy), windowPolicy.nextExpiry(visible, policy), 'from the cached instants');
      }
    }
  });

  it('gives the exact byte length of the rows in the evaluator\'s input text', function () {
    const ordinalOf = value => value === null ? null : Number(value);
    for (const list of [prepare(rows()), prepare(rows().slice(0, 1)), prepare([])]) {
      const visible = list.filter(row => row.doc.isValid !== false);
      const { encodeDocument, decodeDocument } = require('../lib/storage/postgres-identity');
      // As the evaluator builds its input rows from a window's rows.
      const input = visible.map(row => ({ domain: row.domain, ...encodeDocument(decodeDocument(row)), ordinal: ordinalOf(row.ordinal) }));
      assert.equal(residentWindow.textBytes(list, ordinalOf), Buffer.byteLength(JSON.stringify(input)));
      assert.equal(residentWindow.textBytes(list, ordinalOf), Buffer.byteLength(JSON.stringify(input)), 'from the cached lengths');
    }
  });

  it('takes the evaluator\'s prepared copy of each document, and only an equal frozen one', function () {
    const list = prepare(rows().filter(row => row.domain === 'entries').slice(0, 20));
    const resident = { rows: list };
    const { deepFreeze } = require('../lib/data/json-copy');
    const copies = list.slice(0, 19).map(row => ({ id_kind: row.id_kind, doc: deepFreeze(JSON.parse(JSON.stringify(row.doc))) }));
    const before = list.map(row => row.doc);
    residentWindow.share(resident, { entries: copies });
    list.slice(0, 19).forEach((row, i) => { assert.equal(row.doc, copies[i].doc); assert.notEqual(row.doc, before[i]); assert.deepEqual(row.doc, before[i]); assert.equal(row.shared, true); });
    assert.equal(list[19].doc, before[19], 'a row without a prepared copy keeps its own');
    residentWindow.share(resident, { entries: [{ id_kind: list[19].id_kind, doc: JSON.parse(JSON.stringify(list[19].doc)) }] });
    assert.equal(list[19].doc, before[19], 'a copy that is not frozen is not taken');
    residentWindow.share(null, {});
  });
});

describe('resident window: the level component through a resident equals the full read', function () {
  this.timeout(120000);
  const THRESHOLDS = { bgHigh: 200, bgTargetTop: 180, bgTargetBottom: 80, bgLow: 55 };
  const ENABLE = ['bgnow', 'delta', 'direction', 'rawbg', 'iob', 'cob', 'profile', 'basal', 'pump', 'openaps', 'loop', 'timeago', 'simplealarms', 'devicestatus', 'careportal', 'bwp', 'ar2', 'sage', 'cage', 'iage', 'bage', 'upbat'];
  const env = (thresholds = THRESHOLDS) => environment({ settings: { enable: ENABLE, thresholds } });
  let previous;
  beforeEach(() => { previous = scope.getTenancyMode(); scope.setTenancyMode('multi'); clock.install(); });
  afterEach(() => { clock.uninstall(); scope.setTenancyMode(previous); });

  // Two arms over identical stores: a resident reader and a full reader.
  function arms (tenant, tag, now, { checkMs = 86400000, shared } = {}) {
    const evaluator = require('../lib/data/tenant-projection-evaluator');
    const make = resident => {
      const db = memory({ tenant, generation: '1', resident, checkMs });
      const component = () => evaluator({ tenant, replay: db.replay, env: env(), language: require('../lib/language')(), includeFrame: true,
        connection: { async query () { throw new Error('No SQL: the views read in process'); } }, dbstats: async () => ({}), maxRows: 10000, maxBytes: 8388608 });
      return { db, component: component(), remake () { this.component.close(); this.component = component(); } };
    };
    const pair = { tenant, resident: shared?.resident || make(true), full: shared?.full || make(false) };
    const fx = SCENARIOS.steady(now);
    const seed = [];
    for (const domain of ['entries', 'treatments', 'devicestatus', 'profile']) for (const [i, doc] of fx[domain].entries()) seed.push({ domain, id_kind: 'string', doc: { ...JSON.parse(JSON.stringify(doc)), _id: tag + '-' + domain + '-' + i } });
    pair.write = (changes, options) => { for (const arm of [pair.resident, pair.full]) arm.db.write(changes, options); };
    pair.write(seed, { exact: false, at: now });
    pair.fx = fx;
    return pair;
  }
  async function cycle (pair, at, { time = false, complete = true, label } = {}) {
    clock.pin(at);
    const before = { ...pair.resident.db.counters, reasons: { ...pair.resident.db.counters.reasons } }, out = [];
    for (const arm of [pair.resident, pair.full]) {
      const observed = arm.db.begin();
      out.push(await scope.withTenant(pair.tenant, () => time ? arm.component.evaluateTime({ at }) : arm.component.evaluate({ at })));
      if (complete) arm.db.complete(observed);
    }
    assert.equal(JSON.stringify(out[0]), JSON.stringify(out[1]), label + ': the resident cycle result is the full read\'s, byte for byte');
    const after = pair.resident.db.counters;
    const reasons = Object.keys(after.reasons).filter(key => after.reasons[key] !== (before.reasons[key] || 0));
    return { result: out[0], mode: ['full', 'tail', 'unchanged'].find(key => after[key] > before[key]) || 'no-read', read: after.rowsRead - before.rowsRead, reasons, differences: after.differences - before.differences };
  }
  const sgv = (id, value, date) => ({ domain: 'entries', id_kind: 'string', doc: { _id: id, type: 'sgv', sgv: value, date, dateString: iso(date), direction: 'Flat', device: 'synthetic' } });
  const close = (...pairs) => { for (const pair of pairs) for (const arm of [pair.resident, pair.full]) arm.component.close(); };
  const expect = (step, mode, read, label) => { assert.equal(step.mode, mode, label); if (read !== undefined) assert.equal(step.read, read, label + ': rows read'); };

  it('ordinary, late, edge, edited, deleted and expired rows; profile; eviction; restart; restore; self-check', async function () {
    const now = Math.floor(clock.RealDate.now() / MIN) * MIN;
    const a = arms(A, 'a', now);
    try {
      let at = now;
      const step = async (label, options) => cycle(a, at += MIN, { label, ...options });
      let s = await step('first'); expect(s, 'full'); assert.deepEqual(s.reasons, ['no-resident']);
      a.write([sgv('a-new', 123, at)], { at });
      s = await step('ordinary upload'); expect(s, 'tail', 1, 'ordinary upload'); assert.equal(s.result.properties.bgnow.mean, 123);
      s = await step('idle'); expect(s, 'unchanged', 0, 'idle');
      a.write([sgv('a-late', 250, now - 30 * HOUR)], { at });
      s = await step('backdated'); expect(s, 'tail', undefined, 'backdated'); assert.ok(s.read > 1);
      a.write([sgv('a-edge-in', 77, at + MIN - 2 * DAY)], { at }); a.write([sgv('a-edge-out', 78, at + MIN - 2 * DAY - 1)], { at });
      s = await step('window edge'); expect(s, 'tail', undefined, 'window edge');
      a.write([sgv('a-late-2', 240, now - 20 * HOUR)], { at }); a.write([sgv('a-new-2', 131, at)], { at });
      s = await step('late then new'); expect(s, 'tail', undefined, 'late then new');
      a.write([sgv('a-new-2', 45, at - MIN)], { at }); // same id, edited
      s = await step('same-id edit'); expect(s, 'tail', undefined, 'same-id edit'); assert.equal(s.result.properties.bgnow.mean, 45);
      a.write([{ domain: 'entries', id_kind: 'string', _id: 'a-new-2', remove: true }], { at });
      s = await step('newest deleted'); expect(s, 'tail', undefined, 'newest deleted'); assert.equal(s.result.properties.bgnow.mean, 123);
      a.write([{ domain: 'entries', id_kind: 'string', _id: 'a-late', remove: true }], { at });
      s = await step('old deleted'); expect(s, 'tail', undefined, 'old deleted');
      a.write([{ domain: 'treatments', id_kind: 'string', doc: { _id: 'a-site', eventType: 'Site Change', created_at: iso(at - HOUR) } }], { at });
      s = await step('newest event'); expect(s, 'tail', undefined, 'newest event');
      a.write([{ domain: 'treatments', id_kind: 'string', _id: 'a-site', remove: true }], { at });
      s = await step('newest event deleted'); expect(s, 'tail', undefined, 'newest event deleted');
      a.write([{ domain: 'profile', id_kind: 'string', doc: { ...JSON.parse(JSON.stringify(a.fx.profile[0])), _id: 'a-profile-2', startDate: iso(at), mills: at } }], { at });
      s = await step('profile'); expect(s, 'tail', 1, 'profile');
      a.write([{ domain: 'food', id_kind: 'string', doc: { _id: 'a-food', name: 'synthetic' } }], { at });
      s = await step('food'); expect(s, 'unchanged', 0, 'food');
      a.write([sgv('a-raw', 144, at)], { at, exact: false });
      s = await step('unnoted write'); expect(s, 'full'); assert.deepEqual(s.reasons, ['unbounded-change']);
      a.write([sgv('a-off', 155, at)], { at, aware: false });
      s = await step('writer without the switch'); expect(s, 'full'); assert.deepEqual(s.reasons, ['marks-not-current']);
      // A write committed while a cycle runs (not completed with it) keeps its mark.
      a.write([sgv('a-w1', 111, at)], { at });
      s = await step('cycle that does not complete', { complete: false }); expect(s, 'tail', 1, 'not completed');
      a.write([sgv('a-w2', 222, now - 12 * HOUR)], { at });
      s = await step('the write in flight'); expect(s, 'tail', undefined, 'in flight'); assert.ok(s.read > 1);
      // Time alone: hours later readings and statuses have left; nothing is read.
      at += 3 * HOUR;
      s = await step('time-only expiry', { time: true }); expect(s, 'unchanged', 0, 'time-only expiry');
      for (const arm of [a.resident, a.full]) await scope.withTenant(A, async () => arm.component.evict());
      s = await step('after eviction'); expect(s, 'full'); assert.deepEqual(s.reasons, ['no-resident']);
      for (const arm of [a.resident, a.full]) await scope.withTenant(A, async () => arm.component.reconfigure({ env: env({ ...THRESHOLDS, bgHigh: 220 }) }));
      s = await step('after a settings change'); expect(s, 'full'); assert.deepEqual(s.reasons, ['no-resident']);
      for (const arm of [a.resident, a.full]) arm.remake();
      s = await step('after restart'); expect(s, 'full'); assert.deepEqual(s.reasons, ['no-resident']);
      // A restore: the generation moves and the data is replaced without a window mark.
      for (const arm of [a.resident, a.full]) { arm.db.state.generation = '2'; arm.db.write([{ domain: 'entries', id_kind: 'string', _id: 'a-new', remove: true }], { at, aware: false }); arm.db.work.version = String(BigInt(arm.db.work.version || 0) + 1n); }
      s = await step('after a restore'); expect(s, 'full'); assert.deepEqual(s.reasons, ['generation']);
    } finally { close(a); }
  });

  it('checks itself against a full read: nothing on ordinary changes, a repair on an unmarked one', async function () {
    const now = Math.floor(clock.RealDate.now() / MIN) * MIN;
    const a = arms(A, 'a', now, { checkMs: 0 });
    try {
      await cycle(a, now, { label: 'first' });
      a.write([sgv('a-1', 120, now)], { at: now });
      let s = await cycle(a, now + MIN, { label: 'checked upload' });
      assert.equal(s.mode, 'tail'); assert.equal(s.differences, 0); assert.equal(a.resident.db.counters.checks, 1);
      // An unsupported writer: a row changes with no mark at all.
      for (const arm of [a.resident, a.full]) { const before = [...arm.db.work.observed], marks = { ...arm.db.work };
        arm.db.write([sgv('a-1', 55, now)], { at: now }); Object.assign(arm.db.work, marks, { observed: before }); }
      s = await cycle(a, now + 2 * MIN, { label: 'unmarked change' });
      assert.equal(s.mode, 'full'); assert.equal(s.differences, 1); assert.deepEqual(s.reasons, ['self-check']);
      assert.ok(s.result.frame.sgvs.some(row => row.mgdl === 55), 'the repaired window holds the changed reading');
    } finally { close(a); }
  });

  it('refuses and admits at the byte bound exactly as the full read does, and holds each document once', async function () {
    const now = Math.floor(clock.RealDate.now() / MIN) * MIN;
    const evaluator = require('../lib/data/tenant-projection-evaluator'), { encodeDocument } = require('../lib/storage/postgres-identity');
    const a = arms(A, 'a', now);
    try {
      await cycle(a, now, { label: 'first' });
      a.write([sgv('a-new', 123, now)], { at: now });
      await cycle(a, now + MIN, { label: 'tail' });
      // The whole input's text, as the full read's component measures it (no statistics: the plugin set has no dbsize).
      const at = now + 2 * MIN, policy = windowPolicy.create(env(), at);
      clock.pin(at);
      const recovered = await a.full.db.replay.window({ policy });
      const size = Buffer.byteLength(JSON.stringify({ checkpoint: recovered.checkpoint, progress: recovered.progress,
        rows: recovered.rows.map(row => ({ domain: row.domain, ...encodeDocument(row.document), ordinal: row.ordinal })),
        stats: {}, signature: recovered.signature, expiresAt: recovered.expiresAt, generation: recovered.generation }));
      const resident = (await a.resident.db.replay.window({ policy })).resident;
      for (const [maxBytes, admitted] of [[size - 1, false], [size, true]]) {
        const outcomes = [];
        for (const arm of [a.resident, a.full]) {
          // A tail read at the bound: the resident arm's replay answers from the resident just read.
          const replay = arm === a.resident ? { ...arm.db.replay, window: options => arm.db.replay.window({ ...options, resident }) } : arm.db.replay;
          const c = evaluator({ tenant: A, replay, env: env(), language: require('../lib/language')(), includeFrame: true,
            connection: { async query () { throw new Error('No SQL'); } }, dbstats: async () => ({}), maxRows: 10000, maxBytes });
          try { outcomes.push(await scope.withTenant(A, () => c.evaluate({ at })).then(() => 'admitted', error => /byte bound/.test(error.message) ? 'refused' : error.message)); } finally { c.close(); }
        }
        assert.deepEqual(outcomes, admitted ? ['admitted', 'admitted'] : ['refused', 'refused'], 'bound ' + maxBytes + ' of ' + size);
      }
      // After a completed cycle every resident document is the evaluator's prepared copy.
      const held = (await a.resident.db.replay.window({ policy, resident })).resident;
      assert.equal(held.rows.filter(row => !row.shared).length, 0, 'the rows carried from the cycles above are shared');
    } finally { close(a); }
  });

  it('keeps two tenants of one slice apart', async function () {
    const now = Math.floor(clock.RealDate.now() / MIN) * MIN;
    const a = arms(A, 'a', now), b = arms(B, 'b', now);
    try {
      await cycle(a, now, { label: 'a first' }); await cycle(b, now, { label: 'b first' });
      a.write([sgv('a-only', 201, now)], { at: now });
      let s = await cycle(b, now + MIN, { label: 'b after a wrote' });
      assert.equal(s.mode, 'unchanged'); assert.ok(s.result.frame.sgvs.every(row => row.mgdl !== 201));
      s = await cycle(a, now + MIN, { label: 'a after a wrote' });
      assert.equal(s.mode, 'tail'); assert.ok(s.result.frame.sgvs.some(row => row.mgdl === 201));
      // A resident handed to another tenant's read is not used.
      const policy = windowPolicy.create(env(), now + 2 * MIN);
      const mine = await a.resident.db.replay.window({ policy }), crossed = await b.resident.db.replay.window({ policy, resident: mine.resident });
      assert.equal(crossed.residentMode, 'full');
      assert.equal(JSON.stringify(crossed.rows), JSON.stringify((await b.full.db.replay.window({ policy })).rows));
    } finally { close(a, b); }
  });

  // Controls: the differential above must fail on each wrong build.
  const brokenModule = require('./lib/clinical-working-set/control');
  const PLAN = '  const selected = plan({ resident, tenant, generation, policy, mark, membership });';
  async function detected (replacement, run) {
    const real = require('../lib/storage/resident-window'), broken = brokenModule('../lib/storage/resident-window', PLAN, replacement), saved = real.read;
    real.read = broken.read; // the in-process reader calls through the module object
    try { await assert.rejects(run, error => error instanceof assert.AssertionError && /byte for byte/.test(error.message)); } finally { real.read = saved; }
  }
  it('control: an ignored affected time is detected', async function () {
    const now = Math.floor(clock.RealDate.now() / MIN) * MIN, a = arms(A, 'a', now);
    try {
      await cycle(a, now, { label: 'first' });
      a.write([sgv('a-new', 123, now)], { at: now });
      await detected(PLAN.replace('const selected =', 'const planned =') + '\n  const selected = planned.full ? planned : { ...planned, from: {}, profile: false };',
        () => cycle(a, now + MIN, { label: 'ordinary upload' }));
    } finally { close(a); }
  });
  it('control: a generation change that does not invalidate is detected', async function () {
    const now = Math.floor(clock.RealDate.now() / MIN) * MIN, a = arms(A, 'a', now);
    try {
      await cycle(a, now, { label: 'first' });
      for (const arm of [a.resident, a.full]) { const before = [...arm.db.work.observed], marks = { ...arm.db.work };
        arm.db.state.generation = '2'; arm.db.write([{ domain: 'entries', id_kind: 'string', _id: 'a-entries-0', remove: true }], { at: now }); Object.assign(arm.db.work, marks, { observed: before }); }
      await detected(PLAN.replace('tenant, generation,', 'tenant, generation: resident ? resident.generation : generation,'), () => cycle(a, now + MIN, { label: 'after a restore' }));
    } finally { close(a); }
  });
});
