'use strict';
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const scope = require('../lib/storage/tenant-scope');
const notificationFixture = require('./fixtures/tenant-notifications');
const alarmFixture = require('./fixtures/tenant-alarm-protocol');
const privateService = require('../lib/notifications').privateState;
const levels = require('../lib/levels');
const makeWriter = require('../lib/tenant-alarms/postgres').createWriter;
const admission = require('../lib/tenant-notifications/ack-admission');

describe('selected ACK and producer share durable state admission', function () {
  let mode;
  beforeEach(function () {mode = scope.getTenancyMode(); scope.setTenancyMode('multi');});
  afterEach(function () {scope.setTenancyMode(mode);});
  it('uses the same STATE advisory key and actual shipping ACK decision before suppression write without UPDATE authority', async function () {
    const n = notificationFixture(), a = alarmFixture(), consumer = 'realtime-selected', at = a.now;
    const bus = new EventEmitter(), service = privateService({}, {bus, levels, ddata: {lastUpdated: at}}, {
      clock: () => at, maxRows: 20, maxBytes: 100000
    });
    service.notifications.requestNotify({level:1,title:'Synthetic',message:'Synthetic',plugin:{name:'synthetic'}});
    service.notifications.requestSnooze({level:1,title:'Synthetic',message:'Synthetic',lengthMills:1000}); service.notifications.process();
    const producer = {alarms: service.snapshot(), effects: [], acks: [], output:null}; bus.emit('teardown');
    await scope.withTenant(n.A, () => n.store.consume({tenant:n.A,consumer,transform:async () => ({configIdentity:'config-current',producer,intents:[]})}));
    const selectedKeys = n.calls.filter(row => row.sql?.includes('notification-producer-lock')).map(row => row.values[0]);
    let locks = [], attemptedWrites = 0;
    const connection = {transaction: fn => n.connection.transaction(() => a.db.transaction(fn)), async query (sql, values) {
      if (sql.includes('notification-ack-time')) return a.db.query(sql, values);
      if (sql.includes('notification-') || sql.includes('tenant_notification_state')) {
        assert.ok(!sql.includes('FOR UPDATE'), 'ACK state SELECT must require no UPDATE authority');
        if (sql.includes('notification-producer-lock')) locks.push(values[0]);
        const result = await n.connection.query(sql, values);
        if (sql.includes('notification-readiness-table')) for (const row of result.rows) {
          row.inserts = false; row.any_writes = false; row.columns.forEach(column => {column.inserts = false; column.updates = false;});
        }
        return result;
      }
      if (sql.startsWith('INSERT')) attemptedWrites++;
      return a.db.query(sql, values);
    }};
    const admit = admission({namespace:'notification_test',consumer,alarmNamespace:'alarm_protocol',maxRows:20,maxBytes:100000,maxPayloadBytes:10000});
    const writer = makeWriter({connection,namespace:'alarm_protocol',authorizeInTransaction:async () => true,
      admitAckInTransaction: args => admit({...args,configIdentity:'config-current'})});
    a.now = at + 100;
    const ignored = await writer.ack(a.operation(1,'default',1800000));
    assert.equal(ignored.accepted,false); assert.equal(attemptedWrites,0, 'ACK_ACTIVE_PLUGIN_NO_SQL_EXTENSION');
    assert.deepEqual(a.rows(),[]); assert.deepEqual(locks,[selectedKeys[0]], 'ACK_SHARED_PRODUCER_LOCK_KEY');
    assert.deepEqual(n.producerStates()[0].producer,producer,'ACK_STATE_SELECT_ONLY');
    a.now = at + 1000; const accepted = await writer.ack(a.operation(2,'default',1000));
    assert.equal(accepted.accepted,true); assert.equal(a.rows().length,2);
    assert.ok(a.rows().every(row => Number(row.acked_at) === at + 1000 && Number(row.expires_at) === at + 2000));
  });
});
