'use strict';
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { ObjectId } = require('mongodb');
const codec = require('./fixtures/realtime-preview/wire-response');
const scope = require('../lib/storage/tenant-scope');
async function canonicalReply () {
  const fixture = require('./fixtures/socket-forwarding/recording-context').context();
  const executor = require('../lib/server/tenant-socket-write-executor').createExecutor({ contextForOperation: () => ({
    env: fixture.env, ctx: fixture.ctx, authorizationFor: () => ({ read: true, write: true }) }) });
  const producer = { collection: 'profile', data: { _id: '111111111111111111111111', NSCLIENT_ID: 'synthetic', startDate: '2026-11-06', store: { Synthetic: { dia: 3 } } } };
  const startedAt = Date.now();
  const raw = await executor({ tenant: '11111111-1111-4111-8111-111111111111', source: 'socket', namespace: '/', event: 'dbAdd',
    args: [structuredClone(producer)], actor: { tenant: '11111111-1111-4111-8111-111111111111', permissions: { read: true, write: true } } });
  return { raw, producer, physical: fixture.collections.profile.documents, window: { startedAt, finishedAt: Date.now() } };
}
async function actualPrivateCodec (raw) {
  const token = Symbol(), req = Readable.from([Buffer.from('{}')]); req.method = 'POST'; req.url = '/mutate'; req.headers = { 'content-type': 'application/json' };
  let status, result;
  const res = { headersSent: false, destroyed: false, writeHead (value) { status = value; }, end (bytes) { result = JSON.parse(bytes.toString()); }, destroy () { this.destroyed = true; } };
  await require('../lib/server/realtime/ipc').handler({ token, admitted: () => true, maxBytes: 100000, timeoutMs: 1000,
    operations: { '/mutate': async () => ({ replyArgs: raw }) } })(req, res);
  assert.equal(status, 200); return result.replyArgs;
}
describe('actual canonical profile reply wire boundary', function () {
  let original;
  beforeEach(function () { original = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(function () { scope.setTenancyMode(original); });
  it('reproduces actual raw ObjectId and matches actual private HTTP handler JSON without stripping the ID', async function () {
    const { raw } = await canonicalReply();
    assert(raw[0][0]._id instanceof ObjectId, 'PROFILE_ACTUAL_CANONICAL_RAW_OBJECTID');
    const actual = await actualPrivateCodec(raw);
    assert.equal(typeof actual[0][0]._id, 'string'); assert.notDeepEqual(raw, actual, 'PROFILE_RAW_EXECUTOR_IS_NOT_TRANSPORT_REPLY');
    assert.deepEqual(codec.encode(raw), actual, 'PROFILE_DIRECT_REPLY_MUST_MATCH_ACTUAL_IPC_JSON');
    assert.equal(actual[0][0]._id, raw[0][0]._id.toHexString());
  });
  it('matches the actual Socket.IO ACK encoder/decoder on the same raw callback', async function () {
    const { raw } = await canonicalReply(), parser = require('socket.io-parser');
    const decoder = new parser.Decoder(); let decoded;
    decoder.on('decoded', packet => { decoded = packet.data; });
    for (const packet of new parser.Encoder().encode({ type: parser.PacketType.ACK, nsp: '/', id: 1, data: raw })) decoder.add(packet);
    decoder.destroy(); assert.deepEqual(codec.encode(raw), decoded, 'PROFILE_DIRECT_REPLY_MUST_MATCH_ACTUAL_SOCKET_ACK');
  });
  it('retains independent physical BSON identity and fails when it becomes a string twin', async function () {
    const value = await canonicalReply(), wire = codec.encode(value.raw), physical = value.physical.map(doc => ({ ...doc }));
    const operation = { producer: value.producer, expected: wire, actual: structuredClone(wire),
      before: { mongoRaw: [], pgDocuments: [] }, windows: { mongo: value.window, postgres: value.window },
      mongoRaw: physical, pgDocuments: physical.map(doc => ({ ...doc })) };
    require('./fixtures/realtime-preview/profile-timestamps').compare(operation);
    operation.pgDocuments[0]._id = operation.pgDocuments[0]._id.toHexString();
    assert.throws(() => require('./fixtures/realtime-preview/profile-timestamps').compare(operation), /PROFILE_PHYSICAL_PARITY/);
    assert.equal(codec.physicalIds(physical)[0].id.kind, 'objectid');
    assert.equal(codec.physicalIds(operation.pgDocuments)[0].id.kind, 'string');
  });
  it('records typed physical IDs and exact assertion detail before propagating a red', async function () {
    const value = await canonicalReply(), wire = codec.encode(value.raw);
    const pgDocuments = value.physical.map(doc => ({ ...doc, _id: doc._id.toHexString() }));
    const operation = { producer: value.producer, expected: wire, actual: structuredClone(wire),
      before: { mongoRaw: [], pgDocuments: [] }, windows: { mongo: value.window, postgres: value.window },
      mongoRaw: value.physical, pgDocuments, idTypes: { mongo: codec.physicalIds(value.physical), postgres: codec.physicalIds(pgDocuments) } };
    let captured;
    assert.throws(() => codec.assertAndRecord(operation, () => { captured = JSON.parse(JSON.stringify(operation)); },
      () => require('./fixtures/realtime-preview/profile-timestamps').compare(operation)), /PROFILE_PHYSICAL_PARITY/);
    assert(captured, 'PROFILE_ASSERTION_DETAIL_BEFORE_RED');
    assert.equal(captured.assertion.code, 'ERR_ASSERTION'); assert.match(captured.assertion.message, /PROFILE_PHYSICAL_PARITY/);
    assert.equal(captured.idTypes.mongo[0].id.kind, 'objectid'); assert.equal(captured.idTypes.postgres[0].id.kind, 'string');
    assert.match(captured.assertion.inspectedExpected, /objectId/);
  });
  it('fails a wrong wire ID even if timestamp normalization is valid', async function () {
    const value = await canonicalReply(), wire = codec.encode(value.raw);
    const operation = { producer: value.producer, expected: wire, actual: structuredClone(wire),
      before: { mongoRaw: [], pgDocuments: [] }, windows: { mongo: value.window, postgres: value.window },
      mongoRaw: value.physical, pgDocuments: value.physical.map(doc => ({ ...doc })) };
    operation.actual[0][0]._id = '222222222222222222222222';
    assert.throws(() => require('./fixtures/realtime-preview/profile-timestamps').compare(operation), /UNIQUE_PHYSICAL_RECORD/);
  });
});
