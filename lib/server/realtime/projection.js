'use strict';

const scope = require('../../storage/tenant-scope');
const replayFactory = require('../../storage/postgres-durable-replay');
const projectionRead = require('../../storage/postgres-projection-read');
const evaluator = require('../../data/tenant-projection-evaluator');
const createSnapshot = require('../tenant-app/snapshot');
module.exports = function projection ({ config, connection, current }) {
  const tenant = current.tenant, env = current.env;
  const domains = Object.fromEntries(evaluator.domains.map(d => [d, config.namespaces[d] + '.' + d]));
  const replay = replayFactory({ connection, domains, checkpointTable: config.namespaces.checkpoint + '.tenant_consumer_checkpoint',
    clockTable: config.namespaces.clock + '.tenant_write_clock', consumer: config.consumer,
    projectionVersion: 'realtime-current-rows-v1', pageSize: config.pageSize, maxRows: config.maxRows });
  // Decision incremental-refresh: full reconcile on cold start, gap, mismatch
  // or a hard delete; otherwise only rows past the published checkpoint.
  const view = require('../../storage/postgres-incremental-view').create({ connection, domains,
    indexed: ['entries', 'treatments', 'devicestatus'], clockTable: config.namespaces.clock + '.tenant_write_clock',
    reconcile: () => replay.reconcile({ maxRows: config.maxRows, maxBytes: config.maxBytes }),
    pageSize: config.pageSize, maxRows: config.maxRows });
  return Object.freeze({
    stats: view.stats,
    async acquire ({ at }) {
      return scope.withTenant(tenant, async () => {
        const recovered = await view.refresh();
        const groups = Object.fromEntries(evaluator.domains.map(d => [d, []]));
        for (const row of recovered.rows) groups[row.domain].push(row.document);
        const stores = Object.fromEntries(evaluator.domains.map(logical => [logical, projectionRead({ tenant, connection, logical,
          documents: groups[logical], maxRows: config.maxRows, maxBytes: config.maxBytes, env })]));
        const language = require('../../language')(); language.set(env.settings.language);
        const ctx = evaluator.createContext({ env, language, storage: logical => stores[logical], dbstats: async () => ({ dataSize: 0 }) });
        const ports = Object.fromEntries(evaluator.domains.map(logical => [logical, { tenant, store: ctx[logical] }]));
        ports.stats = { tenant, read: () => require('../../storage/postgres-tenant-stats')({ connection, tables: domains }).read(tenant) };
        const snapshot = await createSnapshot({ tenant, ports, env, language }).load({ at });
        // Existing browser protocol supports full replacement, including absence.
        // No delta-only SGV merge is allowed to retain a physically deleted row.
        const frame = { ...snapshot.ddata.dataWithRecentStatuses(), lastUpdated: at, delta: false };
        const json = JSON.stringify(frame);
        if (Buffer.byteLength(json) > config.maxBytes) throw new Error('REALTIME_FRAME_BOUND');
        return Object.freeze({ tenant, checkpoint: recovered.checkpoint, rows: recovered.rows, frame: JSON.parse(json), read: recovered.mode });
      });
    }
  });
};
