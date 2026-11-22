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
// The write clock pair (decision write-clock-complete).
const { sameSignature } = require('../storage/postgres-durable-replay');
const DOMAIN_NAMES = Object.freeze(['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity']);
// Tenant storage statistics feed only the dbsize pill (logical JSONB bytes over
// the tenant's whole history, postgres-tenant-stats.js). They are read only when
// that plugin is enabled, and at most once per STATS_TTL_MS per component: the
// size moves by a few hundred bytes per write against a limit in MiB.
const STATS_TTL_MS = 3600000;
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
  language, dbstats, maxRows, maxBytes, includeFrame = false, statsTtlMs = STATS_TTL_MS } = {}) {
  if (typeof includeFrame !== 'boolean') throw new TypeError('Explicit evaluator frame selection required');
  if (!Number.isSafeInteger(statsTtlMs) || statsTtlMs < 0) throw new TypeError('Bounded evaluator statistics interval required');
  if ((typeof tenant !== 'string' || !UUID.test(tenant)) || typeof replay?.reconcile !== 'function' ||
      typeof connection?.query !== 'function' || !environment.isSafe(env) ||
      typeof language?.translate !== 'function' || typeof dbstats !== 'function' ||
      !Number.isSafeInteger(maxRows) || maxRows < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError('Evaluator requires explicit tenant replay, safe environment, statistics and projection bounds');
  }
  let active = null, running = false, closed = false, kept = null, retained = null, revision = 0;
  let ctx = null, views = null, policyChanged = false, statsCache = null;
  // Resident window (decision stateful-evaluator-resident-window; a replay
  // with residentWindow, lib/storage/postgres-durable-replay.js): the window
  // rows as last read, handed back to the next read so it reads only what
  // the writers marked. Kept with the retained input and dropped with it: a
  // settings change, eviction and close all return to a full read.
  let resident = null;
  // Not enabled: the empty statistics the shipping loader holds before its read.
  const statsWanted = () => typeof env.settings?.isEnabled !== 'function' || env.settings.isEnabled('dbsize') === true;
  async function statistics (at) {
    if (!statsWanted()) return { value: {}, fresh: false };
    if (statsCache && at >= statsCache.at && at - statsCache.at < statsTtlMs) return { value: statsCache.value, fresh: false };
    return { value: await dbstats(), fresh: true };
  }
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
        let input, same = false, freshStats, nextResident;
        const refresh = acquire || replay.level === true && retained && (policyChanged || retained?.input.expiresAt != null && at >= retained.input.expiresAt);
        if (refresh) {
          const recovered = replay.level === true
            ? await replay.window({ maxRows, maxBytes, policy: require('../storage/clinical-working-set-policy').create(env, at),
              ...(replay.residentWindow === true ? { resident: policyChanged ? null : resident } : {}) })
            : await replay.reconcile({ maxRows, maxBytes, signature: true }); // input COMMIT, not evaluated output
          if (replay.residentWindow === true) nextResident = recovered?.resident ?? null;
          binding();
          if (!recovered || !Array.isArray(recovered.rows) || recovered.rows.length > maxRows ||
              !Number.isSafeInteger(recovered.checkpoint) || recovered.checkpoint < 0) {
            throw new Error('Evaluator recovered projection is invalid or over bound');
          }
          // Candidate E: the same change signature as the retained input's
          // (same checkpoint and progress) means the same rows; keep the
          // retained rows and their prepared sources instead of encoding,
          // copying and freezing them again. Statistics are always new.
          // A level window has no stream floor: a hard delete moves no clock
          // stamp, so the rows are always taken from the snapshot just read.
          same = replay.level !== true && !!retained && sameSignature(retained.input.signature, recovered.signature) &&
            retained.input.checkpoint === recovered.checkpoint && retained.input.progress === recovered.progress;
          // A level window's rows are bounded below, within the whole input's
          // text, which contains every row's text and more.
          if (!same && replay.level !== true && Buffer.byteLength(JSON.stringify(recovered.rows)) > maxBytes) throw new Error('Evaluator projection byte bound exceeded');
          const rows = same ? retained.input.rows : recovered.rows.map(row => {
            if (!DOMAIN_NAMES.includes(row?.domain)) throw new Error('Evaluator recovered domain is unsupported');
            // The per-tenant insertion ordinal: the view reads' tie-break (null when the table has none).
            const ordinal = row.ordinal === undefined ? null : row.ordinal;
            if (ordinal !== null && (!Number.isSafeInteger(ordinal) || ordinal <= 0)) throw new Error('Evaluator recovered ordinal is invalid');
            return { domain: row.domain, ...encodeDocument(row.document), ordinal };
          });
          // Retain immutable input and acquisition statistics only after a
          // successful clinical computation; a time tick never reloads either.
          let stats = recovered.stats ?? (!acquire && retained ? retained.input.stats : undefined);
          if (stats === undefined) { const read = await statistics(at); stats = read.value; if (read.fresh) freshStats = stats; }
          if (!stats || typeof stats !== 'object' || Array.isArray(stats)) throw new Error('Evaluator statistics unavailable');
          const signature = recovered.signature && typeof recovered.signature === 'object' ? { ...recovered.signature } : null;
          input = { checkpoint: recovered.checkpoint, progress: recovered.progress, rows, stats, signature,
            ...(recovered.policy ? { expiresAt: recovered.expiresAt } : {}),
            ...(recovered.generation !== undefined ? { generation: recovered.generation } : {}) };
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
        if (refresh && same) {
          // JSON.stringify(input) is the rest of the input's text with the
          // rows' text in place of "[]": its byte length, without the rows.
          const rest = JSON.stringify({ ...input, rows: [] });
          if (Buffer.byteLength(rest) - 2 + retained.rowBytes > maxBytes) throw new Error('Evaluator retained input byte bound exceeded');
          next = Object.freeze({ input: deepFreeze({ ...JSON.parse(rest), rows: retained.input.rows }),
            prepared: retained.prepared, rowBytes: retained.rowBytes });
        } else if (refresh && replay.level === true) {
          // A level window: every row was parsed once from PostgreSQL's text
          // (postgres-durable-replay levelWindow), so the rows are JSON values
          // already. One text bounds the whole input, as below; the rows are
          // then frozen into each domain's in-process source in jsonb key
          // order (prepareEncoded), without the decode, encode and JSON round
          // trips that give the same rows. Only the small rest of the input
          // takes the JSON round trip.
          const text = JSON.stringify(input);
          if (Buffer.byteLength(text) > maxBytes) throw new Error('Evaluator retained input byte bound exceeded');
          const groups = Object.fromEntries(DOMAIN_NAMES.map(name => [name, []]));
          for (const row of input.rows) groups[row.domain].push(row);
          const previous = !policyChanged && input.generation != null && input.generation === retained?.input.generation
            ? retained.prepared : null;
          const prepared = Object.freeze(Object.fromEntries(DOMAIN_NAMES.map(logical =>
            [logical, projectionRead.prepareEncoded({ rows: groups[logical], maxRows, maxBytes, previous: previous?.[logical] })])));
          const rest = JSON.parse(JSON.stringify({ ...input, rows: [] }));
          // rows: the frozen source rows, a new array each acquisition (the
          // views' keep token, views/index.js keepOrLoad).
          next = Object.freeze({ input: deepFreeze({ ...rest, rows: Object.freeze(DOMAIN_NAMES.flatMap(logical => prepared[logical].memory)) }),
            prepared, rowBytes: null });
        } else if (refresh) {
          const text = JSON.stringify(input);
          if (Buffer.byteLength(text) > maxBytes) throw new Error('Evaluator retained input byte bound exceeded');
          const frozen = deepFreeze(JSON.parse(text));
          const groups = Object.fromEntries(DOMAIN_NAMES.map(name => [name, []]));
          const ordinals = Object.fromEntries(DOMAIN_NAMES.map(name => [name, []]));
          for (const row of frozen.rows) { groups[row.domain].push(decodeDocument(row)); ordinals[row.domain].push(row.ordinal); }
          next = Object.freeze({ input: frozen, rowBytes: Buffer.byteLength(JSON.stringify(frozen.rows)),
            prepared: Object.freeze(Object.fromEntries(DOMAIN_NAMES.map(logical =>
              [logical, projectionRead.prepare({ documents: groups[logical], ordinals: ordinals[logical], maxRows, maxBytes, memory: true })]))) });
        }
        input = next.input;
        // Candidate A: the views' reads are answered in process from the
        // prepared rows (projection-memory-read.js: postgres-filter's rules,
        // in the total order of decision view-reads-total-order), not sent
        // through PostgreSQL.
        const documentSources = replay.level === true && input.generation != null ? new WeakMap() : null;
        active = Object.fromEntries(DOMAIN_NAMES.map(logical => [logical, projectionRead({
          tenant, connection, logical, prepared: next.prepared[logical], maxRows, maxBytes, env, memory: true, totalOrder: true, documentSources
        })]));
        if (!views) context();
        // keep: the retained rows; while they are the same array (time-only
        // cycles, and acquisitions with an unchanged signature) the view may
        // reuse its working set (views/index.js keepOrLoad; the statistics are
        // among the answers it compares).
        const set = await new Promise((resolve, reject) => views.materialise('properties', {
          now: at, dbstats: input.stats, keep: next.input.rows,
          // A level snapshot carries its restore generation. Each views instance
          // belongs to one tenant and is replaced on settings changes or eviction.
          historyGeneration: replay.level === true ? input.generation : undefined, documentSources
        },
          (error, materialized) => error ? reject(error) : resolve(materialized)));
        const result = views.evaluateCycle(set);
        binding(); // a close during reads cannot publish late state
        retained = next; policyChanged = false;
        if (nextResident !== undefined) resident = nextResident;
        if (freshStats !== undefined) statsCache = { value: freshStats, at };
        // Not content (evaluator-runtime CONTENT): when the output can next
        // change with time alone, and the input's change signature.
        let due = nextDue({ ddata: set.ddata, env, result, at });
        if (input.expiresAt != null && (due.dueAt === null || input.expiresAt < due.dueAt)) {
          due = Object.freeze({ ...due, dueAt: input.expiresAt, reason: 'clinical-window-expiry' });
        }
        const frameText = includeFrame ? JSON.stringify({ ...set.ddata.dataWithRecentStatuses(), lastUpdated: at, delta: false }) : null;
        if (frameText !== null && Buffer.byteLength(frameText) > maxBytes) throw new Error('Evaluator browser frame byte bound exceeded');
        const frame = frameText === null ? null : JSON.parse(frameText);
        kept = Object.freeze({ tenant, checkpoint: input.checkpoint, progress: input.progress,
          ...(input.generation !== undefined ? { generation: input.generation } : {}),
          // The completed output needs the clinical frame, not a second raw
          // input projection. Legacy snapshot consumers retain their row contract.
          ...(includeFrame ? { frame, ...(replay.level === true ? {} : { encodedRows: input.rows }) } : {}),
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
      if (replay.level === true) policyChanged = true;
      env = next; language = nextLanguage; ctx = nextContext; views = nextViews;
      kept = null; statsCache = null; resident = null;
    },
    // Idle eviction: release the retained input and the plugin context. The
    // next cycle must be an acquisition (the runtime promotes it); a time-only
    // cycle refuses, as before any acquisition.
    evict () {
      binding();
      if (running) throw new Error('Evaluator eviction refused while a cycle runs');
      retained = null; kept = null; ctx = null; views = null; statsCache = null; resident = null; dates.clear();
    },
    signature: () => scope.withTenant(tenant, () => replay.signature()),
    evaluate: ({ at = Date.now() } = {}) => compute(true, at),
    evaluateTime: ({ at = Date.now() } = {}) => compute(false, at),
    last () { binding(); return kept; },
    close () { closed = true; retained = null; active = null; kept = null; ctx = null; views = null; resident = null; dates.clear(); }
  });
};
module.exports.createContext = createContext;
module.exports.domains = DOMAIN_NAMES;
module.exports.STATS_TTL_MS = STATS_TTL_MS;
