'use strict';

const c = require('./contract');
const state = require('./producer-state');
const scope = require('../storage/tenant-scope');

module.exports = function producer ({store, reader, current, currentConfig, isCurrent, consumer, now, maxRows, maxBytes, maxPayloadBytes}) {
  if (typeof store?.consume !== 'function' || typeof reader?.read !== 'function' ||
      [current, currentConfig, isCurrent, now].some(fn => typeof fn !== 'function')) throw new TypeError('Explicit durable producer capabilities required');
  for (const [name,value] of Object.entries({maxRows,maxBytes,maxPayloadBytes})) c.integer(value,name);
  let closed = false;
  function check () { if (closed) throw new Error('NOTIFICATION_PRODUCER_CLOSED'); }
  async function select (tenant) {
    check();
    return scope.withTenant(tenant, async () => {
      const config = await currentConfig(tenant);
      if (!config || config.tenant !== tenant || typeof config.identity !== 'string' || !await isCurrent(tenant, config.identity)) throw new Error('NOTIFICATION_PRODUCER_CONFIG_UNAVAILABLE');
      check();
      const observed = current(tenant);
      const source = observed?.identity === config.identity ? observed : {identity:config.identity,eligible:false};
      async function unchanged () {
        const fresh = await currentConfig(tenant);
        if (!fresh || fresh.identity !== config.identity || !await isCurrent(tenant, config.identity)) return false;
        const live = current(tenant);
        return (!live && !observed) || (!!live && !!observed && live.identity === observed.identity &&
          live.runtimeId === observed.runtimeId && live.outputRevision === observed.outputRevision && live.inputCheckpoint === observed.inputCheckpoint &&
          live.result === observed.result && live.eligible === observed.eligible);
      }
      const result = await store.consume({tenant, consumer, async transform (previous, revision) {
        const at = c.instant(now());
        const acks = await reader.read({tenant, at}); check();
        if (!await unchanged()) throw new Error('NOTIFICATION_PRODUCER_STALE');
        const prior = previous?.producer;
        const reduced = state.reduce({previous: prior, cycle: source, acks, at, revision, reset: source.eligible === true && !!prior && prior.clinicalIdentity !== source.identity, maxRows, maxBytes, maxPayloadBytes});
        check();
        const effects = reduced.state.effects;
        // Failed clinical acquisition keeps private state but may only hand off
        // committed control clears, never previous normal/alarm effects.
        const eligible = effects.filter(effect => source.eligible || effect.payload.clear);
        return {configIdentity: source.identity, producer: reduced.state, retireObsolete: source.eligible || effects.some(effect => effect.payload.clear),
          intents: eligible.map(effect => ({normalPolicy: 'realtime-cycle', origin: effect.origin,
            key: 'realtime-cycle:' + c.digest(source.identity) + ':' + effect.origin,
            configIdentity: source.identity, payload: effect.payload, at}))};
      }});
      check();
      if (!await unchanged()) throw new Error('NOTIFICATION_PRODUCER_STALE');
      const effects = result.producer.effects.filter(effect => source.eligible || effect.payload.clear);
      return {tenant, identity: source.identity, runtimeId: 'durable-producer-' + consumer,
        outputRevision: result.revision, inputCheckpoint: source.inputCheckpoint || 0, eligible: true,
        intentOrigins: effects.map(effect => effect.origin),
        result: {tenant, now: now(), requested: [], emitted: effects.map(effect => effect.payload)}};
    });
  }
  return Object.freeze({select, close () { closed = true; }});
};
