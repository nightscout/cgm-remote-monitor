'use strict';
const assert = require('node:assert/strict');
const oracle = require('./fixtures/realtime-preview/profile-timestamps');
const t = Date.UTC(2026, 10, 7, 12), clone = value => structuredClone(value);
function operation () {
  const base = { _id: 'synthetic-profile', NSCLIENT_ID: 'synthetic', store: { Synthetic: { created_at: 'client-nested', srvModified: t - 1000 } } };
  const mongo = { ...clone(base), created_at: new Date(t + 1).toISOString(), srvCreated: t + 1, srvModified: t + 2 };
  const pg = { ...clone(base), created_at: new Date(t + 101).toISOString(), srvCreated: t + 101, srvModified: t + 102 };
  return { producer: { collection: 'profile', data: base }, before: { mongoRaw: [], pgDocuments: [] },
    windows: { mongo: { startedAt: t, finishedAt: t + 10 }, postgres: { startedAt: t + 100, finishedAt: t + 110 } },
    expected: [[mongo]], actual: [[pg]], mongoRaw: [clone(mongo)], pgDocuments: [clone(pg)] };
}
function pgDate (value, date) { value.actual[0][0].created_at = date; value.pgDocuments[0].created_at = date; }
describe('profile operation timestamp oracle', function () {
  it('validates per-call generated clocks before allowing only their top-level difference', function () { oracle.compare(operation()); });
  for (const control of ['missing', 'invalid', 'outside-window', 'reply-store']) it('rejects generated timestamp control ' + control, function () {
    const value = operation();
    if (control === 'missing') { delete value.actual[0][0].created_at; delete value.pgDocuments[0].created_at; }
    if (control === 'invalid') pgDate(value, 'not-a-timestamp');
    if (control === 'outside-window') pgDate(value, new Date(t - 1).toISOString());
    if (control === 'reply-store') value.actual[0][0].created_at = new Date(t + 103).toISOString();
    assert.throws(() => oracle.compare(value), /PROFILE_GENERATED_CREATED_AT|PROFILE_REPLY_PHYSICAL_TIMESTAMP/);
  });
  it('preserves supplied top-level and nested timestamp fields exactly', function () {
    const value = operation(), supplied = '2001-01-01T00:00:00.000Z'; value.producer.data.created_at = supplied;
    value.expected[0][0].created_at = supplied; value.mongoRaw[0].created_at = supplied; pgDate(value, supplied); oracle.compare(value);
    pgDate(value, '2002-01-01T00:00:00.000Z'); assert.throws(() => oracle.compare(value), /PROFILE_CLIENT_CREATED_AT_PRESERVED/);
    pgDate(value, supplied); value.actual[0][0].store.Synthetic.created_at = 'wrong-nested'; value.pgDocuments[0].store.Synthetic.created_at = 'wrong-nested';
    assert.throws(() => oracle.compare(value), /PROFILE_CALLBACK_PARITY/);
  });
  it('rejects a common wrong client-supplied timestamp even if both backends agree', function () {
    const value = operation(); value.producer.data.created_at = '2001-01-01T00:00:00.000Z';
    for (const doc of [value.expected[0][0], value.actual[0][0], value.mongoRaw[0], value.pgDocuments[0]]) doc.created_at = '2002-01-01T00:00:00.000Z';
    assert.throws(() => oracle.compare(value), /PROFILE_CLIENT_CREATED_AT_PRESERVED/);
  });
  it('does not hide wrong IDs or nested server-looking payload fields', function () {
    const value = operation(); value.actual[0][0]._id = 'wrong'; value.pgDocuments[0]._id = 'wrong';
    assert.throws(() => oracle.compare(value), /PROFILE_CALLBACK_PARITY/);
    const nested = operation(); nested.actual[0][0].store.Synthetic.srvModified++; nested.pgDocuments[0].store.Synthetic.srvModified++;
    assert.throws(() => oracle.compare(nested), /PROFILE_CALLBACK_PARITY/);
  });
  it('requires server creation carry and response/physical server timestamp equality', function () {
    const value = operation(); value.before.pgDocuments = [{ ...clone(value.pgDocuments[0]), srvCreated: t - 100 }];
    assert.throws(() => oracle.compare(value), /PROFILE_SERVER_CREATION_CARRIED/);
    const mismatch = operation(); mismatch.actual[0][0].srvModified++;
    assert.throws(() => oracle.compare(mismatch), /PROFILE_REPLY_PHYSICAL_TIMESTAMP_VALUE_srvModified/);
  });
  it('requires current-operation regeneration on retry, rather than carrying old created_at', function () {
    const value = operation(); value.before.pgDocuments = [{ ...clone(value.pgDocuments[0]), created_at: new Date(t - 100).toISOString() }];
    pgDate(value, value.before.pgDocuments[0].created_at);
    assert.throws(() => oracle.compare(value), /PROFILE_GENERATED_CREATED_AT_OUTSIDE_OPERATION/);
  });
  it('wire isolation preserves immutable producer across mutation and exact retry', async function () {
    const producer = { collection: 'profile', data: { _id: 'synthetic', store: { Synthetic: {} } } }, original = clone(producer);
    const wireCall = require('./fixtures/realtime-preview/wire-call');
    for (let attempt = 0; attempt < 2; attempt++) {
      const observed = await wireCall(producer, async received => { received.data.created_at = new Date().toISOString(); return received; });
      assert.equal(observed.producerUnchanged, true, 'PROFILE_PRODUCER_IMMUTABLE wire copy is mandatory');
      assert.deepEqual(producer, original); oracle.isoInWindow(observed.result.data.created_at, observed.window);
    }
  });
  it('proves actual canonical socket prepare and default replacement regenerate retry timestamp', async function () {
    const fixture = require('./fixtures/socket-forwarding/recording-context').context();
    const source = { _id: 'synthetic-canonical', NSCLIENT_ID: 'synthetic', startDate: '2026-11-06', store: { Synthetic: { dia: 3 } } };
    fixture.collections.profile.documents.push({ ...clone(source), created_at: '2001-01-01T00:00:00.000Z', srvCreated: t - 1000 });
    const handlers = require('../lib/server/socket-write-handlers').createHandlers({ env: fixture.env, ctx: fixture.ctx,
      authorizationFor: () => ({ read: true, write: true, write_treatment: true }) });
    const request = { collection: 'profile', data: clone(source) }, startedAt = Date.now();
    const reply = await new Promise(resolve => handlers.dbAdd(request, resolve)); const finishedAt = Date.now();
    assert.equal(Object.hasOwn(source, 'created_at'), false);
    oracle.isoInWindow(reply[0].created_at, { startedAt, finishedAt });
    assert.notEqual(reply[0].created_at, '2001-01-01T00:00:00.000Z');
    assert.equal(reply[0].created_at, fixture.collections.profile.documents[0].created_at);
    assert.equal(request.data.created_at, reply[0].created_at, 'PROFILE_CANONICAL_MUTATES_RECEIVED_COPY transport must isolate producer');
  });
});
