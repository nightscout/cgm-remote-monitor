'use strict';
const assert = require('node:assert/strict');
const policy = require('../lib/storage/clinical-working-set-policy');
const state = require('../lib/storage/clinical-stream-state');
const native = require('./lib/clinical-stream-native');
const at = Date.UTC(2026, 10, 16, 12), DAY = 86400000;
const limits = { maxRows: 30, maxBytes: 200000 };
const env = { extendedSettings: {} };
const row = (domain, id, doc) => ({ domain, id_kind: 'string', doc: { _id: id, ...doc }, ordinal: 1, storageBytes: 100 });
const iso = n => new Date(n).toISOString();
const boot = rows => state.bootstrap(null, { checkpoint: 10, signature: { stamp: 10, deleted: 0 },
  stream: native.boundary, policy: policy.create(env, at), rows: rows.map(r => ({ domain: r.domain, document: r.doc, ordinal: r.ordinal, storageBytes: r.storageBytes })) }, limits);
const apply = (saved, events, module=state, evaluatedAt) => module.applyTransaction(saved, events,
  native.coverage('0/'+(Number.parseInt(saved.stream.accepted_position?.split('/')[1]||'10',16)+16).toString(16)),limits,evaluatedAt);
const update = (saved, domain, id, doc, action = 'U') => apply(saved,[{ xid: 42, lsn: '0/20', action, domain, id_kind: 'string', id,
  prior: { domain, id_kind: 'string', id }, row: action === 'D' ? null : row(domain, id, doc) }]);
const brokenModule = require('./lib/clinical-working-set/control');
describe('clinically sufficient derived windows', () => {
  it('keeps native date/array comparisons, future rows, age events and permanent switches without a universal TTL', () => {
    const rows = [row('entries', 'recent', { date: at }), row('entries', 'future', { date: at + DAY }), row('entries', 'old', { date: at - 3 * DAY }),
      row('entries', 'array', { date: [at - 3 * DAY, at] }), row('entries', 'invalid', { date: at, isValid: false }),
      row('treatments', 'ongoing', { created_at: iso(at - 3 * DAY), duration: 100000 }),
      row('treatments', 'age', { created_at: iso(at - 61 * DAY), eventType: 'Sensor Change' }),
      row('treatments', 'switch', { created_at: iso(at - 371 * DAY), eventType: 'Profile Switch', duration: 0 }),
      row('devicestatus', 'lexical', { created_at: 'z' }), row('food', 'food', {}), row('activity', 'activity', {})];
    assert.deepEqual(policy.select(rows, policy.create(env, at)).map(r => r.doc._id).sort(), ['age', 'array', 'future', 'lexical', 'recent', 'switch']);
  });
  it('lets a large old source population become a bounded clinical set and keeps storage statistics outside it', () => {
    const rows = Array.from({ length: 2000 }, (_, i) => row('entries', 'old-' + i, { date: at - 500 * DAY }));
    rows.push(row('entries', 'new', { date: at, sgv: 123 }));
    const saved = boot(rows), output = state.output(saved);
    assert.equal(saved.rows.length, 1);assert.equal(output.stats, undefined, 'WHOLE_HISTORY_STATS_MUST_NOT_BE_WINDOW_SUM');
    assert.equal(rows.length, 2001, 'CACHE_EVICTION_PRESERVES_SOURCE');
  });
  it('accepts late corrections across the boundary, omitted unchanged documents and old identity-only deletes', () => {
    const original = boot([row('entries', 'old', { date: at - 3 * DAY })]);
    const corrected = update(original, 'entries', 'old', { date: at, sgv: 135, extension: { kept: true } });
    assert.equal(state.output(corrected).rows[0].document.sgv, 135);
    const deleted = update(original, 'entries', 'old', {}, 'D');assert.equal(deleted.rows.length, 0);
    const omitted = { xid: 43, lsn: '0/40', action: 'U', domain: 'entries', id_kind: 'string', id: 'outside', row: { domain: 'entries', id_kind: 'string', id: 'outside', storageBytes: 80 } };
    const next = apply(corrected,[omitted]);
    assert.deepEqual(next.rows, corrected.rows);
    assert.equal(state.output(update(corrected, 'entries', 'old', { date: at - 3 * DAY })).rows.length, 0);
  });
  it('keeps the native profile winner with typed ordering and requires historical fallback when it can change', () => {
    const original = boot([row('profile', 'old', { startDate: '2020' }), row('profile', 'new', { startDate: '2026' })]);
    assert.equal(original.rows[0].doc._id, 'new');
    for (const next of [update(original, 'profile', 'new', {}, 'D'), update(original, 'profile', 'new', { startDate: '2019' })]) {
      assert.equal(next.gap, 'history');assert.throws(() => state.output(next), /BOOTSTRAP_REQUIRED/);
    }
    assert.equal(update(original, 'profile', 'old', { startDate: '2027' }).rows[0].doc._id, 'old');
    assert.equal(update(original, 'profile', 'new', { startDate: '2026', units: 'mmol' }).rows[0].doc.units, 'mmol');
  });
  it('expires without a write, preserves the coverage floor, restores through JSON loss, and refuses settings expansion or clock rewind', () => {
    const original = boot([row('entries', 'edge', { date: at - 2 * DAY })]);
    assert.equal(state.output(original).expiresAt, at + 1);
    const recovered = JSON.parse(JSON.stringify(original));
    const next = state.expire(recovered, policy.create(env, at + 1), limits);
    assert.equal(next.rows.length, 0);assert.equal(next.floor, 10);assert.notEqual(state.output(next).progress, state.output(original).progress);
    assert.throws(() => state.expire(next, policy.create({ extendedSettings: { devicestatus: { days: 2 } } }, at + 2), limits), /BOOTSTRAP_REQUIRED/);
    assert.throws(() => state.expire(next, policy.create(env, at), limits), /BOOTSTRAP_REQUIRED/);
  });
  it('controls detect loss of required old input and accidental source mutation during expiry', () => {
    const needed = row('treatments', 'switch', { created_at: iso(at - 100 * DAY), eventType: 'Profile Switch', duration: 0 });
    const criterion = module => assert.equal(module.select([needed], policy.create(env, at)).length, 1, 'REQUIRED_OLD_PROFILE_SWITCH_LOST');
    criterion(policy);
    const broken = brokenModule('../lib/storage/clinical-working-set-policy', 'loader.profileSwitchQuery(at).find,', '');
    assert.throws(() => criterion(broken), /REQUIRED_OLD_PROFILE_SWITCH_LOST/);criterion(policy);
    const before = boot([row('entries', 'edge', { date: at - 2 * DAY })]);
    const expiry = module => { const saved = structuredClone(before);module.expire(saved, policy.create(env, at + 1), limits);assert.deepEqual(saved, before, 'EXPIRY_MUTATED_ITS_SOURCE'); };
    expiry(state);
    const mutating = brokenModule('../lib/storage/clinical-stream-state', 'const state={...saved,policy,rows:windowPolicy.select(saved.rows,policy)};', 'const state=Object.assign(saved,{policy,rows:windowPolicy.select(saved.rows,policy)});');
    assert.throws(() => expiry(mutating), /EXPIRY_MUTATED_ITS_SOURCE/);expiry(state);
  });
  it('distinguishes successive transient expiries from one durable cohort without rewriting that cohort', () => {
    const original = boot([row('entries', 'first', { date: at - 2 * DAY }), row('entries', 'second', { date: at - 2 * DAY + 1000 })]);
    const criterion = module => {
      const first = module.output(module.expire(original, policy.create(env, at + 1), limits));
      const second = module.output(module.expire(original, policy.create(env, at + 1001), limits));
      assert.deepEqual(first.signature, second.signature);
      assert.notEqual(first.progress, second.progress, 'DISTINCT_EXPIRY_SUBSETS_MUST_NOT_REUSE_PREPARED_ROWS');
    };
    criterion(state);
    const broken = brokenModule('../lib/storage/clinical-stream-state', "+':'+state.rows.length:KIND", ':KIND');
    assert.throws(() => criterion(broken), /DISTINCT_EXPIRY_SUBSETS/);criterion(state);
    assert.equal(original.rows.length, 2, 'TRANSIENT_EXPIRY_PRESERVES_DURABLE_BASE');
  });
  it('prunes the growing durable set inside cohort acceptance and keeps omitted metadata documents and rewind recovery safe', () => {
    const original = boot([row('entries', 'edge', { date: at - 2 * DAY }), row('entries', 'retained', { date: at, extension: 'kept' })]);
    const event = { xid: 43, lsn: '0/40', action: 'U', domain: 'entries', id_kind: 'string', id: 'retained',
      row: { domain: 'entries', id_kind: 'string', id: 'retained', storageBytes: 120 } };
    const criterion = module => {
      const next = apply(original,[event],module,at+1);
      assert.deepEqual(next.rows.map(r => r.doc._id), ['retained'], 'RECEIPT_MUST_PRUNE_EXPIRED_DURABLE_MEMBERS');
      assert.equal(next.rows[0].doc.extension, 'kept');assert.equal(next.rows[0].storageBytes, 120);
      assert.equal(next.policy.at, at + 1);
      assert.throws(() => module.expire(next, policy.create(env, at), limits), /BOOTSTRAP_REQUIRED/);
      return next;
    };
    criterion(state);
    const broken = brokenModule('../lib/storage/clinical-stream-state', 'if(state.policy&&evaluatedAt>state.policy.at){', 'if(false){');
    assert.throws(() => criterion(broken), /RECEIPT_MUST_PRUNE/);criterion(state);
    assert.equal(apply(original,[event]).policy.at, at, 'OLDER_COMMIT_CLOCK_MUST_NOT_REWIND_POLICY');
    assert.equal(original.rows.length, 2, 'RECEIPT_MUST_NOT_MUTATE_PRIOR_COHORT');
  });
  it('keeps native progress separate from clinical time even for a far-future WAL position', () => {
    const original=boot([row('entries','edge',{date:at-2*DAY})]);
    const criterion=module=>{
      const next=module.applyTransaction(original,[],native.coverage('FFFFFFFF/FFFFFFFF'),limits,at);
      assert.equal(next.floor,11,'LOCAL_OBLIGATION_ADVANCES');assert.equal(next.policy.at,at,'NATIVE_POSITION_MUST_NOT_ADVANCE_CLINICAL_TIME');assert.equal(next.rows.length,1);
    };
    criterion(state);
    // Deliberately pass a later clinical instant to show that the oracle notices
    // losing the original required row; native coverage itself remains opaque.
    assert.throws(()=>criterion({...state,applyTransaction:(saved,events,coverage,bounds)=>state.applyTransaction(saved,events,coverage,bounds,at+DAY)}),/NATIVE_POSITION_MUST_NOT_ADVANCE/);
    criterion(state);
  });
});
