'use strict';
const placement = require('../../lib/realtime-placement');
const listeners = require('../../lib/server/internal-api/listener-config');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const I = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', J = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const internal = listeners.resolve(['realtime'], { NS_SERVE_INTERNAL_SOCKET: '/tmp/shard-a.sock' });
function config () {
  return { version: 1, rule: placement.RULE, shardCount: 8, generation: 1,
    workers: [{ id: 'a', incarnation: I, address: { socket: '/tmp/shard-a.sock' }, consumerOrigin: 'http://127.0.0.1:18001' },
      { id: 'b', incarnation: J, address: { socket: '/tmp/shard-b.sock' }, consumerOrigin: 'http://127.0.0.1:18002' }], owners: Array(8).fill('a') };
}
const parse = value => placement.parse(value, { internal });
function move (base, target) {
  return { ...base, workers: base.workers.map(row => row.id === 'a' ? { ...row, incarnation: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' } : row), generation: base.generation + 1, owners: Array(8).fill(target),
    transition: { previousGeneration: base.generation,
      previousOwners: base.owners.map(worker => worker && ({ worker, incarnation: base.workers.find(row => row.id === worker).incarnation })),
      stopped: [{ worker: 'a', incarnation: I }] } };
}
module.exports={A,B,I,J,internal,placement,config,parse,move};
