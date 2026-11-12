'use strict';
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const fail = () => { throw Object.assign(new Error('FEED_CONFIG_REFUSED'), { code: 'FEED_CONFIG_REFUSED' }); };
const exact = (v, keys, optional = []) => v && typeof v === 'object' && !Array.isArray(v) && keys.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => [...keys, ...optional].includes(k));
const name = value => typeof value === 'string' && NAME.test(value) && !['public', 'information_schema'].includes(value) && !value.startsWith('pg_');
const integer = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
function parse (value, source, { reader = false } = {}) {
  const required = reader ? ['connectionEnv', 'namespace', 'clockNamespace', 'activityNamespace', 'slot', 'publication', 'channel', 'owner'] : ['connectionEnv', 'channel'];
  const optional = reader ? ['pollMs', 'heartbeatMs', 'targetChanges', 'maxMessages', 'maxBytes', 'statementTimeoutMs', 'rssRefuseBytes'] : ['pageSize', 'degradedPages', 'intervalMs', 'heartbeatTimeoutMs'];
  if (!exact(value, required, optional) || !/^[A-Z][A-Z0-9_]{0,127}$/.test(value.connectionEnv || '') || !name(value.channel) ||
      reader && ['namespace','clockNamespace','activityNamespace','slot','publication','owner'].some(key => !name(value[key])) ||
      reader && new Set([value.namespace,value.clockNamespace,value.activityNamespace]).size !== 3) fail();
  const defaults = reader ? { pollMs: 50, heartbeatMs: 1000, targetChanges: 128, maxMessages: 10000, maxBytes: 1048576, statementTimeoutMs: 2000, rssRefuseBytes: 268435456 }
    : { pageSize: 64, degradedPages: 4, intervalMs: 1000, heartbeatTimeoutMs: 5000 };
  const selected = { ...defaults, ...value };
  const limits = reader ? { pollMs: [10,60000], heartbeatMs: [100,60000], targetChanges: [1,10000], maxMessages: [4,10000], maxBytes: [1024,1048576], statementTimeoutMs: [100,10000], rssRefuseBytes: [33554432,1073741824] }
    : { pageSize: [1,1024], degradedPages: [1,16], intervalMs: [10,60000], heartbeatTimeoutMs: [100,300000] };
  if (Object.entries(limits).some(([key,[min,max]]) => !integer(selected[key],min,max))) fail();
  if (source !== undefined) {
    if (typeof source[value.connectionEnv] !== 'string') fail();
    require('../server/serve/evaluator-consumer-config').endpoint(source[value.connectionEnv]);
    selected.connectionString = source[value.connectionEnv];
  }
  return Object.freeze(selected);
}
function load (source) {
  const file = source.MULTITENANT_FEED_CONFIG;
  const parsed = require('../server/serve/config-file').readJson(file, { source, label: 'MULTITENANT_FEED_CONFIG' });
  return parse(parsed, source, { reader: true });
}
module.exports = { parse, load, name, exact };
