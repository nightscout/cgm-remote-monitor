'use strict';

// Current-state clinical computation after durable input projection COMMIT.
// Explicit evaluator preview owns scheduling; this component opens no listener
// and performs no notification/provider handoff.
const scope = require('../storage/tenant-scope');
const { encodeDocument, decodeDocument } = require('../storage/postgres-identity');
const environment = require('../server/tenant-app/environment');
const projectionRead = require('../storage/postgres-projection-read');
const viewsFactory = require('./views');
const { nextDue } = require('./evaluator-due');
const { deepFreeze } = require('./json-copy');
const momentMemo = require('./moment-memo');
const sameSignature = (a, b) => !!a && !!b && typeof a === 'object' && typeof b === 'object' &&
  a.stamp === b.stamp && a.rows === b.rows && a.digest === b.digest;
const DOMAIN_NAMES = Object.freeze(['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const wrappers = Object.freeze({ entries: require('../server/entries'), treatments: require('../server/treatments'),
  devicestatus: require('../server/devicestatus'), profile: require('../server/profile'),
  food: require('../server/food'), activity: require('../server/activity') });

// moment: the evaluator passes its own document-date memo (moment-memo.js);
// any other caller gets moment-timezone itself.
function createContext ({ env, language, storage, dbstats, moment = require('moment-timezone') }) {
  const ctx = { settings: env.settings, language, moment,
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
  if ((typeof tenant !== 'string' || !UUID.test(tenant)) || typeof replay?.reconcile !== 'function' ||
      typeof connection?.query !== 'function' || !environment.isSafe(env) ||
      typeof language?.translate !== 'function' || typeof dbstats !== 'function' ||
      !Number.isSafeInteger(maxRows) || maxRows < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError('Evaluator requires explicit tenant replay, safe environment, statistics and projection bounds');
  }
  let active = null, running = false, closed = false, kept = null, retained = null, revision = 0;
  let ctx = null, views = null;
  // Document dates parsed once per distinct string, kept while in use.
  const dates = momentMemo(require('moment-timezone'));
  function context () {
    ctx = createContext({ env, language, dbstats, moment: dates.moment, storage (logical) {
      if (!active) throw new Error('Evaluator has no committed projection');
      return active[logical];
    } });
    views = viewsFactory(env, ctx);
  }
  context();
  function binding () {
    const current = scope.currentTenant();
    if (current && current !== tenant) throw new Error('Evaluator tenant scope mismatch');
    if (closed) throw new Error('Evaluator is closed');
  }
  async function compute (acquire, at) {
    binding();
    if (running) throw new Error('Evaluator cycle already running');
    if (typeof at !== 'number' || !Number.isFinite(at)) throw new TypeError('Evaluator requires an instant');
    running = true;
    dates.cycle();
    try {
      return await scope.withTenant(tenant, async () => {
        let input, same = false;
        if (acquire) {
          const recovered = await replay.reconcile({ maxRows, maxBytes, signature: true }); // input COMMIT, not evaluated output
          binding();
          if (!recovered || !Array.isArray(recovered.rows) || recovered.rows.length > maxRows ||
              !Number.isSafeInteger(recovered.checkpoint) || recovered.checkpoint < 0) {
            throw new Error('Evaluator recovered projection is invalid or over bound');
          }
          // Candidate E: the same change signature as the retained input's
          // (same checkpoint and progress) means the same rows; keep the
          // retained rows and their prepared sources instead of encoding,
          // copying and freezing them again. Statistics are always new.
          same = !!retained && sameSignature(retained.input.signature, recovered.signature) &&
            retained.input.checkpoint === recovered.checkpoint && retained.input.progress === recovered.progress;
          if (!same && Buffer.byteLength(JSON.stringify(recovered.rows)) > maxBytes) throw new Error('Evaluator projection byte bound exceeded');
          const rows = same ? retained.input.rows : recovered.rows.map(row => {
            if (!DOMAIN_NAMES.includes(row?.domain)) throw new Error('Evaluator recovered domain is unsupported');
            return { domain: row.domain, ...encodeDocument(row.document) };
          });
          // Retain immutable input and acquisition statistics only after a
          // successful clinical computation; a time tick never reloads either.
          const stats = await dbstats();
          if (!stats || typeof stats !== 'object' || Array.isArray(stats)) throw new Error('Evaluator statistics unavailable');
          const signature = recovered.signature && typeof recovered.signature === 'object' ? { ...recovered.signature } : null;
          input = { checkpoint: recovered.checkpoint, progress: recovered.progress, rows, stats, signature };
        } else {
          if (!retained) throw new Error('Evaluator has no successful retained input');
        }
        binding();
        // The retained input is the JSON round trip of the acquired input,
        // deeply frozen, with each domain's projection source prepared from it
        // once (postgres-projection-read prepare). A time-only cycle reads
        // both as they are: nothing downstream receives the retained objects
        // (each read serialises the prepared text), and a frozen value cannot
        // be changed by anything that does.
        let next = retained;
        if (acquire && same) {
          // JSON.stringify(input) is the rest of the input's text with the
          // rows' text in place of "[]": its byte length, without the rows.
          const rest = JSON.stringify({ ...input, rows: [] });
          if (Buffer.byteLength(rest) - 2 + retained.rowBytes > maxBytes) throw new Error('Evaluator retained input byte bound exceeded');
          next = Object.freeze({ input: deepFreeze({ ...JSON.parse(rest), rows: retained.input.rows }),
            prepared: retained.prepared, rowBytes: retained.rowBytes });
        } else if (acquire) {
          const text = JSON.stringify(input);
          if (Buffer.byteLength(text) > maxBytes) throw new Error('Evaluator retained input byte bound exceeded');
          const frozen = deepFreeze(JSON.parse(text));
          const groups = Object.fromEntries(DOMAIN_NAMES.map(name => [name, []]));
          for (const row of frozen.rows) groups[row.domain].push(decodeDocument(row));
          next = Object.freeze({ input: frozen, rowBytes: Buffer.byteLength(JSON.stringify(frozen.rows)),
            prepared: Object.freeze(Object.fromEntries(DOMAIN_NAMES.map(logical =>
              [logical, projectionRead.prepare({ documents: groups[logical], maxRows, maxBytes })]))) });
        }
        input = next.input;
        active = Object.fromEntries(DOMAIN_NAMES.map(logical => [logical, projectionRead({
          tenant, connection, logical, prepared: next.prepared[logical], maxRows, maxBytes, env
        })]));
        if (!views) context();
        const set = await new Promise((resolve, reject) => views.materialise('properties', { now: at, dbstats: input.stats },
          (error, materialized) => error ? reject(error) : resolve(materialized)));
        const result = views.evaluateCycle(set);
        binding(); // a close during reads cannot publish late state
        retained = next;
        // Not content (evaluator-runtime CONTENT): when the output can next
        // change with time alone, and the input's change signature.
        const due = nextDue({ ddata: set.ddata, env, result, at });
        kept = Object.freeze({ tenant, checkpoint: input.checkpoint, progress: input.progress,
          evaluationRevision: ++revision, trigger: acquire ? 'acquisition' : 'time-only', ...result,
          signature: input.signature ? Object.freeze({ ...input.signature }) : null, due });
        return kept;
      });
    } finally { active = null; running = false; }
  }
  return Object.freeze({ tenant,
    reconfigure ({ env: next }) {
      binding();
      if (running || !environment.isSafe(next)) throw new Error('Evaluator settings change refused');
      // The runtime admits this only for a settings-only change of the same
      // tenant/source contract. Preserve committed input, never reload it on a
      // time tick, and never mutate the prior environment or its plugin state.
      const nextLanguage = require('../language')();
      nextLanguage.set(next.settings.language);
      const nextContext = createContext({ env: next, language: nextLanguage, dbstats, moment: dates.moment, storage (logical) {
        if (!active) throw new Error('Evaluator has no committed projection');
        return active[logical];
      } });
      const nextViews = viewsFactory(next, nextContext);
      env = next; language = nextLanguage; ctx = nextContext; views = nextViews;
      kept = null;
    },
    // Idle eviction: release the retained input and the plugin context. The
    // next cycle must be an acquisition (the runtime promotes it); a time-only
    // cycle refuses, as before any acquisition.
    evict () {
      binding();
      if (running) throw new Error('Evaluator eviction refused while a cycle runs');
      retained = null; kept = null; ctx = null; views = null;
    },
    signature: () => scope.withTenant(tenant, () => replay.signature()),
    evaluate: ({ at = Date.now() } = {}) => compute(true, at),
    evaluateTime: ({ at = Date.now() } = {}) => compute(false, at),
    last () { binding(); return kept; },
    close () { closed = true; retained = null; active = null; }
  });
};
module.exports.createContext = createContext;
module.exports.domains = DOMAIN_NAMES;
