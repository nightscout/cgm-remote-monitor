'use strict';
const assert = require('node:assert/strict');
const privateConfig = require('../lib/server/realtime/private-config');
const tenant = '11111111-1111-4111-8111-111111111111';
const ready = 'postgres://ready:synthetic@127.0.0.1/data_a';
const serving = 'postgres://data:synthetic@127.0.0.1/data_a';
describe('realtime alarm datastore binding', function () {
  it('refuses a different writer database and same-role identity without comparing passwords', function () {
    const value = { maxTenants: 2, maxMessageBytes: 1000,
      operationTimeoutMs: 1000, alarm: { connectionEnv: 'ALARM', namespace: 'alarm_test' } };
    const existing = { registry: true, namespaces: { entries: 'entries_test' }, connections: [serving, ready] };
    for (const url of ['postgres://alarm:synthetic@127.0.0.1/data_b', 'postgres://alarm:synthetic@other.test/data_a',
      'postgres://alarm:synthetic@127.0.0.1:6543/data_a', 'postgres://%64ata:other@127.0.0.1/data_a', 'postgres://ready:other@127.0.0.1/data_a']) {
      assert.throws(() => privateConfig(value, { ALARM: url }, existing), { code: 'SOCKET_PRIVATE_CONFIG_REFUSED' }, 'RT_ALARM_DATASTORE_BINDING cross-database/role writer must refuse');
    }
    assert.equal(privateConfig(value, { ALARM: 'postgres://alarm:distinct@127.0.0.1/data_a' }, existing).alarm.namespace, 'alarm_test');
  });
  it('checks actual writer catalogue SQL before opening its operational pool', async function () {
    const pg = require('pg'), original = { connect: pg.Client.prototype.connect, query: pg.Client.prototype.query, end: pg.Client.prototype.end };
    const key = require.resolve('../lib/storage/postgres-connection'), factory = require(key);
    const catalogue = require('../migrations/candidates/postgres-alarm-suppression-v1.json');
    const queries = [];
    pg.Client.prototype.connect = async function () {};
    pg.Client.prototype.end = async function () {};
    pg.Client.prototype.query = async function (sql) {
      const user = this.connectionParameters.user; queries.push({ user, sql });
      if (sql.startsWith('SELECT to_regclass')) return { rows: [{ present: true }] };
      if (sql.startsWith('SELECT name, checksum')) return { rows: user === 'ready' ? catalogue.migrations.map(({ name, checksum }) => ({ name, checksum })) : [] };
      return { rows: [] };
    };
    require.cache[key].exports = async () => { throw new Error('OPERATIONAL_POOL_REACHED_WITH_UNCHECKED_WRITER'); };
    try {
      await assert.rejects(require('../lib/server/realtime/private-api').boot({ config: {
        resolver: { resolve: async () => tenant }, prepareRegistryTenant: async id => id === tenant,
        readinessConnectionString: ready,
        socketForwarding: { maxTenants: 2, maxMessageBytes: 1000, operationTimeoutMs: 1000,
          alarm: { connectionString: 'postgres://alarm:synthetic@127.0.0.1/data_a', namespace: 'alarm_test' } }
      } }), error => error.code === 'MIG_STALE', 'RT_ACTUAL_ALARM_LEDGER stale selected writer must refuse before operational pool');
      const ledgerUsers = queries.filter(row => row.sql.startsWith('SELECT name, checksum FROM "alarm_test".schema_migrations')).map(row => row.user);
      assert.deepEqual(ledgerUsers, ['ready', 'alarm'], 'RT_ACTUAL_ALARM_LEDGER readiness and selected writer each read the alarm catalogue');
    } finally {
      Object.assign(pg.Client.prototype, original); require.cache[key].exports = factory;
    }
  });
});
