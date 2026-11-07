'use strict';

const scope = require('../../storage/tenant-scope');
const connect = require('../../storage/postgres-connection');
const replayFactory = require('../../storage/postgres-durable-replay');
const evaluator = require('../../data/tenant-projection-evaluator');
const startRuntime = require('./evaluator-runtime');
const { PreviewConfigError } = require('./preview-config');

async function boot (config) {
  let connection, runtime, closing;
  async function close () {
    if (closing) return closing;
    closing = (async () => {
      try { if (runtime) await runtime.close(); } finally { if (connection) await connection.end(); }
    })();
    return closing;
  }
  try {
    await require('./evaluator-readiness')(config);
    scope.setTenancyMode('multi');
    connection = await connect({ connectionString: config.connectionString, max: 4,
      connectionTimeoutMillis: 5000, statement_timeout: 5000, application_name: 'nightscout-evaluator-preview' });
    const domains = Object.fromEntries(evaluator.domains.map(d => [d, config.namespaces[d] + '.' + d]));
    runtime = await startRuntime({ ...config, tenants: [...config.tenants.keys()], create (current) {
      const replay = replayFactory({ connection, domains, checkpointTable: config.namespaces.checkpoint + '.tenant_consumer_checkpoint',
        clockTable: config.namespaces.clock + '.tenant_write_clock', consumer: config.consumer,
        projectionVersion: 'clinical-current-rows-v1', pageSize: config.pageSize, maxRows: config.maxRows });
      const language = require('../../language')();
      language.set(current.env.settings.language);
      return evaluator({ tenant: current.tenant, replay, connection, env: current.env, language,
        maxRows: config.maxRows, maxBytes: config.maxBytes, dbstats: async () => {
          const result = await connection.query('SELECT COALESCE(sum(pg_relation_size(x::regclass)),0)::text AS bytes FROM unnest($1::text[]) x',
            [Object.values(domains)]);
          return { dataSize: Number(result.rows[0].bytes), indexSize: 0 };
        } });
    } });
    console.log('Evaluator preview started; configured tenants:', config.tenants.size);
    return Object.freeze({ acquire: runtime.acquire, tick: runtime.tick, health: runtime.health, last: runtime.last, isCurrent: runtime.isCurrent, close });
  } catch {
    await close();
    throw new PreviewConfigError('evaluator preview readiness or initialization refused');
  }
}
module.exports = { boot };
