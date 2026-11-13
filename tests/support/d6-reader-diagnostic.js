'use strict';
// Test-only metadata observer. It adds no SQL, retries or RSS scoping policy.
const HEALTH = ['live','ready','degraded','refusal','generation','lastSuccess','batches','messages','hints','refusals'];
const code = value => typeof value === 'string' && /^(?:FEED_[A-Z_]{1,64}|[A-Z0-9]{5})$/.test(value) ? value : 'UNCLASSIFIED';
function create (sampleRss = () => process.memoryUsage().rss) {
  let rssAtGuard = null, limit = null, statementTimeoutMs = null, storeStage = null;
  return Object.freeze({
    options (options) {
      if (options.rss !== undefined) throw new Error('D6_DIAGNOSTIC_RSS_ALREADY_SELECTED');
      limit = options.config.rssRefuseBytes; statementTimeoutMs = options.config.statementTimeoutMs;
      const original = options.store, store = { ...original };
      for (const stage of ['peek','notify','advance','close']) {
        if (typeof original[stage] !== 'function') continue;
        store[stage] = async (...args) => {
          storeStage = { stage, outcome: 'DISPATCH', code: null };
          try { const result = await Reflect.apply(original[stage], original, args); storeStage = { stage, outcome: 'RETURNED', code: null }; return result; }
          catch (error) { storeStage = { stage, outcome: 'REFUSED', code: code(error?.code) }; throw error; }
        };
      }
      return { ...options, store: Object.freeze(store), rss: () => { storeStage = null; rssAtGuard = null; rssAtGuard = sampleRss(); return rssAtGuard; } };
    },
    detail (health) {
      const selected = {};
      for (const key of HEALTH) {
        const value = health[key];
        selected[key] = key === 'refusal' ? value === null ? null : code(value)
          : key === 'generation' ? typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value) ? value : 'UNCLASSIFIED'
            : typeof value === 'boolean' || value === null || typeof value === 'number' && Number.isFinite(value) ? value : 'UNCLASSIFIED';
      }
      return 'D6_RESTORED_READER_HEALTH ' + JSON.stringify({ health: selected, rssAtGuard, rssRefuseBytes: limit, statementTimeoutMs, storeStage });
    }
  });
}
module.exports = { create };
