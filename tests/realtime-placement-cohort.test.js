'use strict';
// Actual cohort coordinator and private schemas, recording peer/client model.
// No native database or actual role-backend inventory claim is made here.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const placementModule = require('../lib/realtime-placement');
const manifests = require('../lib/server/serve/operation-cohort-manifest');
const listeners = require('../lib/server/internal-api/listener-config');
const lower = require('../lib/storage/postgres-connection');
const A = '11111111-1111-4111-8111-111111111111', I = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', J = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DATA = { database: 'synthetic_test', database_oid: '16384', server_address: '127.0.0.1', server_port: 5432, postmaster_birth: '1700000000.0' };
function fixture () {
  let value = { version: 1, rule: placementModule.RULE, shardCount: 2, generation: 1, owners: ['a', 'b'], workers: [
    { id: 'a', incarnation: I, address: { socket: '/synthetic/a.sock' }, consumerOrigin: 'http://127.0.0.1:18001' },
    { id: 'b', incarnation: J, address: { socket: '/synthetic/b.sock' }, consumerOrigin: 'http://127.0.0.1:18002' }] };
  const internal = listeners.resolve(['api'], { NS_SERVE_INTERNAL_SOCKET: '/synthetic/control.sock' });
  let map = placementModule.parse(value, { internal });
  const placement = placementModule.create({ read: () => map });
  const participants = manifests.validate([['api'], ['evaluator'], ['tenant-admin'], ['realtime', 'a'], ['realtime', 'b']].map(([role, worker], index) => ({
    id: 'peer_' + index, roles: [role], ...(worker ? { worker } : {}), namespaces: ['synthetic_clinical'], endpoint: { socketPath: '/synthetic/peer_' + index + '.sock', maxBytes: 100000, timeoutMs: 1000 } })));
  const flags = {}, invalidated = [], actors = participants.map((row, index) => ({ pid: index + 100, role: row.id, birth: String(index + 1000) }));
  let held = 0;
  function status (peer, body) {
    if (flags.missing === peer.id) throw new Error('draining peer unreachable');
    const worker = peer.worker && map.workers.get(peer.worker), index = participants.indexOf(peer);
    const p = { generation: map.generation, digest: map.digest, rule: map.rule, shardCount: map.shardCount, worker: worker?.id || null, incarnation: worker?.incarnation || null,
      shards: worker ? map.owners.flatMap((owner, index) => owner?.worker === worker.id ? [index] : []) : [] };
    if (flags.wrongSubset === peer.id) p.shards = [0, 1];
    return { version: 2, participant: peer.id, incarnation: '00000000-0000-4000-8000-' + String(index + 1).padStart(12, '0'), namespace: 'synthetic_control', roles: peer.roles,
      tenants: [A], namespaces: peer.namespaces, identity: { window: 1 }, datastore: DATA, backends: [actors[index]], placement: p, ...body };
  }
  const file = path.resolve(__dirname, '../lib/server/serve/operation-cohort.js'), output = { exports: {} }, original = require('node:module').createRequire(file);
  const clients = { lifecycleParticipant: endpoint => {
    const peer = participants.find(row => row.endpoint.socketPath === endpoint.socketPath);
    return { getStatus: async body => status(peer, body), invalidateTenant: async body => { invalidated.push(peer.id); const { incarnation: expectedIncarnation, identity: expectedIdentity, ...echo } = body; return status(peer, echo); } };
  } };
  vm.runInThisContext('(function(require,module,exports){' + fs.readFileSync(file, 'utf8') + '\n})', { filename: file })(name => name === '../internal-api/clients' ? clients : original(name), output, output.exports);
  const coordinator = output.exports;
  const client = { query: async sql => {
    if (sql.startsWith('SELECT pg_try_advisory_lock_shared')) { held++; return { rows: [{ held: true }] }; }
    if (sql.startsWith('SELECT pg_advisory_unlock_shared')) { held--; return { rows: [{ released: true }] }; }
    if (sql === 'SELECT pg_catalog.pg_stat_clear_snapshot()') return { rows: [{}] };
    if (sql === 'SELECT ' + lower.datastoreSQL) return { rows: [DATA] };
    assert.ok(sql.includes('restore-cohort-actors')); return { rows: actors };
  } };
  return { coordinator, participants, placement, flags, invalidated, client, held: () => held,
    advance () { value = { ...value, generation: 2, transition: { previousGeneration: 1, previousOwners: [{ worker: 'a', incarnation: I }, { worker: 'b', incarnation: J }], stopped: [] } }; map = placementModule.parse(value, { internal }); },
    open: rows => coordinator.createRemote({ namespace: 'synthetic_control', tenants: [A], participants: rows || participants, placement }) };
}
describe('placement-derived fixed maintenance coverage', function () {
  it('SHARD_COHORT: pins every fixed peer and actual reported backend including the idle/draining roster, and shares publication lock through invalidation', async function () {
    const f = fixture(), remote = await f.open(); let token;
    try {
      token = await f.coordinator.pin(remote, A, { client: f.client }); assert.equal(f.held(), 1);
      assert.deepEqual(await f.coordinator.assertComplete(remote, A, { client: f.client }), { tenant: A, backends: 5, exempt: 0 });
      await f.coordinator.invalidate(remote, A); assert.deepEqual(f.invalidated, f.participants.map(row => row.id));
    } finally { if (token) await f.coordinator.releasePin(token); await remote.close(); }
    assert.equal(f.held(), 0);
  });
  it('SHARD_COHORT_OMISSION: a second realtime role does not excuse omitting another declared worker', async function () {
    const f = fixture(); await assert.rejects(f.open(f.participants.filter(row => row.worker !== 'b')), { code: 'RESTORE_COHORT_PLACEMENT_INCOMPLETE' });
  });
  it('SHARD_COHORT_SUBSET: does not accept self-reported coverage or hide an unreachable draining peer', async function () {
    const f = fixture(); f.flags.wrongSubset = 'peer_4';
    await assert.rejects(f.open(), { code: 'RESTORE_COHORT_PLACEMENT_MISMATCH' });
    delete f.flags.wrongSubset; f.flags.missing = 'peer_4'; await assert.rejects(f.open(), /draining peer unreachable/);
  });
  it('SHARD_COHORT_REVISION: a changed generation invalidates a pinned attempt even if the same workers remain', async function () {
    const f = fixture(), remote = await f.open(); let token;
    try {
      token = await f.coordinator.pin(remote, A, { client: f.client }); f.advance();
      await assert.rejects(f.coordinator.assertComplete(remote, A, { client: f.client }), { code: 'RESTORE_COHORT_PARTICIPANT_CHANGED' });
    } finally { if (token) await f.coordinator.releasePin(token); await remote.close(); }
    assert.equal(f.held(), 0);
  });
});
