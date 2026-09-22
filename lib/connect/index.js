'use strict';

const Manager = require('./manager');

module.exports = async function connect(env, ctx) {
  const browser = require('./browser/client')();
  const collection = ctx.store.collection((env.authentication_collections_prefix || 'auth_') + 'connect');
  let legacySuppressed = false, nativeSelected = false;
  const manager = new Manager({
    store: require('./storage')(collection, env.enclave),
    auth: require('./sources/carelink/auth').createAuth(), client: require('./sources/carelink/client')(),
    browser, output: require('./output')(ctx),
    conflicts: () => {
      if (nativeSelected) return [];
      const sources = [];
      if (env.extendedSettings.connect?.source) sources.push(env.extendedSettings.connect.source);
      if (ctx.bridge) sources.push('legacy Dexcom bridge');
      if (ctx.mmconnect) sources.push('legacy MiniMed Connect');
      return [...new Set(sources)];
    },
    stopLegacy: async () => {
      legacySuppressed = true;
      nativeSelected = true;
      await ctx.nightscoutConnect?.stop();
      ctx.bridge?.stop?.(); ctx.mmconnect?.stop?.();
    }
  });
  await manager.init();
  nativeSelected = !!manager.connection || manager.error === 'encryption_key_changed';
  legacySuppressed = nativeSelected || !!manager.error;
  manager.ownsSource = () => legacySuppressed;
  // Guard in-flight legacy callbacks too: stopping a timer alone is not enough.
  manager.legacyAdapter = original => new Proxy(original, {
    get(target, property) {
      if (property !== 'create') return target[property];
      return (docs, callback) => {
        if (!legacySuppressed) return target.create(docs, callback);
        if (callback) callback(null, []);
        return Promise.resolve([]);
      };
    }
  });
  for (const event of ['teardown', 'tearDown']) ctx.bus.once(event, () => { void manager.close(); });
  return manager;
};
