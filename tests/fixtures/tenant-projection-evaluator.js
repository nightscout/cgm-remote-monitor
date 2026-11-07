'use strict';

const replayLab = require('./tenant-durable-replay');
const replay = require('../../lib/storage/postgres-durable-replay');
const evaluator = require('../../lib/data/tenant-projection-evaluator');
const collection = require('../../lib/storage/postgres-collection-intent');
const environment = require('../../lib/server/tenant-app/environment');
const views = require('../../lib/data/views');
const { encodeDocument } = require('../../lib/storage/postgres-identity');
const scope = require('../../lib/storage/tenant-scope');
const dates = require('../../lib/server/srv-dates');
const clock = require('../lib/views-replay/clock');

module.exports = function evaluatorLab () {
  const lab = replayLab();
  const open = lab.open.bind(lab);
  const domains = evaluator.domains;
  lab.tables = Object.fromEntries(domains.map(logical => [logical, lab.namespaces[logical] + '.' + logical]));
  lab.env = environment({ settings: { enable: ['bgnow', 'delta', 'direction', 'rawbg', 'iob', 'cob',
    'profile', 'basal', 'pump', 'openaps', 'loop', 'timeago', 'simplealarms', 'devicestatus'],
  thresholds: { bgHigh: 200, bgTargetTop: 180, bgTargetBottom: 80, bgLow: 55 } } });
  lab.language = require('../../lib/language')();
  lab.stats = async () => ({ dataSize: 10000, indexSize: 1000 });
  lab.open = async () => {
    await open();
    for (const logical of domains) {
      await lab.admin.query(`GRANT USAGE ON SCHEMA "${lab.namespaces[logical]}" TO "${lab.readerRole}"`);
      await lab.admin.query(`GRANT SELECT ON "${lab.namespaces[logical]}"."${logical}" TO "${lab.readerRole}"`);
    }
  };
  lab.consumer = (consumer = 'clinical-view', connection = lab.reader) => replay({ connection,
    checkpointTable: lab.replayNamespace + '.tenant_consumer_checkpoint',
    clockTable: lab.namespaces.clock + '.tenant_write_clock', domains: lab.tables,
    consumer, projectionVersion: 'clinical-current-rows-v1', pageSize: 3, maxRows: 10000 });
  lab.provisionView = async (tenant = lab.A, { checkpoint = 0, projection = null } = {}) => {
    const handle = lab.consumer();
    await lab.admin.query(`INSERT INTO "${lab.replayNamespace}".tenant_consumer_checkpoint
      (tenant_id,consumer,contract_digest,checkpoint,projection) VALUES($1,$2,$3,$4,$5::jsonb)`,
    [tenant, 'clinical-view', handle.digest, checkpoint, projection === null ? null : JSON.stringify(projection)]);
    return handle;
  };
  lab.evaluator = (tenant = lab.A, extra = {}) => evaluator({ tenant, replay: lab.consumer(), connection: lab.reader,
    env: lab.env, language: lab.language, dbstats: lab.stats, maxRows: 10000, maxBytes: 4 * 1024 * 1024, ...extra });
  lab.persistDomains = (records, tenant = lab.A) => scope.withTenant(tenant, () => lab.clocks[0].transaction(async () => {
    const modified = dates.next();
    for (const [logical, documents] of Object.entries(records)) {
      if (!domains.includes(logical)) throw new Error('Fixture domain not admitted');
      for (const input of documents) {
        const row = encodeDocument({ ...input, srvModified: modified });
        await lab.raw[0].query(`INSERT INTO "${lab.namespaces[logical]}"."${logical}"(tenant_id,id_kind,doc) VALUES($1,$2,$3::jsonb)
          ON CONFLICT(tenant_id,id_kind,"_id") DO UPDATE SET doc=excluded.doc`, [tenant, row.id_kind, JSON.stringify(row.doc)]);
      }
    }
    return modified;
  }));
  lab.fresh = async (tenant, at) => scope.withTenant(tenant, async () => {
    // Independent physical clinical-table reads, not recovered JSON source.
    const stores = Object.fromEntries(domains.map(logical => [logical, collection({ connection: lab.reader,
      table: lab.tables[logical], logical, env: lab.env, source: 'v1/internal' }).storage]));
    const ctx = evaluator.createContext({ env: lab.env, language: lab.language,
      storage: logical => stores[logical], dbstats: lab.stats });
    const instance = views(lab.env, ctx);
    const set = await new Promise((resolve, reject) => instance.materialise('properties', { now: at },
      (error, value) => error ? reject(error) : resolve(value)));
    return instance.evaluateCycle(set);
  });
  lab.at = async (at, fn) => {
    clock.install(); clock.pin(at);
    try { return await fn(); } finally { clock.uninstall(); }
  };
  lab.checkpointView = tenant => lab.checkpoint('clinical-view', tenant);
  return lab;
};
