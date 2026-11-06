'use strict';

// Dormant current-state clinical computation after durable projection COMMIT.
// No listener, scheduler, notification handoff or production role is enabled.
const scope = require('../storage/tenant-scope');
const environment = require('../server/tenant-app/environment');
const projectionRead = require('../storage/postgres-projection-read');
const viewsFactory = require('./views');
const DOMAIN_NAMES = Object.freeze(['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const wrappers = Object.freeze({ entries: require('../server/entries'), treatments: require('../server/treatments'),
  devicestatus: require('../server/devicestatus'), profile: require('../server/profile'),
  food: require('../server/food'), activity: require('../server/activity') });

function createContext ({ env, language, storage, dbstats }) {
  const ctx = { settings: env.settings, language, moment: require('moment-timezone'),
    levels: { ...require('../levels'), translate: language.translate },
    storagePorts: { resolve ({ logical, source }) {
      if (source !== 'v1/internal' || !DOMAIN_NAMES.includes(logical)) throw new Error('Evaluator read port unavailable');
      return { storage: storage(logical), intentFactory () { throw new Error('Evaluator cannot create write intent'); } };
    } },
    store: { db: { stats: dbstats } } };
  for (const logical of DOMAIN_NAMES) ctx[logical] = logical === 'profile'
    ? wrappers.profile(env.profile_collection, ctx, env) : wrappers[logical](env, ctx);
  return ctx;
}

module.exports = function tenantProjectionEvaluator ({ tenant, replay, connection, env,
  language, dbstats, maxRows, maxBytes } = {}) {
  if ((typeof tenant !== 'string' || !UUID.test(tenant)) || typeof replay?.catchUp !== 'function' ||
      typeof connection?.query !== 'function' || !environment.isSafe(env) ||
      typeof language?.translate !== 'function' || typeof dbstats !== 'function' ||
      !Number.isSafeInteger(maxRows) || maxRows < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError('Evaluator requires explicit tenant replay, safe environment, statistics and projection bounds');
  }
  let active = null, running = false, closed = false, kept = null;
  const ctx = createContext({ env, language, dbstats, storage (logical) {
    if (!active) throw new Error('Evaluator has no committed projection');
    return active[logical];
  } });
  const views = viewsFactory(env, ctx);
  function binding () {
    const current = scope.currentTenant();
    if (current && current !== tenant) throw new Error('Evaluator tenant scope mismatch');
    if (closed) throw new Error('Evaluator is closed');
  }
  return Object.freeze({
    tenant,
    async evaluate ({ at = Date.now() } = {}) {
      binding();
      if (running) throw new Error('Evaluator cycle already running');
      if (typeof at !== 'number' || !Number.isFinite(at)) throw new TypeError('Evaluator requires an instant');
      running = true;
      try {
        return await scope.withTenant(tenant, async () => {
          const recovered = await replay.catchUp(); // resolves only after COMMIT
          binding();
          if (!recovered || !Array.isArray(recovered.rows) || recovered.rows.length > maxRows ||
              !Number.isSafeInteger(recovered.checkpoint) || recovered.checkpoint < 0) {
            throw new Error('Evaluator recovered projection is invalid or over bound');
          }
          if (Buffer.byteLength(JSON.stringify(recovered.rows)) > maxBytes) {
            throw new Error('Evaluator projection byte bound exceeded');
          }
          const groups = Object.fromEntries(DOMAIN_NAMES.map(name => [name, []]));
          for (const row of recovered.rows) {
            if (!DOMAIN_NAMES.includes(row?.domain)) throw new Error('Evaluator recovered domain is unsupported');
            groups[row.domain].push(row.document);
          }
          active = Object.fromEntries(DOMAIN_NAMES.map(logical => [logical, projectionRead({
            tenant, connection, logical, documents: groups[logical], maxRows, maxBytes, env
          })]));
          const set = await new Promise((resolve, reject) => views.materialise('properties', { now: at },
            (error, materialized) => error ? reject(error) : resolve(materialized)));
          const result = views.evaluateCycle(set);
          binding(); // a close during reads cannot publish late state
          kept = Object.freeze({ tenant, checkpoint: recovered.checkpoint, ...result });
          return kept;
        });
      } finally { active = null; running = false; }
    },
    last () { binding(); return kept; },
    close () { closed = true; active = null; }
  });
};
module.exports.createContext = createContext;
module.exports.domains = DOMAIN_NAMES;
