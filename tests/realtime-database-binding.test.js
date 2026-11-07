'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const privateConfig = require('../lib/server/realtime/private-config');
const tenant = '11111111-1111-4111-8111-111111111111';
const ready = 'postgres://ready:synthetic@127.0.0.1/data_a';
const serving = 'postgres://data:synthetic@127.0.0.1/data_a';
describe('realtime alarm datastore binding', function () {
  it('refuses a different writer database and same-role identity without comparing passwords', function () {
    const value = { socketPathEnv: 'SOCKET', admissionFileEnv: 'ADMISSION', maxTenants: 2, maxMessageBytes: 1000,
      operationTimeoutMs: 1000, alarm: { connectionEnv: 'ALARM', namespace: 'alarm_test' } };
    const source = { SOCKET: '/tmp/owned/api.sock', ADMISSION: '/tmp/admission.json' };
    const existing = { namespaces: { entries: 'entries_test' }, connections: [serving, ready] };
    for (const url of ['postgres://alarm:synthetic@127.0.0.1/data_b', 'postgres://alarm:synthetic@other.test/data_a',
      'postgres://alarm:synthetic@127.0.0.1:6543/data_a', 'postgres://%64ata:other@127.0.0.1/data_a', 'postgres://ready:other@127.0.0.1/data_a']) {
      assert.throws(() => privateConfig(value, { ...source, ALARM: url }, existing), /REFUSED/, 'RT_ALARM_DATASTORE_BINDING cross-database/role writer must refuse');
    }
    assert.equal(privateConfig(value, { ...source, ALARM: 'postgres://alarm:distinct@127.0.0.1/data_a' }, existing).alarm.namespace, 'alarm_test');
  });
  it('checks actual writer catalogue SQL before opening its operational pool', async function () {
    const pg = require('pg'), original = { connect: pg.Client.prototype.connect, query: pg.Client.prototype.query, end: pg.Client.prototype.end };
    const key = require.resolve('../lib/storage/postgres-connection'), factory = require(key);
    const catalogue = require('../migrations/candidates/postgres-alarm-suppression-v1.json');
    const queries = [], dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-db-binding-'));
    const admissionFile = path.join(dir, 'admission.json');
    fs.writeFileSync(admissionFile, JSON.stringify({ version: 1, mode: 'preview-socket-allowlist', tenants: [{ id: tenant, enabled: true, aliases: ['a.test'] }] }));
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
        bindings: new Map([[tenant, true]]), readinessConnectionString: ready,
        socketForwarding: { admissionFile, maxTenants: 2, ipc: { timeoutMs: 1000 },
          alarm: { connectionString: 'postgres://alarm:synthetic@127.0.0.1/data_a', namespace: 'alarm_test' } }
      } }), error => error.code === 'MIG_STALE', 'RT_ACTUAL_ALARM_LEDGER stale selected writer must refuse before operational pool');
      assert.ok(queries.some(row => row.user === 'alarm' && row.sql.startsWith('SELECT name, checksum')), 'RT_ACTUAL_ALARM_LEDGER actual selected writer runs catalogue SQL');
    } finally {
      Object.assign(pg.Client.prototype, original); require.cache[key].exports = factory; fs.rmSync(dir, { recursive: true });
    }
  });
});
