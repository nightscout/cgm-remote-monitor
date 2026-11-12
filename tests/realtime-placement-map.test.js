'use strict';
const assert = require('node:assert/strict');
const { A, B, I, J, internal, placement, config, parse, move } = require('./fixtures/realtime-placement-map');
describe('fixed logical realtime placement', function () {
  it('SHARD_OBSERVER: pure operators validate instance endpoints without a serving role or service alias fallback', function () {
    const observer=require('../lib/server/internal-api/listener-config').observer({NS_REALTIME_INTERNAL_SOCKET:'/synthetic/realtime-service.sock'});
    assert.deepEqual(observer.instance(['realtime'],{socket:'/synthetic/realtime-a.sock'},{maxBytes:1000,timeoutMs:100}),{socketPath:'/synthetic/realtime-a.sock',maxBytes:1000,timeoutMs:100});
    assert.throws(()=>observer.instance(['realtime'],{socket:'/synthetic/realtime-service.sock'},{maxBytes:1000,timeoutMs:100}));
    assert.throws(()=>observer.instance(['realtime'],{socket:'/synthetic/realtime-a.sock'},{maxBytes:1000,timeoutMs:100},{self:true}));
    assert.doesNotThrow(()=>placement.parse(config(),{internal:observer}));
  });

  it('SHARD_VECTOR: pins canonical UUID text, SHA256 leading unsigned big-endian word and explicit-count modulus', function () {
    assert.deepEqual([1,2,8,16,65536].map(count=>placement.shard(A,count)),[0,1,5,5,25253]);
    assert.deepEqual([1,2,8,16,65536].map(count=>placement.shard(B,count)),[0,0,4,12,63532]);
    assert.throws(()=>placement.shard('11111111-1111-4111-8111-11111111111A',8),{code:'REALTIME_PLACEMENT_TENANT_REFUSED'});
  });
  it('SHARD_STABILITY: worker count never changes logical shards, and consumer/alarm routes share owner incarnation and generation', function () {
    const source = config(); let current = parse(source);
    const reader = placement.create({ read: () => current, self: { worker: 'a', incarnation: I } });
    const before = [A, B].map(id => reader.route(id));
    const bigger = structuredClone(source); bigger.generation = 2;
    bigger.workers.push({ id: 'c', incarnation: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', address: { socket: '/tmp/shard-c.sock' }, consumerOrigin: 'http://127.0.0.1:18003' });
    bigger.transition = { previousGeneration: 1, previousOwners: source.owners.map(worker => ({ worker, incarnation: I })), stopped: [] };
    current = parse(bigger);
    for (const [index, id] of [A, B].entries()) {
      const route = reader.assert(id); assert.equal(route.shard, before[index].shard); assert.equal(route.worker, 'a');
      assert.equal(route.incarnation, I); assert.equal(route.generation, 2);
      assert.equal(route.endpoint.socketPath, '/tmp/shard-a.sock'); assert.equal(route.consumerOrigin, 'http://127.0.0.1:18001');
    }
  });
  it('SHARD_EXCLUSION: refuses route-only takeover and stopped incarnations still named as owners', function () {
    const base = config(), next = move(base, 'b');
    const unconfirmed = structuredClone(next); unconfirmed.transition.stopped = [];
    assert.throws(() => parse(unconfirmed), { code: 'REALTIME_PLACEMENT_OLD_OWNER_UNCONFIRMED' });
    assert.doesNotThrow(() => parse(next));
    const retained = structuredClone(next); retained.workers[0].incarnation = I; retained.owners[0] = 'a';
    assert.throws(() => parse(retained), { code: 'REALTIME_PLACEMENT_STOPPED_OWNER' });
    const unknownAlive = move(base, null); unknownAlive.transition.stopped = [];
    assert.throws(() => parse(unknownAlive), { code: 'REALTIME_PLACEMENT_OLD_OWNER_UNCONFIRMED' });
  });
  it('SHARD_REVISION: refuses stale/mutated maps and repartition; publishers require consecutive revisions while readers tolerate missed publications', function () {
    const base = config(); let current = parse(base);
    const reader = placement.create({ read: () => current, self: { worker: 'a', incarnation: I } }); reader.current();
    const changed = structuredClone(base); changed.owners[0] = 'b'; current = parse(changed);
    assert.throws(reader.current, { code: 'REALTIME_PLACEMENT_REVISION_REFUSED' });
    const next = move(base, 'b'); current = parse(next); assert.equal(reader.owns(A), false);
    assert.throws(() => reader.assert(A), { code: 'REALTIME_PLACEMENT_WRONG_OWNER' });
    current = parse(base); assert.throws(reader.current, { code: 'REALTIME_PLACEMENT_REVISION_REFUSED' });
    current = parse({ ...next, shardCount: 4, owners: Array(4).fill('b'), transition: { ...next.transition, previousOwners: next.transition.previousOwners.slice(0, 4) } });
    assert.throws(reader.current, { code: 'REALTIME_PLACEMENT_REVISION_REFUSED' });
    const skipped = { ...next, generation: 4, transition: { ...next.transition, previousGeneration: 3 } }; current = parse(skipped);
    assert.doesNotThrow(reader.current, 'SHARD_READER_SKIP accepts a newer authoritative map without forcing unaffected process restart');
    let publicationMap=parse(base);const publisher=placement.create({read:()=>publicationMap,continuous:true});publisher.current();publicationMap=current;
    assert.throws(publisher.current,{code:'REALTIME_PLACEMENT_REVISION_REFUSED'});
  });
  it('SHARD_IDLE: unassigned shards refuse routing, idle owners need no fabricated tenant, unchanged owners accept older nonfuture routing generations', function () {
    const source = config(), self = { worker: 'a', incarnation: I }; let current = parse(source);
    const reader = placement.create({ read: () => current, self }); const old = reader.route(A);
    const next = structuredClone(source); next.generation = 2;
    next.transition = { previousGeneration: 1, previousOwners: source.owners.map(worker => ({ worker, incarnation: I })), stopped: [] };
    current = parse(next); assert.equal(reader.owns(A), true);
    assert.doesNotThrow(() => reader.assert(A, old), 'unchanged exact owner remains available while another shard stages');
    assert.throws(() => reader.assert(A, { ...old, generation: 3 }), { code: 'REALTIME_PLACEMENT_WRONG_OWNER' });
    const idle = config(); idle.owners.fill(null); const empty = placement.create({ read: () => parse(idle), self });
    assert.doesNotThrow(empty.current); assert.throws(() => empty.route(A), { code: 'REALTIME_PLACEMENT_UNAVAILABLE' });
  });
  it('SHARD_IDLE_EXCLUSION: removing or reincarnating an idle worker still requires actual platform stop confirmation', function () {
    const base=config();let current=parse(base);const publisher=placement.create({read:()=>current,continuous:true});publisher.current();
    const next={...base,generation:2,workers:[base.workers[0]],transition:{previousGeneration:1,previousOwners:base.owners.map(worker=>({worker,incarnation:I})),stopped:[]}};
    current=parse(next);assert.throws(publisher.current,{code:'REALTIME_PLACEMENT_OLD_OWNER_UNCONFIRMED'});
    next.transition.stopped=[{worker:'b',incarnation:J}];current=parse(next);assert.doesNotThrow(publisher.current);
  });
  it('SHARD_CONFIG: refuses ambiguous endpoints, implicit counts, reused self identities and unsupported algorithms', function () {
    for (const mutate of [v => { delete v.shardCount; }, v => { v.rule = 'process-count'; }, v => { v.workers[1].address = v.workers[0].address; },
      v => { v.workers[1].consumerOrigin = v.workers[0].consumerOrigin; }, v => { v.workers[0].id = null; }]) {
      const source = config(); mutate(source); assert.throws(() => parse(source));
    }
    const wrong = config(); wrong.workers[0].incarnation = J;
    assert.throws(() => placement.parse(wrong, { internal, self: { worker: 'a', incarnation: I } }), { code: 'REALTIME_PLACEMENT_SELF_REFUSED' });
  });
});

